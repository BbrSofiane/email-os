use super::*;
use crate::gmail::types::GmailReadProvider;
use crate::storage_log::{storage_err, storage_fault};

impl GmailReadProvider for LiveGmailProvider {
    fn fetch_attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_id: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<u8>, MailError> {
        use base64::Engine;
        if !crate::attachments::valid_id(message_id)
            || !crate::attachments::valid_attachment_id(attachment_id)
        {
            return Err(crate::attachments::invalid("attachmentId"));
        }
        // Refresh if needed, then take one coherent account+token snapshot.
        // Never combine a token from one credential revision with another
        // revision's cached account identity.
        self.access_token(cancel)?;
        let (bundle, _, _) = self.credential_snapshot()?;
        let bundle = bundle.ok_or(MailError::AuthRequired)?;
        if bundle.account_id.as_deref().or(bundle.email.as_deref()) != Some(account_id)
            || bundle.access_token.is_empty()
            || bundle.expires_at_epoch_ms - EXPIRY_SKEW_MS <= now_ms()
        {
            return Err(MailError::AuthRequired);
        }
        let token = bundle.access_token;
        let path = format!(
            "/gmail/v1/users/me/messages/{}/attachments/{}",
            url_encode(message_id),
            url_encode(attachment_id)
        );
        let body = self
            .api_get(&path, "", &token, cancel)?
            .ok_or(MailError::NotFound)?;
        crate::attachments::check_cancel(cancel)?;
        let json: Value = parse_json(&body)?;
        let data = json["data"]
            .as_str()
            .ok_or(MailError::InvalidProviderResponse)?;
        if data.len() > crate::attachments::MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 {
            return Err(crate::attachments::invalid("attachmentSize"));
        }
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(data.trim_end_matches('='))
            .map_err(|_| MailError::InvalidProviderResponse)?;
        if json["size"].as_u64() != Some(bytes.len() as u64) {
            return Err(MailError::InvalidProviderResponse);
        }
        crate::attachments::check_cancel(cancel)?;
        Ok(bytes)
    }

    fn mutation_access(&self) -> Result<bool, MailError> {
        let Some(bundle) = self.secrets.load()? else {
            return Ok(false);
        };
        let bound = bundle
            .account_id
            .as_ref()
            .or(bundle.email.as_ref())
            .is_some_and(|account| !account.is_empty());
        Ok(bundle.gmail_modify_granted
            && bound
            && (!bundle.access_token.is_empty() || bundle.refresh_token.is_some()))
    }

    fn enable_mutations(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        if !self.is_configured() {
            return Err(MailError::NotConfigured);
        }
        let (previous, publication_revision, previous_non_refresh_revision) =
            self.credential_snapshot()?;
        let previous = previous.ok_or(MailError::AuthRequired)?;
        let bound_account = previous
            .account_id
            .as_ref()
            .or(previous.email.as_ref())
            .filter(|account| !account.is_empty())
            .ok_or(MailError::AuthRequired)?
            .clone();
        if previous.access_token.is_empty() && previous.refresh_token.is_none() {
            return Err(MailError::AuthRequired);
        }
        let grant = auth::authorize(
            &self.config,
            &self.endpoints,
            &self.opener,
            auth::GMAIL_MODIFY_SCOPE,
            cancel,
            auth::AUTH_TIMEOUT,
        )?;
        let tokens =
            auth::exchange_code(&self.config, &self.endpoints, &self.http, &grant, cancel)?;
        if !tokens.scope.as_deref().is_some_and(scope_grants_modify) {
            return Err(MailError::PermissionRequired);
        }
        let profile = self.fetch_profile(&tokens.access_token, cancel)?;
        if profile.account_id != bound_account {
            return Err(MailError::AuthFailed);
        }
        // Cancellation remains effective through the final pre-commit point.
        // Once this store succeeds, a late cancel is merely completion.
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let mut publication = self.credential_publication.lock().map_err(storage_err())?;
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let current = self.secrets.load()?;
        if publication.revision == publication_revision && current.as_ref() == Some(&previous) {
            let bundle = TokenBundle {
                access_token: tokens.access_token,
                expires_at_epoch_ms: tokens.expires_at_epoch_ms,
                refresh_token: tokens.refresh_token.or(previous.refresh_token),
                account_id: Some(profile.account_id.clone()),
                email: Some(profile.email_address.clone()),
                gmail_modify_granted: true,
            };
            self.publish_bundle_locked(
                &mut publication,
                &bundle,
                CredentialPublicationKind::AccountChange,
            )?;
            return Ok(profile);
        }

        // Rebase across refreshes only. A concurrent connect, upgrade, or
        // disconnect invalidates the interactive result rather than allowing
        // an older OAuth exchange to replace that newer publication.
        let current = current.ok_or(MailError::AuthRequired)?;
        if bundle_account_id(&current) != Some(profile.account_id.as_str()) {
            return Err(MailError::AuthFailed);
        }
        if publication.last_non_refresh_revision != previous_non_refresh_revision {
            if current.gmail_modify_granted {
                return Ok(profile);
            }
            if previous.gmail_modify_granted {
                return Err(MailError::PermissionRequired);
            }
            return Err(MailError::Busy);
        }
        if current.gmail_modify_granted {
            return Ok(profile);
        }
        if previous.gmail_modify_granted {
            return Err(MailError::PermissionRequired);
        }
        let bundle = TokenBundle {
            access_token: tokens.access_token,
            expires_at_epoch_ms: tokens.expires_at_epoch_ms,
            refresh_token: tokens.refresh_token.or(current.refresh_token),
            account_id: Some(profile.account_id.clone()),
            email: Some(profile.email_address.clone()),
            gmail_modify_granted: true,
        };
        self.publish_bundle_locked(
            &mut publication,
            &bundle,
            CredentialPublicationKind::AccountChange,
        )?;
        Ok(profile)
    }

