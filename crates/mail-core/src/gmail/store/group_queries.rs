use super::*;

impl GmailStore {
    /// Active-account lookup by original acceptance request ID
    /// (docs/ux-05-safe-bulk-processing.md §4.2); `Ok(None)` while nothing
    /// has committed for that request.
    pub(crate) fn get_operation_group(
        &self,
        request: &crate::groups::GetOperationGroupRequest,
    ) -> Result<Option<OperationGroupStatus>, MailError> {
        crate::groups::validate_group_request_id(&request.request_id)?;
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = account_id_of(&conn)?;
        if account_id != request.account_id {
            return Err(MailError::NotFound);
        }
        let group_id: Option<String> = conn
            .query_row(
                "SELECT group_id FROM gmail_operation_groups
                 WHERE account_id = ?1 AND request_id = ?2",
                params![account_id, request.request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_err())?;
        let Some(group_id) = group_id else {
            return Ok(None);
        };
        load_group_status(&conn, &account_id, &group_id, self.clock.now_iso()).map(Some)
    }

    /// Bounded recent group summaries with cursor, independent of Inbox/Done
    /// rows (docs/ux-05-safe-bulk-processing.md §4.2).
    pub(crate) fn list_operation_groups(
        &self,
        request: &crate::groups::ListOperationGroupsRequest,
    ) -> Result<crate::groups::OperationGroupPage, MailError> {
        crate::groups::validate_group_page_limit(request.limit)?;
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = account_id_of(&conn)?;
        if account_id != request.account_id {
            return Err(MailError::NotFound);
        }
        let before_seq = request
            .cursor
            .as_deref()
            .map(|cursor| crate::groups::decode_group_cursor(&account_id, cursor))
            .transpose()?;
        let mut stmt = conn
            .prepare(
                "SELECT group_id, request_id, kind, requested_value, accepted_at, undone_at,
                        group_seq
                 FROM gmail_operation_groups WHERE account_id = ?1
                   AND (?2 IS NULL OR group_seq < ?2)
                 ORDER BY group_seq DESC LIMIT ?3",
            )
            .map_err(storage_err())?;
        let mut rows = stmt
            .query_map(
                params![account_id, before_seq, request.limit as i64 + 1],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .map_err(storage_err())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_err())?;
        let has_more = rows.len() > request.limit as usize;
        rows.truncate(request.limit as usize);
        let mut summaries = Vec::with_capacity(rows.len());
        let mut last_seq: Option<i64> = None;
        for (group_id, group_request_id, kind, value, accepted_at, undone_at, group_seq) in rows {
            let kind = parse_kind(&kind)?;
            let members = load_group_member_refs(&conn, &account_id, &group_id)?;
            summaries.push(crate::groups::OperationGroupSummary {
                requested_starred: (kind == MailboxOperationKind::Star).then_some(value != 0),
                group_id,
                request_id: group_request_id,
                kind,
                requested_archived: (kind == MailboxOperationKind::Archive).then_some(value != 0),
                requested_read: (kind == MailboxOperationKind::Read).then_some(value != 0),
                accepted_at,
                members,
                undone: undone_at.is_some(),
            });
            last_seq = Some(group_seq);
        }
        let next_cursor = has_more
            .then(|| last_seq.map(|seq| crate::groups::encode_group_cursor(&account_id, seq)))
            .flatten();
        Ok(crate::groups::OperationGroupPage {
            groups: summaries,
            next_cursor,
        })
    }
}
