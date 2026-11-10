# pdiff

A rich git diff viewer that runs inside your terminal. It uses the
[`@pierre/diffs`](https://diffs.com) renderer (the one behind diffshub), so you get
syntax highlighting, split and unified views, word-level changes, and
expandable context. [Servo](https://servo.org) renders the page offscreen, and each frame
goes to the terminal through the Kitty graphics protocol with shared memory
(`t=s`). The terminal code comes from [servo-term](https://github.com/a10y/servo-term).

Mouse and keyboard input go to the page, so you can click, scroll, and select.

## Build

```sh
(cd web && bun install && bun run build)   # the UI, embedded in the binary
cargo build --release                      # or: cargo install --path .
```

The first Rust build compiles Servo and takes a few minutes.

## Use

```sh
pdiff                 # uncommitted changes (or this branch vs its base if clean)
pdiff --staged        # HEAD -> index
pdiff --unstaged      # index -> working tree (includes untracked files)
pdiff --base [REF]    # this branch vs REF (default: origin/HEAD, main, master)
pdiff abc123          # one commit
pdiff A..B            # a range;  A...B compares from the merge base
pdiff --serve         # print a URL and serve the UI to a normal browser
```

Press `c` (or click the "Comparing" button) to choose another source: unstaged,
staged, all uncommitted, a base branch, one commit, a commit range
(shift-click two commits), or any revision range you type. Diffs of the working
tree and index reload when files change.

| Key | Action |
|---|---|
| `c` | Choose what to compare (`1`–`3` / `b` in the picker) |
| `1` `2` `3` `4` | Uncommitted / unstaged / staged / branch vs base |
| `j` `k` (`n` `p`) | Next / previous file |
| `s` | Split / unified |
| `w` | Wrap long lines |
| `t` | Dark / light theme |
| `x` / `X` | Collapse this file / all files |
| `e` | Show / hide the file tree |
| `/` | Filter files |
| `m` | Comment on the selected lines (or click the `+` in the gutter; drag it for a range) |
| `y` | Copy all comments as a Markdown prompt for an agent |
| `g` `G`, `d` `u`, space | Top / bottom, half page, page |
| `r` | Reload |
| `q`, Ctrl-Q, Ctrl-C | Quit |
| Ctrl-+ / Ctrl-- / Ctrl-0 | Zoom |

Settings (theme, layout, wrap) are saved in `~/.config/pdiff/prefs.json`.

## How it works

```
pdiff ──┬─ HTTP server on 127.0.0.1 (random port + token)
        │    /            embedded web UI (web/dist)
        │    /api/info    branch, refs, commits, change counts
        │    /api/diff    unified patch for a source (git diff ...)
        │    /api/file    file text at a rev, for "expand context"
        │    /api/comments      review comments (GET, or POST from the page)
        │    /api/comments.md   the comments as a Markdown prompt
        └─ Servo WebView ──frames──▶ Kitty graphics (t=s) ──▶ terminal
                         ◀──mouse/keys── terminal input
```

## Servo notes

- Servo turns off `adoptedStyleSheets` by default; pdiff turns it on (the
  renderer's styles need it).
- The renderer picks colors with CSS `light-dark()`, so the page asks pdiff
  (`/api/theme`) to set Servo's `prefers-color-scheme`.
- Servo does not support `overflow: scroll clip`; the page adds a CSS fix so
  split columns keep their width.
- The UI is one JS file. With code splitting, Servo sometimes stops loading
  the module graph at startup.

## Debugging

The log is `~/.cache/pdiff/pdiff.log` (`PDIFF_LOG` changes it). Page errors and
`console` output go there too. `PDIFF_DEBUG=1` logs HTTP requests.
`PDIFF_SNAPSHOT=frame.png` saves each frame (slow). `PDIFF_EVAL=file` runs the
JavaScript written to that file in the page and logs the result.
