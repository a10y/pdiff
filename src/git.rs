//! Git queries for the viewer. Everything runs the `git` CLI in the repo root.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

pub struct Repo {
    pub root: PathBuf,
}

/// What to compare. Mirrors `Source` in web/src/main.ts.
#[derive(Clone, Debug, Serialize)]
pub struct Source {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
}

#[derive(Serialize)]
pub struct Commit {
    sha: String,
    short: String,
    subject: String,
    author: String,
    when: String,
}

#[derive(Serialize)]
pub struct Counts {
    unstaged: usize,
    staged: usize,
    uncommitted: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    repo: String,
    branch: String,
    head: String,
    default_base: Option<String>,
    branches: Vec<String>,
    commits: Vec<Commit>,
    counts: Counts,
    initial: Source,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    patch: String,
    /// Revisions for `/api/file`: a commit, ":" (the index) or "WORKTREE".
    old_rev: String,
    new_rev: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub const WORKTREE: &str = "WORKTREE";
pub const INDEX: &str = ":";

/// Untracked files bigger than this are listed but not read.
const MAX_UNTRACKED_BYTES: u64 = 2 << 20;
const MAX_UNTRACKED_FILES: usize = 500;

impl Repo {
    /// Find the repo that contains `dir`.
    pub fn discover(dir: &Path) -> Result<Repo, String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .map_err(|e| format!("cannot run git: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if err.contains("must be run in a work tree") {
                return Err("this is a bare repository; run pdiff inside one of its worktrees".into());
            }
            return Err(err);
        }
        let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(Repo { root: PathBuf::from(root) })
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new("git");
        c.arg("-C").arg(&self.root);
        // Plain, stable output whatever the user's config says.
        c.args(["-c", "core.quotepath=off", "-c", "color.ui=never"]);
        c
    }

    /// Run git; Ok(stdout) when the exit code is in `ok_codes`.
    fn run_codes(&self, args: &[&str], ok_codes: &[i32]) -> Result<String, String> {
        let out = self.cmd().args(args).output().map_err(|e| format!("cannot run git: {e}"))?;
        let code = out.status.code().unwrap_or(-1);
        if !ok_codes.contains(&code) {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() { format!("git {} failed ({code})", args.join(" ")) } else { err });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        self.run_codes(args, &[0])
    }

    fn run_bytes(&self, args: &[&str]) -> Option<Vec<u8>> {
        let out = self.cmd().args(args).output().ok()?;
        out.status.success().then_some(out.stdout)
    }

