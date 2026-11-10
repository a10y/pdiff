// Rebuild when the bundled web UI changes (include_dir! does not track it).
fn main() {
    println!("cargo:rerun-if-changed=web/dist");
}