    fn apply_archive(
        &self,
        message_ids: &[String],
        archived: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply_label_setter(message_ids, !archived, "INBOX", cancel)
    }

    fn apply_star(
        &self,
        message_ids: &[String],
        starred: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply_label_setter(message_ids, starred, "STARRED", cancel)
    }

    fn apply_read(
        &self,
        message_ids: &[String],
        read: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply_label_setter(message_ids, !read, "UNREAD", cancel)
    }

    fn is_configured(&self) -> bool {
        !self.config.client_id.trim().is_empty()
    }

    fn has_credentials(&self) -> Result<bool, MailError> {
        Ok(self.secrets.load()?.is_some())
    }

    fn connect(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        if !self.is_configured() {
            return Err(MailError::NotConfigured);
        }
        let (previous, publication_revision, previous_non_refresh_revision) =
            self.credential_snapshot()?;
        let prior_modify_grant = previous
            .as_ref()
            .is_some_and(|bundle| bundle.gmail_modify_granted);
        let requested_scope = if prior_modify_grant {
            auth::GMAIL_MODIFY_SCOPE
        } else {
            auth::GMAIL_READONLY_SCOPE
        };
        let grant = auth::authorize(
            &self.config,
            &self.endpoints,
            &self.opener,
            requested_scope,
            cancel,
            auth::AUTH_TIMEOUT,
        )?;
        let tokens =
            auth::exchange_code(&self.config, &self.endpoints, &self.http, &grant, cancel)?;
        let returned_scope = tokens.scope.clone();
        let returned_refresh_token = tokens.refresh_token.clone();
        // Preserve a stored refresh token when the grant response omits it.
        let bundle = TokenBundle {
            access_token: tokens.access_token,
            expires_at_epoch_ms: tokens.expires_at_epoch_ms,
            refresh_token: tokens
                .refresh_token
                .or_else(|| previous.as_ref().and_then(|p| p.refresh_token.clone())),
            account_id: previous.as_ref().and_then(|p| p.account_id.clone()),
            email: previous.as_ref().and_then(|p| p.email.clone()),
            // Requested scope alone is never evidence of a grant. Existing
            // explicit access survives an omitted scope response; a present
            // response is authoritative and can revoke it.
            gmail_modify_granted: prior_modify_grant
                && returned_scope
                    .as_deref()
                    .map(scope_grants_modify)
                    .unwrap_or(true),
        };
        let profile = self.fetch_profile(&bundle.access_token, cancel)?;
        // Account binding: credentials are single-profile. Re-authenticating
        // as a different account must fail closed and leave the previous
        // bundle untouched until an explicit disconnect clears it.
        if let Some(previous) = &previous {
            let bound_account = previous
                .account_id
                .as_ref()
                .or(previous.email.as_ref())
                .filter(|account| !account.is_empty());
            if let Some(bound_account) = bound_account {
                if *bound_account != profile.account_id {
                    return Err(MailError::AuthFailed);
                }
            }
        }
        let bundle = TokenBundle {
            account_id: Some(profile.account_id.clone()),
            email: Some(profile.email_address.clone()),
            ..bundle
        };
        let mut publication = self.credential_publication.lock().map_err(storage_err())?;
        let current = self.secrets.load()?;
        if publication.revision == publication_revision && current == previous {
            self.publish_bundle_locked(
                &mut publication,
                &bundle,
                CredentialPublicationKind::AccountChange,
            )?;
            return Ok(profile);
        }

        // A refreshed token may replace the original snapshot while interactive
        // OAuth is open. Rebase only over refresh-only publications, preserving
        // the current fallback credential and the authoritative returned scope.
        let current = current.ok_or(MailError::AuthRequired)?;
        if bundle_account_id(&current) != Some(profile.account_id.as_str()) {
            return Err(MailError::AuthFailed);
        }
        if publication.last_non_refresh_revision != previous_non_refresh_revision {
            return Err(MailError::Busy);
        }
        let rebased = TokenBundle {
            access_token: bundle.access_token,
            expires_at_epoch_ms: bundle.expires_at_epoch_ms,
            refresh_token: returned_refresh_token.or(current.refresh_token),
            account_id: Some(profile.account_id.clone()),
            email: Some(profile.email_address.clone()),
            // An omitted scope cannot restore a grant revoked by an
            // intervening refresh; a present scope remains authoritative.
            gmail_modify_granted: prior_modify_grant
                && returned_scope
                    .as_deref()
                    .map(scope_grants_modify)
                    .unwrap_or(current.gmail_modify_granted),
        };
        self.publish_bundle_locked(
            &mut publication,
            &rebased,
            CredentialPublicationKind::AccountChange,
        )?;
        Ok(profile)
    }