    fn line(&self, args: &[&str]) -> Option<String> {
        self.run(args).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    pub fn branch(&self) -> String {
        self.line(&["symbolic-ref", "--short", "-q", "HEAD"])
            .or_else(|| self.line(&["rev-parse", "--short", "HEAD"]).map(|s| format!("detached @ {s}")))
            .unwrap_or_else(|| "(no commits)".into())
    }

    fn has_head(&self) -> bool {
        self.line(&["rev-parse", "-q", "--verify", "HEAD"]).is_some()
    }

    /// The branch that changes merge into: origin/HEAD, else a common name.
    pub fn default_base(&self) -> Option<String> {
        if let Some(r) = self.line(&["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]) {
            return Some(r);
        }
        for cand in ["origin/main", "origin/master", "origin/develop", "main", "master", "develop", "trunk"] {
            if self.line(&["rev-parse", "-q", "--verify", &format!("{cand}^{{commit}}")]).is_some() {
                return Some(cand.into());
            }
        }
        None
    }

    fn branches(&self) -> Vec<String> {
        self.run(&[
            "for-each-ref",
            "--sort=-committerdate",
            "--count=400",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.ends_with("/HEAD") && !l.is_empty())
        .map(str::to_string)
        .collect()
    }

    fn commits(&self) -> Vec<Commit> {
        if !self.has_head() {
            return Vec::new();
        }
        let out = self
            .run(&["log", "-n", "150", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr%x1e", "HEAD"])
            .unwrap_or_default();
        out.split('\x1e')
            .filter_map(|rec| {
                let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
                (f.len() == 5).then(|| Commit {
                    sha: f[0].into(),
                    short: f[1].into(),
                    subject: f[2].into(),
                    author: f[3].into(),
                    when: f[4].into(),
                })
            })
            .collect()
    }

    /// `git status` entries: (index status, worktree status, path).
    fn status(&self) -> Vec<(char, char, String)> {
        let out = self.run(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]).unwrap_or_default();
        let mut entries = Vec::new();
        let mut parts = out.split('\0');
        while let Some(e) = parts.next() {
            if e.len() < 4 {
                continue;
            }
            let mut c = e.chars();
            let (x, y) = (c.next().unwrap(), c.next().unwrap());
            entries.push((x, y, e[3..].to_string()));
            if x == 'R' || x == 'C' {
                parts.next(); // the old name
            }
        }
        entries
    }

    fn counts(&self) -> Counts {
        let st = self.status();
        Counts {
            unstaged: st.iter().filter(|(x, y, _)| *y != ' ' || *x == '?').count(),
            staged: st.iter().filter(|(x, _, _)| *x != ' ' && *x != '?').count(),
            uncommitted: st.len(),
        }
    }

    pub fn info(&self, initial: &Source) -> Info {
        Info {
            repo: self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            branch: self.branch(),
            head: self.line(&["rev-parse", "HEAD"]).unwrap_or_default(),
            default_base: self.default_base(),
            branches: self.branches(),
            commits: self.commits(),
            counts: self.counts(),
            initial: initial.clone(),
        }
    }

    /// The source to show on start when the user gave none: local changes if
    /// there are any, else the branch against its base.
    pub fn auto_source(&self) -> Source {
        let c = self.counts();
        let mode = if c.uncommitted > 0 || self.default_base().is_none() { "uncommitted" } else { "base" };
        Source { mode: mode.into(), base: None, range: None }
    }

    /// Patch text for untracked files, as "new file" diffs.
    fn untracked_patch(&self) -> String {
        let list = self.run(&["ls-files", "-z", "--others", "--exclude-standard"]).unwrap_or_default();
        let mut patch = String::new();
        for path in list.split('\0').filter(|p| !p.is_empty()).take(MAX_UNTRACKED_FILES) {
            let size = std::fs::metadata(self.root.join(path)).map(|m| m.len()).unwrap_or(0);
            if size > MAX_UNTRACKED_BYTES {
                patch.push_str(&format!(
                    "diff --git a/{path} b/{path}\nnew file mode 100644\nindex 0000000..0000000\nBinary files /dev/null and b/{path} differ\n"
                ));
                continue;
            }
            // Exit code 1 means "there are differences".
            if let Ok(p) = self.run_codes(
                &["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path],
                &[0, 1],
            ) {
                patch.push_str(&p);
            }
        }
        patch
    }

    fn resolve(&self, rev: &str) -> Result<String, String> {
        self.line(&["rev-parse", "--verify", "-q", &format!("{rev}^{{commit}}")])
            .ok_or_else(|| format!("unknown revision: {rev}"))
    }

    /// The diff for `src`.
    pub fn diff(&self, src: &Source) -> Diff {
        match self.diff_inner(src) {
            Ok(d) => d,
            Err(error) => Diff {
                patch: String::new(),
                old_rev: String::new(),
                new_rev: String::new(),
                label: String::new(),
                error: Some(error),
            },
        }
    }

    /// The old and new revisions for `src` and a label for it, without running
    /// the diff. Revisions are commits, ":" (the index) or "WORKTREE".
    pub fn revs(&self, src: &Source) -> Result<(String, String, String), String> {
        // Without commits, compare against the empty tree.
        let head = if self.has_head() { "HEAD".to_string() } else { self.empty_tree() };
        Ok(match src.mode.as_str() {
            "unstaged" => (INDEX.to_string(), WORKTREE.to_string(), "Unstaged changes".to_string()),
            "staged" => (head, INDEX.to_string(), "Staged changes".to_string()),
            "uncommitted" => (head, WORKTREE.to_string(), "All uncommitted changes".to_string()),
            "base" => {
                let base = src.base.clone().or_else(|| self.default_base()).ok_or("no base branch found")?;
                let mb = self
                    .line(&["merge-base", &base, "HEAD"])
                    .ok_or_else(|| format!("{base} and HEAD have no common ancestor"))?;
                (mb, self.resolve("HEAD")?, format!("{} vs {base}", self.branch()))
            }
            "range" => {
                let range = src.range.clone().unwrap_or_default();
                let (old, new) = self.parse_range(&range)?;
                (old, new, range)
            }
            other => return Err(format!("unknown mode: {other}")),
        })
    }

    fn diff_inner(&self, src: &Source) -> Result<Diff, String> {
        let (old_rev, new_rev, label) = self.revs(src)?;
        let patch = self.patch(src, &old_rev, &new_rev)?;
        Ok(Diff { patch, old_rev, new_rev, label, error: None })
    }

    /// The unified diff text from `old_rev` to `new_rev` (as returned by `revs`).
    pub fn patch(&self, src: &Source, old_rev: &str, new_rev: &str) -> Result<String, String> {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
        match (old_rev, new_rev) {
            (INDEX, WORKTREE) => {}
            (old, INDEX) => args.extend(["--cached", old]),
            (old, WORKTREE) => args.push(old),
            (old, new) => args.extend([old, new]),
        }
        let mut patch = self.run(&args)?;
        if new_rev == WORKTREE && matches!(src.mode.as_str(), "unstaged" | "uncommitted") {
            patch.push_str(&self.untracked_patch());
        }
        Ok(patch)
    }

    /// "A..B", "A...B" (from the merge base), or a single commit "A" (A^..A).
    fn parse_range(&self, range: &str) -> Result<(String, String), String> {
        let range = range.trim();
        if range.is_empty() {
            return Err("empty range".into());
        }
        if let Some((a, b)) = range.split_once("...") {
            let b = if b.is_empty() { "HEAD" } else { b };
            let a = if a.is_empty() { "HEAD" } else { a };
            let mb = self.line(&["merge-base", a, b]).ok_or_else(|| format!("{a} and {b} have no common ancestor"))?;
            return Ok((mb, self.resolve(b)?));
        }
        if let Some((a, b)) = range.split_once("..") {
            let a = if a.is_empty() { "HEAD" } else { a };
            let b = if b.is_empty() { "HEAD" } else { b };
            let old = self.resolve(a).or_else(|e| {
                // "<root commit>^" has no parent: use the empty tree.
                if a.ends_with('^') && self.resolve(&a[..a.len() - 1]).is_ok() { Ok(self.empty_tree()) } else { Err(e) }
            })?;
            return Ok((old, self.resolve(b)?));
        }
        let new = self.resolve(range)?;
        let old = self.resolve(&format!("{new}^")).unwrap_or_else(|_| self.empty_tree());
        Ok((old, new))
    }

    fn empty_tree(&self) -> String {
        self.line(&["hash-object", "-t", "tree", "/dev/null"])
            .unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into())
    }

    /// File contents at `rev` (a commit, ":" for the index, or WORKTREE).
    pub fn file(&self, rev: &str, path: &str) -> Option<Vec<u8>> {
        if path.is_empty() || path.starts_with('/') || path.split('/').any(|c| c == "..") {
            return None;
        }
        if rev == WORKTREE {
            let full = self.root.join(path).canonicalize().ok()?;
            let root = self.root.canonicalize().ok()?;
            return full.starts_with(&root).then(|| std::fs::read(full).ok()).flatten();
        }
        if rev.starts_with('-') {
            return None;
        }
        let spec = if rev == INDEX { format!(":{path}") } else { format!("{rev}:{path}") };
        self.run_bytes(&["show", &spec])
    }

    /// A value that changes when the diff for `src` may have changed.
    pub fn fingerprint(&self, src: &Source) -> String {
        let mut fp = self.line(&["rev-parse", "HEAD"]).unwrap_or_default();
        let git_dir = self.line(&["rev-parse", "--absolute-git-dir"]).map(PathBuf::from);
        let mtime = |p: &Path| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        };
        if let Some(g) = &git_dir {
            fp.push_str(&format!(":{}", mtime(&g.join("index"))));
        }
        if matches!(src.mode.as_str(), "unstaged" | "uncommitted" | "staged") {
            for (x, y, path) in self.status() {
                let p = self.root.join(&path);
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                fp.push_str(&format!("|{x}{y}{path}:{}:{size}", mtime(&p)));
            }
        }
        if src.mode == "base" {
            let base = src.base.clone().or_else(|| self.default_base()).unwrap_or_default();
            fp.push_str(&self.line(&["rev-parse", &base]).unwrap_or_default());
        }
        fp
    }
}
