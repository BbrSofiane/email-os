//! Bounded plain text for HTML-only mail (ADR 0006 decision 2).
//!
//! The input is untrusted and may be shaped to exhaust time or memory, so this
//! is one forward pass over the bytes: no tree, no recursion and no stack that
//! grows with the input. The cursor never moves back and every search either
//! consumes what it scanned or runs to the end of the input once. Output stops
//! at a character bound. It is an approximation for previews, search, quotes
//! and copying; the reader shows the HTML itself.

use markup5ever::data::NAMED_ENTITIES;

const MAX_LINKS: usize = 200;
const MAX_LINK_BYTES: usize = 2048;
/// Longest HTML element name we act on.
const MAX_TAG_NAME_BYTES: usize = 16;
/// Longest name in the HTML named character reference table, with its `;`.
const MAX_ENTITY_NAME_BYTES: usize = 32;

/// Elements whose content is raw text up to the first matching close tag.
const RAW_TEXT: [&str; 9] = [
    "script", "style", "title", "textarea", "iframe", "noscript", "xmp", "noembed", "noframes",
];
/// Elements whose content is dropped, counting nested elements of that name.
const DROPPED: [&str; 5] = ["template", "object", "select", "svg", "math"];
/// Elements separated from their surroundings by a blank line.
const SPACED_BLOCKS: [&str; 12] = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "table",
    "blockquote",
    "pre",
];
/// Elements that only start a new line.
const BLOCKS: [&str; 20] = [
    "br", "div", "li", "tr", "hr", "section", "article", "header", "footer", "address", "dl", "dt",
    "dd", "figure", "center", "form", "fieldset", "main", "nav", "aside",
];

/// Characters the HTML standard substitutes for references to 0x80..=0x9F.
const WINDOWS_1252: [char; 32] = [
    '\u{20AC}', '\u{81}', '\u{201A}', '\u{192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{2C6}', '\u{2030}', '\u{160}', '\u{2039}', '\u{152}', '\u{8D}', '\u{17D}', '\u{8F}',
    '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{2DC}', '\u{2122}', '\u{161}', '\u{203A}', '\u{153}', '\u{9D}', '\u{17E}', '\u{178}',
];

/// Returns the visible text of `html`, at most `max_chars` characters.
pub(crate) fn extract(html: &str, max_chars: usize) -> String {
    Extractor::new(html, max_chars).run()
}

/// A link whose text is being collected.
struct OpenLink {
    url: String,
    /// Length of the output, in bytes, when the link opened.
    start: usize,
}

struct Extractor<'a> {
    html: &'a str,
    pos: usize,
    output: String,
    /// Characters in `output`, kept incrementally.
    count: usize,
    limit: usize,
    /// Line breaks owed before the next visible character (0, 1 or 2).
    breaks: u8,
    /// A list item opened and its marker is owed before its first text.
    bullet: bool,
    pre: usize,
    links: Vec<String>,
    link: Option<OpenLink>,
}

impl<'a> Extractor<'a> {
    fn new(html: &'a str, limit: usize) -> Self {
        Self {
            html,
            pos: 0,
            output: String::new(),
            count: 0,
            limit,
            breaks: 0,
            bullet: false,
            pre: 0,
            links: Vec::new(),
            link: None,
        }
    }

    fn run(mut self) -> String {
        while self.pos < self.html.len() && self.count < self.limit {
            let rest = &self.html[self.pos..];
            if starts_markup(rest.as_bytes()) {
                self.markup();
            } else if rest.starts_with('&') {
                let (chars, consumed) = reference(rest, false);
                self.pos += consumed;
                for c in chars.into_iter().flatten() {
                    self.text(c);
                }
            } else if let Some(c) = rest.chars().next() {
                self.pos += c.len_utf8();
                self.text(c);
            }
        }
        let complete = self.pos >= self.html.len();
        self.trim_end(true);
        if complete {
            self.footnotes();
        }
        self.output.shrink_to_fit();
        self.output
    }

    /// Appends link destinations, only as whole lines that fit.
    fn footnotes(&mut self) {
        for (index, url) in std::mem::take(&mut self.links).into_iter().enumerate() {
            let separator = if index == 0 { "\n\n" } else { "\n" };
            let line = format!("{separator}[{}]: {url}", index + 1);
            let chars = line.chars().count();
            if self.count + chars > self.limit {
                return;
            }
            self.output.push_str(&line);
            self.count += chars;
        }
    }

