# `pdiff wait`: send review comments to an agent

Status: not started (on hold, 2026-11-10)

## Goal

Make a live review loop with a coding agent. You comment on lines in pdiff
and push "Send". The agent gets the comments, makes the fixes, and waits for
the next round. You do not copy or paste anything.

```
agent ── pdiff wait ──(waits)──▶ you comment, push Send ──▶ Markdown on stdout ──▶ agent fixes ──┐
  ▲                                                                                                │
  └──────────────────────────────────── loop ◀─────────────────────────────────────────────────────┘
```

## What exists now

- Line comments in the UI (`web/src/main.ts`, "Review comments" section).
- The page POSTs the full comment list to `api/comments` after each change.
- The server keeps the list in `Control::review` (`src/server.rs`).
- `src/review.rs` formats the list as a Markdown prompt (`Review::to_markdown`).
- `GET api/comments.md` returns that prompt. Key `y` copies it to the clipboard.

## Plan

1. **Discovery file.** At start-up, write `.git/pdiff/server.json` with
   `{ "url": "<base url with token>", "pid": <pid> }`. Remove it on exit.
   Use the git dir (`git rev-parse --git-dir`), so worktrees each get their own.
   Ignore a file whose pid is not alive.
2. **Send in the UI.** Add a "Send to agent" button and a key. It POSTs
   `api/comments/send`. The server moves the current comments into a "sent"
   batch and wakes waiters. The page clears the comments (or marks them as
   sent) and shows a toast.
3. **Long-poll route.** `GET api/comments/wait` blocks until there is a batch
   that was not delivered, then returns it as Markdown. Use a `Condvar` next
   to `Control::review`. The server has only 4 threads, so add a timeout
   (for example 30 s) and let the client poll again.
4. **CLI.** `pdiff wait [--timeout SECS]` reads the discovery file, calls the
   wait route in a loop, prints the Markdown to stdout, and exits 0. If no
   pdiff runs, print an error and exit with a non-zero code.
5. **Agent instructions.** Add a short README section (and maybe a skill)
   that tells the agent: run `pdiff wait` in the background, fix each
   comment, then run it again. Claude Code's Bash tool stops after 10 min,
   so the agent must use `run_in_background` or call it again after a timeout.

## Open questions

- After Send, should comments stay on screen as "sent" until the lines
  change, or go away at once?
- Do we let the agent reply on a comment (for example "done" or a question)?
  That needs a route for the agent to POST replies, which the page shows.
- Can line numbers drift after the agent edits a file? The diff reloads, so
  old comments can point to the wrong line. Maybe clear sent comments when the
  diff reloads.

## Other option (not chosen)

Type the comments into the agent's Rex pane with `rex`. It feels more live,
but it works only in Rex and can break if the agent is busy.
