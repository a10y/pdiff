//! Review comments that the user adds to lines of the diff.
//!
//! The page owns the comments and sends the full list to the server after
//! each change. The server keeps them so other programs (an agent) can read
//! them as Markdown.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Review {
    /// What the diff compares, for example "main vs my-branch".
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub file: String,
    /// "additions" (new file lines) or "deletions" (old file lines).
    pub side: String,
    pub start: u32,
    pub end: u32,
    pub body: String,
    /// The text of the commented lines, when the page knows it.
    #[serde(default)]
    pub snippet: Vec<String>,
}

impl Review {
    /// A prompt for a coding agent: one section per comment, in file order.
    pub fn to_markdown(&self) -> String {
        let mut out = String::new();
        let n = self.comments.len();
        out.push_str(&format!(
            "# Review comments ({n})\n\nI reviewed the diff ({}) and left these comments. \
             Address each one. Line numbers refer to the new version of the file, \
             unless marked \"old\".\n",
            if self.label.is_empty() { "current changes" } else { &self.label }
        ));
        let mut comments: Vec<&Comment> = self.comments.iter().collect();
        comments.sort_by(|a, b| (&a.file, a.start).cmp(&(&b.file, b.start)));
        for c in comments {
            let lines =
                if c.start == c.end { format!("{}", c.start) } else { format!("{}-{}", c.start, c.end) };
            let old = if c.side == "deletions" { " (old)" } else { "" };
            out.push_str(&format!("\n## {}:{lines}{old}\n\n", c.file));
            if !c.snippet.is_empty() {
                let lang = c.file.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
                out.push_str(&format!("```{lang}\n{}\n```\n\n", c.snippet.join("\n")));
            }
            out.push_str(c.body.trim());
            out.push('\n');
        }
        out
    }
}

/// Put text on the system clipboard. Returns false if no clipboard tool works.
pub fn copy_to_clipboard(text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let tools: &[(&str, &[&str])] =
        &[("pbcopy", &[]), ("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["-b", "-i"])];
    for (cmd, args) in tools {
        let Ok(mut child) = Command::new(cmd).args(*args).stdin(Stdio::piped()).spawn() else { continue };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        if child.wait().map(|s| s.success()).unwrap_or(false) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_sorts_and_marks_old_lines() {
        let c = |file: &str, side: &str, start, end, body: &str| Comment {
            id: String::new(),
            file: file.into(),
            side: side.into(),
            start,
            end,
            body: body.into(),
            snippet: vec![],
        };
        let r = Review {
            label: "main vs x".into(),
            comments: vec![c("b.rs", "additions", 3, 5, "rename"), c("a.rs", "deletions", 7, 7, " why? ")],
        };
        let md = r.to_markdown();
        let a = md.find("## a.rs:7 (old)\n\nwhy?\n").unwrap();
        let b = md.find("## b.rs:3-5\n\nrename\n").unwrap();
        assert!(a < b);
        assert!(md.contains("(main vs x)"));
    }
}