    fn emit(&mut self, c: char) {
        if self.count < self.limit {
            self.output.push(c);
            self.count += 1;
        }
    }

    /// Removes trailing spaces; each removed character was emitted once, so the
    /// total work stays linear.
    fn trim_end(&mut self, line_breaks: bool) {
        while self
            .output
            .ends_with(|c| matches!(c, ' ' | '\t') || (line_breaks && c == '\n'))
        {
            self.output.pop();
            self.count -= 1;
        }
    }

    /// Emits the owed line breaks and list marker before visible text.
    fn settle(&mut self) {
        if !self.output.is_empty() {
            for _ in 0..self.breaks {
                self.emit('\n');
            }
        }
        self.breaks = 0;
        if self.bullet {
            self.bullet = false;
            self.emit('*');
            self.emit(' ');
        }
    }

    fn line_break(&mut self, blank: bool) {
        self.trim_end(false);
        self.breaks = self.breaks.max(if blank { 2 } else { 1 });
    }

    /// One space between words or table cells, never at the start of a line.
    fn space(&mut self) {
        if self.breaks == 0
            && !self.bullet
            && !self.output.is_empty()
            && !self.output.ends_with([' ', '\n'])
        {
            self.emit(' ');
        }
    }

    fn text(&mut self, c: char) {
        if self.pre == 0 && c.is_whitespace() {
            self.space();
        } else if c == '\n' || c == '\t' || !c.is_control() {
            self.settle();
            self.emit(c);
        }
    }

    /// Handles a comment, declaration or tag at the cursor. Each kind consumes
    /// what it scanned, or the rest of the input when it is unterminated.
    fn markup(&mut self) {
        let rest = &self.html[self.pos..];
        let after = rest.as_bytes().get(1).copied().unwrap_or_default();
        let close_name = rest.as_bytes().get(2).copied().unwrap_or_default();
        if let Some(comment) = rest.strip_prefix("<!--") {
            let length = if comment.starts_with('>') {
                1
            } else if comment.starts_with("->") {
                2
            } else {
                comment.find("-->").map_or(comment.len(), |at| at + 3)
            };
            self.pos += 4 + length;
        } else if matches!(after, b'!' | b'?')
            || (after == b'/' && !close_name.is_ascii_alphabetic())
        {
            self.pos += rest.find('>').map_or(rest.len(), |at| at + 1);
        } else {
            self.tag();
        }
    }

    fn tag(&mut self) {
        let closing = self.html.as_bytes()[self.pos + 1] == b'/';
        let name_start = self.pos + if closing { 2 } else { 1 };
        let name_length = self.html.as_bytes()[name_start..]
            .iter()
            .position(|b| b.is_ascii_whitespace() || matches!(b, b'/' | b'>'))
            .unwrap_or(self.html.len() - name_start);
        let name = &self.html[name_start..name_start + name_length];
        self.pos = name_start + name_length;
        let known = name.len() <= MAX_TAG_NAME_BYTES;
        let name = if known {
            name.to_ascii_lowercase()
        } else {
            String::new()
        };

        let attributes = self.attributes(name == "a" && !closing);
        if !attributes.terminated || !known {
            return;
        }
        let name = name.as_str();
        if !closing && RAW_TEXT.contains(&name) {
            self.skip_content(name, false);
            return;
        }
        if !closing && DROPPED.contains(&name) {
            let foreign = matches!(name, "svg" | "math");
            if !(foreign && attributes.self_closing) {
                self.skip_content(name, true);
            }
            return;
        }
        match name {
            "a" if closing => self.close_link(),
            "a" => {
                self.link = attributes.href.map(|url| OpenLink {
                    url,
                    start: self.output.len(),
                });
            }
            "td" | "th" => self.space(),
            "pre" if closing => self.pre = self.pre.saturating_sub(1),
            "pre" => self.pre = self.pre.saturating_add(1),
            _ => {}
        }
        if SPACED_BLOCKS.contains(&name) {
            // The first block of a list item stays on the marker's line.
            if !self.bullet {
                self.line_break(true);
            }
        } else if BLOCKS.contains(&name) {
            self.line_break(false);
            if name == "li" {
                self.bullet = !closing;
            }
        }
    }

