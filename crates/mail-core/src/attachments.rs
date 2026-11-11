//! Download-only attachments. No document parser, renderer or remote-resource loader.
use crate::{dto::ConversationRef, CancelToken, MailError};
use serde::{Deserialize, Serialize};
use std::{fs::OpenOptions, io::Write, path::Path};
use ts_rs::TS;

pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_ATTACHMENTS: usize = 32;
/// Opaque Gmail handles can exceed message/request IDs (e.g. 404 bytes).
/// 4 KiB leaves headroom while bounding cached metadata and GET path length.
/// Only unreserved base64url ASCII is allowed, never URL/path delimiters.
pub const MAX_ATTACHMENT_ID_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDescriptor {
    pub message_id: String,
    pub attachment_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveAttachment {
    pub conversation: ConversationRef,
    pub message_id: String,
    pub attachment_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSaved {
    /// Basename only, never an arbitrary frontend-accessible filesystem path.
    pub filename: String,
}

pub fn invalid(field: &str) -> MailError {
    MailError::InvalidRequest {
        field: field.into(),
    }
}
pub fn check_cancel(cancel: &CancelToken) -> Result<(), MailError> {
    if cancel.is_cancelled() {
        Err(MailError::AuthCancelled)
    } else {
        Ok(())
    }
}
pub fn safe_filename(name: &str) -> String {
    let name: String = name
        .chars()
        .take(160)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let name = name.trim_matches('.');
    format!(
        "{}.download",
        if name.is_empty() { "attachment" } else { name }
    )
}
/// Request/message IDs retain their existing 256-byte ASCII contract.
pub fn valid_id(id: &str) -> bool {
    valid_segment(id, 256)
}
pub fn valid_attachment_id(id: &str) -> bool {
    valid_segment(id, MAX_ATTACHMENT_ID_BYTES)
}
fn valid_segment(id: &str, max_bytes: usize) -> bool {
    !id.is_empty()
        && id.len() <= max_bytes
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub fn valid_mime(mime: &str) -> bool {
    mime.len() <= 127
        && mime.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes()
                    .chain(b.bytes())
                    .all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c))
        })
}
pub fn validate_bytes(d: &AttachmentDescriptor, bytes: &[u8]) -> Result<(), MailError> {
    if bytes.len() > MAX_ATTACHMENT_BYTES
        || bytes.len() != d.size as usize
        || !valid_mime(&d.mime_type)
    {
        return Err(invalid("attachmentSizeOrMime"));
    }
    let pdf = bytes.starts_with(b"%PDF-");
    if (d.mime_type == "application/pdf") != pdf {
        return Err(invalid("attachmentMimeMismatch"));
    }
    if d.mime_type == "text/plain" {
        let text = std::str::from_utf8(bytes).map_err(|_| invalid("attachmentMimeMismatch"))?;
        let lower = text.trim_start().to_ascii_lowercase();
        if text.contains('\0') || lower.starts_with("<!doctype html") || lower.starts_with("<html")
        {
            return Err(invalid("attachmentMimeMismatch"));
        }
    }
    Ok(())
}

/// Directory comes from the native OS resolver, not IPC. No overwrite, symlink
/// following, sender path joining, or document execution. Only inert suffixes.
pub fn save_download(
    directory: &Path,
    d: &AttachmentDescriptor,
    bytes: &[u8],
    cancel: &CancelToken,
) -> Result<AttachmentSaved, MailError> {
    validate_bytes(d, bytes)?;
    check_cancel(cancel)?;
    let filename = format!("{}-{}", uuid::Uuid::new_v4(), safe_filename(&d.filename));
    let path = directory.join(&filename);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| MailError::StorageUnavailable)?;
    let result = (|| {
        for chunk in bytes.chunks(64 * 1024) {
            check_cancel(cancel)?;
            file.write_all(chunk)
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        file.sync_all().map_err(|_| MailError::StorageUnavailable)?;
        check_cancel(cancel)
    })();
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(AttachmentSaved { filename })
}

pub fn validated_external_url(raw: &str) -> Result<String, MailError> {
    if raw.len() > 2048 || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(invalid("url"));
    }
    let url = url::Url::parse(raw).map_err(|_| invalid("url"))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid("url"));
    }
    Ok(url.into())
}

