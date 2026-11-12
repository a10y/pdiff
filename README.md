# pdiff

A rich git diff viewer that runs inside your terminal, built on the [`@pierre/diffs`](https://diffs.com) renderer and drawn by [Servo](https://servo.org) through the Kitty graphics protocol. The UI is a copy of [DiffsHub](https://github.com/pierrecomputer/pierre/tree/main/apps/diffshub) (see `web/hub/`). You can comment on lines and copy the comments as a prompt for a coding agent. On Apple silicon Macs, install a prebuilt binary with `cargo binstall pdiff`. Elsewhere, `cargo install pdiff` builds from source, which needs [bun](https://bun.sh) on your PATH to compile the web UI. Then run `pdiff` in a git repo.

Every commit to `main` is released as the next `0.N.0` version, to GitHub releases and crates.io (see `.github/workflows/release.yml`). The version in `Cargo.toml` stays `0.0.0`; CI sets the real one.