    /// Ends a link: text that is not already the URL gets a numbered footnote.
    fn close_link(&mut self) {
        let Some(link) = self.link.take() else {
            return;
        };
        let text = self.output.get(link.start..).unwrap_or_default().trim();
        if text.is_empty() || text == link.url || self.links.len() >= MAX_LINKS {
            return;
        }
        self.trim_end(false);
        for c in format!("[{}]", self.links.len() + 1).chars() {
            self.emit(c);
        }
        self.links.push(link.url);
    }

    /// Consumes a tag's attributes and its `>`. Quotes only open a value right
    /// after `=`, as in the HTML tokenizer.
    fn attributes(&mut self, want_href: bool) -> Attributes {
        let bytes = self.html.as_bytes();
        let mut found = Attributes::default();
        let mut slash = false;
        while self.pos < bytes.len() {
            let b = bytes[self.pos];
            if b == b'>' {
                self.pos += 1;
                found.terminated = true;
                found.self_closing = slash;
                return found;
            }
            slash = b == b'/';
            if slash || b.is_ascii_whitespace() {
                self.pos += 1;
                continue;
            }
            let name = self.attribute_name();
            let value = self.attribute_value();
            if want_href && found.href.is_none() && name.eq_ignore_ascii_case("href") {
                found.href = value.and_then(link_url);
            }
        }
        found
    }

    fn attribute_name(&mut self) -> &'a str {
        let html = self.html;
        let start = self.pos;
        // A leading `=` belongs to the name, so the cursor always advances.
        self.pos += 1;
        while !html.is_char_boundary(self.pos) {
            self.pos += 1;
        }
        self.advance_until(|b| b.is_ascii_whitespace() || matches!(b, b'=' | b'/' | b'>'));
        &html[start..self.pos]
    }

    /// The value after an optional `=`, without its quotes.
    fn attribute_value(&mut self) -> Option<&'a str> {
        let html = self.html;
        self.advance_until(|b| !b.is_ascii_whitespace());
        if html.as_bytes().get(self.pos) != Some(&b'=') {
            return None;
        }
        self.pos += 1;
        self.advance_until(|b| !b.is_ascii_whitespace());
        let quote = match html.as_bytes().get(self.pos) {
            Some(&b) if matches!(b, b'"' | b'\'') => Some(b),
            _ => None,
        };
        if let Some(quote) = quote {
            self.pos += 1;
            let start = self.pos;
            self.advance_until(|b| b == quote);
            let value = &html[start..self.pos];
            self.pos = (self.pos + 1).min(html.len());
            return Some(value);
        }
        let start = self.pos;
        self.advance_until(|b| b.is_ascii_whitespace() || b == b'>');
        Some(&html[start..self.pos])
    }

    /// Moves the cursor to the next ASCII byte matching `stop`, or to the end.
    fn advance_until(&mut self, stop: impl Fn(u8) -> bool) {
        let rest = &self.html.as_bytes()[self.pos..];
        self.pos += rest
            .iter()
            .position(|&b| b.is_ascii() && stop(b))
            .unwrap_or(rest.len());
    }

    /// Consumes up to the close tag of `name`, or to the end of the input.
    fn skip_content(&mut self, name: &str, nested: bool) {
        let bytes = self.html.as_bytes();
        let mut depth = 1usize;
        while self.pos < bytes.len() {
            self.advance_until(|b| b == b'<');
            let closing = bytes.get(self.pos + 1) == Some(&b'/');
            let start = self.pos + if closing { 2 } else { 1 };
            let end = start + name.len();
            self.pos = (self.pos + 1).min(bytes.len());
            let matches = bytes
                .get(start..end)
                .is_some_and(|found| found.eq_ignore_ascii_case(name.as_bytes()))
                && bytes
                    .get(end)
                    .is_some_and(|b| b.is_ascii_whitespace() || matches!(b, b'/' | b'>'));
            if !matches || !(closing || nested) {
                continue;
            }
            self.pos = end;
            let self_closing = self.attributes(false).self_closing;
            if closing {
                depth -= 1;
                if depth == 0 {
                    return;
                }
            } else if !self_closing {
                depth += 1;
            }
        }
    }
}

#[derive(Default)]
struct Attributes {
    terminated: bool,
    self_closing: bool,
    href: Option<String>,
}

/// Whether `<` starts markup here; otherwise it is literal text.
fn starts_markup(rest: &[u8]) -> bool {
    rest.first() == Some(&b'<')
        && rest
            .get(1)
            .is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'/' | b'!' | b'?'))
}