    fn disconnect(&self) -> Result<(), MailError> {
        let mut publication = self.credential_publication.lock().map_err(storage_err())?;
        let next_revision = publication
            .revision
            .checked_add(1)
            .ok_or_else(|| storage_fault("missing_persisted_row"))?;
        self.secrets.clear()?;
        publication.revision = next_revision;
        publication.last_non_refresh_revision = next_revision;
        Ok(())
    }

    fn profile(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        let token = self.access_token(cancel)?;
        self.fetch_profile(&token, cancel)
    }

    fn list_destinations_for_account(
        &self,
        expected_account_id: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<crate::gmail::browsing::ProviderDestination>, MailError> {
        use crate::gmail::browsing::ProviderDestination;
        let token = self.destination_admission_token(expected_account_id, cancel)?;
        let body = self
            .api_get("/gmail/v1/users/me/labels", "", &token, cancel)?
            .ok_or(MailError::InvalidProviderResponse)?;
        let json: Value = parse_json(&body)?;
        let mut labels = vec![];
        for (id, name) in [
            ("SENT", "Sent"),
            ("DRAFT", "Provider Drafts"),
            ("ALL_MAIL", "All Mail"),
            ("SPAM", "Spam"),
            ("TRASH", "Trash"),
        ] {
            labels.push(ProviderDestination {
                id: id.into(),
                name: name.into(),
                user_label: false,
            });
        }
        for label in optional_array(&json, "labels")?.ok_or(MailError::InvalidProviderResponse)? {
            let kind = str_field(label, "type")?;
            if kind == "user" {
                labels.push(ProviderDestination {
                    id: str_field(label, "id")?,
                    name: str_field(label, "name")?,
                    user_label: true,
                });
            } else if kind != "system" {
                return Err(MailError::InvalidProviderResponse);
            }
        }
        crate::gmail::browsing::validate_catalog(&labels)?;
        self.verify_destination_account(expected_account_id, cancel)?;
        Ok(labels)
    }

    fn list_destination_for_account(
        &self,
        expected_account_id: &str,
        id: &str,
        cursor: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        if !crate::gmail::browsing::valid_id(id) {
            return Err(crate::gmail::browsing::invalid());
        }
        let token = self.destination_admission_token(expected_account_id, cancel)?;
        let mut query = if id == "ALL_MAIL" {
            "maxResults=25&q=-in%3Aspam%20-in%3Atrash".to_owned()
        } else {
            format!(
                "maxResults=25&includeSpamTrash=true&labelIds={}",
                url_encode(id)
            )
        };
        if let Some(cursor) = cursor {
            query.push_str(&format!("&pageToken={}", url_encode(cursor)));
        }
        let body = self
            .api_get("/gmail/v1/users/me/threads", &query, &token, cancel)?
            .ok_or(MailError::InvalidProviderResponse)?;
        let json: Value = parse_json(&body)?;
        let mut ids = vec![];
        if let Some(threads) = optional_array(&json, "threads")? {
            for thread in threads {
                ids.push(str_field(thread, "id")?);
            }
        }
        // An empty page is still a page: the account is re-verified even when
        // there is no thread data whose stamps could expose a switch.
        self.verify_destination_account(expected_account_id, cancel)?;
        Ok(InboxPage {
            thread_ids: ids,
            next_page_token: optional_string(&json, "nextPageToken")?,
        })
    }

    fn get_thread_for_account(
        &self,
        expected_account_id: &str,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        let token = self.destination_admission_token(expected_account_id, cancel)?;
        let path = format!("/gmail/v1/users/me/threads/{}", url_encode(thread_id));
        let thread = match self.api_get(&path, "format=full", &token, cancel)? {
            // Deleted threads are `None`, not an error.
            None => None,
            Some(body) => {
                // Content is stamped with the admitted identity: the token
                // dispatches only for the expected account, so the parsed
                // thread can only ever carry that identity.
                Some(parse_thread(expected_account_id, thread_id, &body)?)
            }
        };
        self.verify_destination_account(expected_account_id, cancel)?;
        Ok(thread)
    }

    fn list_inbox(
        &self,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        let token = self.access_token(cancel)?;
        let mut query = format!("labelIds=INBOX&maxResults={DISCOVERY_PAGE_RESULTS}");
        if let Some(page_token) = page_token {
            query.push_str(&format!("&pageToken={}", url_encode(page_token)));
        }
        let body = self
            .api_get("/gmail/v1/users/me/threads", &query, &token, cancel)?
            .ok_or(MailError::InvalidProviderResponse)?;
        let json: Value = parse_json(&body)?;
        let mut thread_ids = Vec::new();
        if let Some(threads) = optional_array(&json, "threads")? {
            for thread in threads {
                thread_ids.push(str_field(thread, "id")?);
            }
        }
        let next_page_token = optional_string(&json, "nextPageToken")?;
        Ok(InboxPage {
            thread_ids,
            next_page_token,
        })
    }

    fn search_threads(
        &self,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        let token = self.access_token(cancel)?;
        // Enumerate bounded candidates, then evaluate our AST locally. Never give
        // Gmail's stemming/operator grammar different semantics from cached mode.
        let mut query = "maxResults=20&includeSpamTrash=false".to_string();
        if let Some(page) = page_token {
            query.push_str(&format!("&pageToken={}", url_encode(page)));
        }
        let body = self
            .api_get("/gmail/v1/users/me/threads", &query, &token, cancel)?
            .ok_or(MailError::InvalidProviderResponse)?;
        let json: Value = parse_json(&body)?;
        let mut thread_ids = Vec::new();
        if let Some(threads) = optional_array(&json, "threads")? {
            if threads.len() > 20 {
                return Err(MailError::InvalidProviderResponse);
            }
            for thread in threads {
                thread_ids.push(str_field(thread, "id")?);
            }
        }
        Ok(InboxPage {
            thread_ids,
            next_page_token: optional_string(&json, "nextPageToken")?,
        })
    }

    fn get_thread(
        &self,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        // Token and stamp identity come from the same coherent publication so
        // a racing publication can never label one account's content with
        // another account's identity.
        let (token, account_id) = self.access_token_with_account(cancel)?;
        let account_id = account_id.ok_or(MailError::AuthRequired)?;
        let path = format!("/gmail/v1/users/me/threads/{}", url_encode(thread_id));
        match self.api_get(&path, "format=full", &token, cancel)? {
            // Deleted threads are `None`, not an error.
            None => Ok(None),
            Some(body) => parse_thread(&account_id, thread_id, &body).map(Some),
        }
    }

    fn history(
        &self,
        start_history_id: &str,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        let token = self.access_token(cancel).map_err(GmailHistoryError::Mail)?;
        let mut query = format!(
            "startHistoryId={}&maxResults={MAX_PAGE_RESULTS}",
            url_encode(start_history_id)
        );
        if let Some(page_token) = page_token {
            query.push_str(&format!("&pageToken={}", url_encode(page_token)));
        }
        let body = self
            .api_get("/gmail/v1/users/me/history", &query, &token, cancel)
            .map_err(GmailHistoryError::Mail)?
            // The stored history cursor expired: bounded rediscovery is the
            // sync lane's job, not silent skipping.
            .ok_or(GmailHistoryError::Expired)?;
        parse_history(&body).map_err(GmailHistoryError::Mail)
    }
}
