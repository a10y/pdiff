//! A small HTTP server on 127.0.0.1 for the web UI: static files plus a git API.
//!
//! Every URL starts with a random token, so other local programs cannot
//! read the repo through this port.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use include_dir::{Dir, include_dir};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::git::{Repo, Source};

static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

pub struct Handle {
    /// Base URL of the UI, with the token and a trailing slash.
    pub base: String,
    /// Requests from the page to the terminal side.
    pub control: Arc<Control>,
}

/// Page-to-embedder messages (the page cannot reach Servo's embedder API).
#[derive(Default)]
pub struct Control {
    /// "dark" or "light": the page's theme, for prefers-color-scheme.
    pub theme: Mutex<Option<String>>,
    pub quit: AtomicBool,
}

pub fn start(repo: Repo, initial: Source) -> std::io::Result<Handle> {
    let server = Server::http("127.0.0.1:0").map_err(std::io::Error::other)?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let token = random_token();
    let base = format!("http://127.0.0.1:{port}/{token}/");
    let server = Arc::new(server);
    let control = Arc::new(Control::default());
    let ctx = Arc::new((repo, initial, format!("/{token}/"), control.clone()));
    // A few threads, so a slow git command does not block file loads.
    for _ in 0..4 {
        let server = server.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let (repo, initial, prefix, control) = &*ctx;
                handle(req, repo, initial, prefix, control);
            }
        });
    }
    Ok(Handle { base, control })
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .is_ok();
    if !ok {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        buf[..16].copy_from_slice(&t.as_nanos().to_le_bytes());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn query(url: &str) -> Vec<(String, String)> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    url::form_urlencoded::parse(q.as_bytes()).into_owned().collect()
}

fn param(q: &[(String, String)], k: &str) -> Option<String> {
    q.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone()).filter(|v| !v.is_empty())
}

fn source_from(q: &[(String, String)], initial: &Source) -> Source {
    match param(q, "mode") {
        Some(mode) => Source { mode, base: param(q, "base"), range: param(q, "range") },
        None => initial.clone(),
    }
}

fn handle(req: Request, repo: &Repo, initial: &Source, prefix: &str, control: &Control) {
    let url = req.url().to_string();
    if std::env::var_os("PDIFF_DEBUG").is_some() {
        eprintln!("http {}", url.split_once('/').map(|x| x.1).unwrap_or(&url).chars().take(160).collect::<String>());
    }
    let Some(rest) = url.strip_prefix(prefix) else {
        let _ = req.respond(Response::from_string("not found").with_status_code(404));
        return;
    };
    if *req.method() != Method::Get {
        let _ = req.respond(Response::from_string("method not allowed").with_status_code(405));
        return;
    }
    let path = rest.split('?').next().unwrap_or("");
    let q = query(rest);

    let json = |body: String| {
        Response::from_string(body)
            .with_header(header("Content-Type", "application/json"))
            .with_header(header("Cache-Control", "no-store"))
    };

    let resp = match path {
        "api/info" => json(serde_json::to_string(&repo.info(initial)).unwrap()),
        "api/diff" => json(serde_json::to_string(&repo.diff(&source_from(&q, initial))).unwrap()),
        "api/log" => {
            eprintln!("page {}: {}", param(&q, "kind").unwrap_or_default(), param(&q, "msg").unwrap_or_default());
            Response::from_string("")
        }
        "api/prefs" => json(load_prefs().to_string()),
        "api/prefs/set" => {
            let mut prefs = load_prefs();
            for (k, v) in &q {
                // Values arrive as JSON text; store them as JSON values.
                prefs[k] = serde_json::from_str(v).unwrap_or(serde_json::Value::String(v.clone()));
            }
            save_prefs(&prefs);
            json(prefs.to_string())
        }
        "api/theme" => {
            *control.theme.lock().unwrap() = param(&q, "t");
            Response::from_string("")
        }
        "api/quit" => {
            control.quit.store(true, Ordering::Relaxed);
            Response::from_string("")
        }
        "api/fingerprint" => Response::from_string(repo.fingerprint(&source_from(&q, initial)))
            .with_header(header("Cache-Control", "no-store")),
        "api/file" => {
            let rev = param(&q, "rev").unwrap_or_default();
            let file = param(&q, "path").unwrap_or_default();
            match repo.file(&rev, &file) {
                Some(bytes) => Response::from_data(bytes)
                    .with_header(header("Content-Type", "text/plain; charset=utf-8"))
                    .with_header(header("Cache-Control", "no-store")),
                None => Response::from_string("not found").with_status_code(404),
            }
        }
        _ => {
            let file = if path.is_empty() { "index.html" } else { path };
            match WEB.get_file(file) {
                Some(f) => Response::from_data(f.contents().to_vec())
                    .with_header(header("Content-Type", content_type(file)))
                    .with_header(header("Cache-Control", "max-age=3600")),
                None => Response::from_string("not found").with_status_code(404),
            }
        }
    };
    let _ = req.respond(resp);
}

/// UI settings (theme, layout) live in ~/.config/pdiff/prefs.json. Each run
/// uses a new port, so the page's own localStorage does not last.
fn prefs_path() -> std::path::PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::Path::new(&std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("pdiff/prefs.json")
}

fn load_prefs() -> serde_json::Value {
    std::fs::read_to_string(prefs_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn save_prefs(prefs: &serde_json::Value) {
    let path = prefs_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(prefs).unwrap_or_default());
}