/// Decodes an `href` into a footnote URL: http, https and mailto, bounded.
fn link_url(value: &str) -> Option<String> {
    if value.len() > MAX_LINK_BYTES {
        return None;
    }
    let mut url = String::new();
    let mut at = 0;
    while let Some(c) = value[at..].chars().next() {
        if c == '&' {
            let (chars, consumed) = reference(&value[at..], true);
            at += consumed;
            url.extend(chars.into_iter().flatten());
        } else {
            at += c.len_utf8();
            url.push(c);
        }
    }
    url.retain(|c| !c.is_control());
    let url = url.trim();
    let scheme = url.split(':').next()?.to_ascii_lowercase();
    let allowed = matches!(scheme.as_str(), "http" | "https" | "mailto");
    (allowed && url.len() <= MAX_LINK_BYTES).then(|| url.to_string())
}

/// Decodes the character reference at the start of `s` (which starts with `&`)
/// and returns the bytes consumed. Numbers are consumed whole; names are looked
/// up at a bounded number of lengths.
fn reference(s: &str, in_attribute: bool) -> ([Option<char>; 2], usize) {
    let literal = ([Some('&'), None], 1);
    let bytes = s.as_bytes();
    if bytes.get(1) == Some(&b'#') {
        return numeric_reference(bytes).unwrap_or(literal);
    }
    let mut best = None;
    for end in 1..bytes.len().min(MAX_ENTITY_NAME_BYTES + 1) {
        let b = bytes[end];
        if !b.is_ascii_alphanumeric() && b != b';' {
            break;
        }
        if let Some(&(first, second)) = NAMED_ENTITIES.get(&s[1..=end]) {
            if first != 0 {
                best = Some((first, second, end));
            }
        }
        if b == b';' {
            break;
        }
    }
    let Some((first, second, end)) = best else {
        return literal;
    };
    // In attributes a name without `;` before `=` or a letter is plain text,
    // so query strings such as `?a=1&copy=2` survive.
    let ambiguous = bytes[end] != b';'
        && bytes
            .get(end + 1)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'=');
    if in_attribute && ambiguous {
        return literal;
    }
    let second = if second == 0 {
        None
    } else {
        char::from_u32(second)
    };
    ([char::from_u32(first), second], end + 1)
}

fn numeric_reference(bytes: &[u8]) -> Option<([Option<char>; 2], usize)> {
    let hex = matches!(bytes.get(2), Some(b'x' | b'X'));
    let radix = if hex { 16 } else { 10 };
    let start = if hex { 3 } else { 2 };
    let mut value = 0u32;
    let mut end = start;
    while let Some(digit) = bytes.get(end).and_then(|&b| char::from(b).to_digit(radix)) {
        value = value.saturating_mul(radix).saturating_add(digit);
        end += 1;
    }
    if end == start {
        return None;
    }
    if bytes.get(end) == Some(&b';') {
        end += 1;
    }
    let c = match value {
        0 => char::REPLACEMENT_CHARACTER,
        0x80..=0x9F => WINDOWS_1252[(value - 0x80) as usize],
        _ => char::from_u32(value).unwrap_or(char::REPLACEMENT_CHARACTER),
    };
    Some(([Some(c), None], end))
}

#[cfg(test)]
mod tests {
    use super::extract;
    use std::time::{Duration, Instant};

    #[test]
    fn formatting_and_references() {
        assert_eq!(extract("<p>Hello</p><p>world</p>", 100), "Hello\n\nworld");
        assert_eq!(
            extract("<ul><li>one</li><li>two</li></ul>", 100),
            "* one\n* two"
        );
        assert_eq!(
            extract(
                "<table><tr><td>a</td><td>b</td></tr><tr><th>c</th></tr></table>",
                100
            ),
            "a b\nc"
        );
        assert_eq!(extract("<pre>  a\n b</pre>", 100), "  a\n b");
        assert_eq!(
            extract("&eacute; &nbsp; &rsquo; &#233; &#xE9; &amp;lt;", 100),
            "é ’ é é &lt;"
        );
        assert_eq!(
            extract("<a title=\">\" href=\"https://example.com\">site</a>", 100),
            "site[1]\n\n[1]: https://example.com"
        );
        assert_eq!(
            extract("<a href='https://a'>https://a</a>", 100),
            "https://a"
        );
        assert_eq!(
            extract(
                "a < b<script>x</script><style>x</style><title>x</title>z",
                100
            ),
            "a < bz"
        );
        for s in ["a<tag", "a<!--", "a<x title='", "a<script>bad"] {
            assert_eq!(extract(s, 100), "a");
        }
        assert_eq!(extract("ééé", 2), "éé");
    }