/// Metadata only; named parts without a fetchable ID are not invented as files.
pub fn descriptors(
    message_id: &str,
    payload: &serde_json::Value,
    output: &mut Vec<AttachmentDescriptor>,
    depth: usize,
) {
    if depth > 16 || output.len() >= MAX_ATTACHMENTS {
        return;
    }
    if let (Some(id), Some(size)) = (
        payload["body"]["attachmentId"].as_str(),
        payload["body"]["size"].as_u64(),
    ) {
        let mime = payload["mimeType"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase();
        if valid_id(message_id)
            && valid_attachment_id(id)
            && valid_mime(&mime)
            && size <= u32::MAX as u64
        {
            if output
                .iter()
                .any(|d| d.message_id == message_id && d.attachment_id == id)
            {
                return;
            }
            output.push(AttachmentDescriptor {
                message_id: message_id.into(),
                attachment_id: id.into(),
                filename: payload["filename"]
                    .as_str()
                    .unwrap_or("attachment")
                    .chars()
                    .take(160)
                    .filter(|c| !c.is_control())
                    .collect(),
                mime_type: mime,
                size: size as u32,
            });
        }
    }
    if let Some(parts) = payload["parts"].as_array() {
        for part in parts.iter().take(256) {
            descriptors(message_id, part, output, depth + 1);
        }
    }
}

#[cfg(test)]
pub(crate) struct TestDirectory(tempfile::TempDir);
#[cfg(test)]
impl TestDirectory {
    pub(crate) fn path(&self) -> &Path {
        self.0.path()
    }
}
#[cfg(test)]
pub(crate) fn test_directory() -> TestDirectory {
    TestDirectory(tempfile::tempdir().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pdf() -> AttachmentDescriptor {
        AttachmentDescriptor {
            message_id: "m".into(),
            attachment_id: "a".into(),
            filename: "../../evil.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 9,
        }
    }
    #[test]
    fn hostile_names_protocols_and_inert_storage() {
        for url in [
            "javascript:alert(1)",
            "file:///tmp/a",
            "mailto:a@b.com",
            "https://u:p@x.com",
            "https://x.com\n",
        ] {
            assert!(validated_external_url(url).is_err());
        }
        assert!(validated_external_url("https://example.com/path").is_ok());
        let dir = test_directory();
        let saved =
            save_download(dir.path(), &pdf(), b"%PDF-1.7\n", &CancelToken::default()).unwrap();
        assert!(saved.filename.ends_with(".download"));
        assert!(!saved.filename.contains('/'));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn corrupt_oversize_cancel_and_external_resources() {
        assert!(validate_bytes(&pdf(), b"<html>bad").is_err());
        assert!(validate_bytes(&pdf(), &vec![0; MAX_ATTACHMENT_BYTES + 1]).is_err());
        let cancel = CancelToken::default();
        cancel.cancel();
        let dir = test_directory();
        assert!(save_download(dir.path(), &pdf(), b"%PDF-1.7\n", &cancel).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        let mut html = pdf();
        html.mime_type = "text/html".into();
        html.size = 29;
        // HTML/Office are opaque inert bytes, never parsed or loaded.
        let bytes = b"<img src=https://evil.test/x>";
        html.size = bytes.len() as u32;
        assert!(save_download(dir.path(), &html, bytes, &CancelToken::default()).is_ok());
    }
    #[test]
    fn office_html_and_pdf_external_actions_are_opaque_inert_downloads() {
        let dir = test_directory();
        for (mime, name, data) in [
            (
                "text/html",
                "../../evil.html",
                b"<script src=https://remote.test/x></script>".as_slice(),
            ),
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "x.docx",
                b"PK synthetic Office".as_slice(),
            ),
            (
                "application/pdf",
                "x.pdf",
                b"%PDF-1.7 /OpenAction /URI (https://remote.test/x)".as_slice(),
            ),
        ] {
            let mut d = pdf();
            d.mime_type = mime.into();
            d.filename = name.into();
            d.size = data.len() as u32;
            let saved = save_download(dir.path(), &d, data, &CancelToken::default()).unwrap();
            assert!(saved.filename.ends_with(".download"));
            assert_eq!(
                std::fs::read(dir.path().join(saved.filename)).unwrap(),
                data
            );
        }
    }

    #[test]
    fn attachment_handle_boundaries_and_path_segment_validation() {
        for len in [1, 256, 257, 404, MAX_ATTACHMENT_ID_BYTES] {
            let id = "aB0_-".repeat(len.div_ceil(5));
            let id = &id[..len];
            assert!(valid_attachment_id(id));
            // Same validator used by native request IDs and attachment message IDs.
            assert_eq!(valid_id(id), len <= 256);
            let payload = serde_json::json!({"mimeType":"application/pdf", "body":{"size":9,"attachmentId":id}});
            let mut out = vec![];
            descriptors("m1", &payload, &mut out, 0);
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].attachment_id, id);
            out.clear();
            descriptors(&"m".repeat(257), &payload, &mut out, 0);
            assert!(out.is_empty());
        }
        for id in [
            "",
            ".",
            "..",
            "../a",
            "a/b",
            "a\\b",
            "%2e%2e",
            "a?x",
            "a#x",
            "a:b",
            "a@b",
            "a=b",
            "a+b",
            "a b",
            "a\0",
            "a\r\n",
            "a\u{7f}",
            "é",
            "Ａ",
            &"a".repeat(MAX_ATTACHMENT_ID_BYTES + 1),
        ] {
            assert!(!valid_attachment_id(id), "accepted {id:?}");
            assert!(!valid_id(id), "accepted request/message ID {id:?}");
            let payload = serde_json::json!({"mimeType":"application/pdf", "body":{"size":9,"attachmentId":id}});
            let mut out = vec![];
            descriptors("m1", &payload, &mut out, 0);
            assert!(out.is_empty(), "discovered {id:?}");
        }
    }

    #[test]
    fn bounded_metadata() {
        let payload = serde_json::json!({"parts": (0..100).map(|i| serde_json::json!({"mimeType":"application/pdf","filename":"../x", "body":{"size":9,"attachmentId":format!("a{i}")}})).collect::<Vec<_>>()});
        let mut out = vec![];
        descriptors("m", &payload, &mut out, 0);
        assert_eq!(out.len(), MAX_ATTACHMENTS);
    }
}
