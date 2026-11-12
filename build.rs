//! Builds the web UI with bun and leaves it in $OUT_DIR/web/dist, which
//! src/server.rs embeds with include_dir!. The sources are copied into
//! OUT_DIR first so the build never writes into the source tree (a
//! `cargo install --git` checkout, or a published crate, is read-only in spirit).

use std::path::Path;
use std::process::Command;
use std::{env, fs, io};

fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").unwrap();
    let src = Path::new(&manifest).join("web");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("web");

    for p in ["src", "hub", "package.json", "bun.lock", "tsconfig.json", "build-hub.sh"] {
        println!("cargo:rerun-if-changed=web/{p}");
    }

    // Refresh the copied sources but keep node_modules between builds.
    fs::create_dir_all(&out).unwrap();
    for entry in fs::read_dir(&src).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        if name == "node_modules" || name == "dist" {
            continue;
        }
        let dst = out.join(&name);
        if dst.is_dir() {
            fs::remove_dir_all(&dst).unwrap();
        }
        copy(&entry.path(), &dst).unwrap();
    }

    bun(&out, &["install", "--frozen-lockfile"]);
    bun(&out, &["run", "build"]);
}

fn bun(dir: &Path, args: &[&str]) {
    let status = Command::new("bun").args(args).current_dir(dir).status().unwrap_or_else(|e| {
        panic!("could not run `bun` ({e}); install it from https://bun.sh to build pdiff's web UI")
    });
    assert!(status.success(), "`bun {}` failed in {}", args.join(" "), dir.display());
}

fn copy(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}