    #[test]
    fn malformed_markup_keeps_the_following_text() {
        for (html, text) in [
            ("<td title=don't>kept</td>", "kept"),
            ("<p class='a'b\">kept</p>", "kept"),
            ("<!--><p>kept</p>", "kept"),
            ("<!--[if !mso]><!--><p>kept</p><!--<![endif]-->", "kept"),
            ("<![if !mso]><p>kept</p><![endif]>", "kept"),
            ("<?xml version=\"1.0\"?><p>kept</p>", "kept"),
            ("<svg/>kept", "kept"),
            ("<svg><svg/><path d='M0'/></svg>kept", "kept"),
            ("<script:x>kept", "kept"),
            ("<o:p>kept</o:p>", "kept"),
            ("<style></styles></style>kept", "kept"),
            ("</ don't>kept", "kept"),
            ("<p =x é=y>kept</p>", "kept"),
        ] {
            assert_eq!(extract(html, 100), text, "{html}");
        }
    }

    #[test]
    fn lists_links_and_windows_references() {
        assert_eq!(
            extract(
                "<ul><li><p>one</p></li><li></li><li><p>two</p><p>more</p></li></ul>",
                100
            ),
            "* one\n\n* two\n\nmore"
        );
        assert_eq!(extract("it&#146;s &#128;5", 100), "it’s €5");
        assert_eq!(
            extract("<a href='https://x.test/?a=1&copy=2&amp;b=3'>go</a>", 100),
            "go[1]\n\n[1]: https://x.test/?a=1&copy=2&b=3"
        );
        assert_eq!(
            extract("<a href='https://x.test/'><img src=a></a>after", 100),
            "after"
        );
        assert_eq!(
            extract("<a href='https://x\n.test'>go</a>", 100),
            "go[1]\n\n[1]: https://x.test"
        );
        assert_eq!(extract("<a href='javascript:x()'>go</a>", 100), "go");
        assert_eq!(
            extract("<a href='https://x.test'>long text</a>", 9),
            "long text"
        );
        assert_eq!(
            extract("&#0;&#xD800;&#x110000;&#1;x", 100),
            "\u{fffd}\u{fffd}\u{fffd}x"
        );
    }

    #[test]
    fn links_are_bounded() {
        let input = "<a href='https://a'>x</a> ".repeat(300);
        let result = extract(&input, 100_000);
        assert!(result.contains("[200]: https://a"));
        assert!(!result.contains("[201]"));
    }

    #[test]
    fn hostile_inputs_are_bounded_and_fast() {
        let mut cases = vec![
            format!("<tr>{}</tr>", "<td>a</td>".repeat(50_000)),
            "<td colspan=1000000>x</td>".into(),
            format!("{}visible", "<div>".repeat(90_000)),
        ];
        for tag in ["blockquote", "ul><li", "table"] {
            cases.push(format!("{}visible", format!("<{tag}>").repeat(10_000)));
        }
        cases.push(format!(
            "<a {}>x</a>",
            (0..200_000).map(|i| format!("a{i}=x ")).collect::<String>()
        ));
        for prefix in [
            "<",
            "&",
            "&#",
            "&#x",
            "&a",
            "<!--",
            "<!",
            "<?",
            "</",
            "<a href=\"",
            "<a href='x",
            "<script",
            "<script>",
            "<style></styl",
            "<![CDATA[",
            "<svg>",
            "<template>",
            "<pre>",
            "<br>",
            "<li>",
        ] {
            cases.push(prefix.repeat(1_048_576 / prefix.len()));
        }
        cases.push("<a href='https://a'>x</a>".repeat(300_000));
        for (i, input) in cases.iter().enumerate() {
            let start = Instant::now();
            let result = extract(input, 256 * 1024);
            assert!(result.chars().count() <= 256 * 1024, "case {i}");
            assert!(start.elapsed() < Duration::from_secs(2), "case {i}");
            if (2..=5).contains(&i) {
                assert!(result.contains("visible"), "case {i}");
            }
        }
    }
}
