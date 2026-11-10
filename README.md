# pdiff

A rich git diff viewer that runs inside your terminal, built on the [`@pierre/diffs`](https://diffs.com) renderer and drawn by [Servo](https://servo.org) through the Kitty graphics protocol. You can comment on lines and copy the comments as a prompt for a coding agent. Build with `(cd web && bun install && bun run build) && cargo install --path .`, then run `pdiff` in a git repo.
