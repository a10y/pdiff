//! pdiff: a rich git diff viewer inside the terminal.
//!
//! The UI is a web page (web/, built on @pierre/diffs) served from a local
//! HTTP server that also answers git queries. Servo renders the page
//! offscreen; each frame goes to the terminal through the Kitty graphics
//! protocol using POSIX shared memory (`t=s`). Mouse, keyboard and paste
//! input from the terminal go back to Servo.
//!
//! The terminal code comes from servo-term (https://github.com/a10y/servo-term).

mod git;
mod input;
mod review;
mod server;
mod term;

use std::cell::{Cell, RefCell};
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use dpi::PhysicalSize;
use euclid::Scale;
use servo::{
    Code, CreateNewWebViewRequest, Cursor, DeviceIntPoint, DeviceIntRect, DevicePoint, DeviceVector2D,
    EventLoopWaker, InputEvent, Key, KeyState, KeyboardEvent, Location, Modifiers, MouseButton,
    MouseButtonAction, MouseButtonEvent, MouseMoveEvent, NavigationRequest, Preferences, RenderingContext,
    Scroll, Servo, ServoBuilder, Theme, SoftwareRenderingContext, WebView, WebViewBuilder, WebViewDelegate,
};
use url::Url;

use input::{Ev, Parser};
use term::{Geom, Kitty};

const USAGE: &str = "\
pdiff: view git diffs in the terminal

Usage: pdiff [OPTIONS] [RANGE]

What to show (default: uncommitted changes, or the branch against its base
when the working tree is clean). You can change it in the viewer (press c).
  RANGE              A commit (abc123), a range (A..B), or a merge-base range (A...B)
  -u, --unstaged     Changes not yet staged (index -> working tree)
  -s, --staged       Staged changes (HEAD -> index)
  -a, --all          All uncommitted changes (HEAD -> working tree)
  -b, --base [REF]   This branch against REF (default: origin/HEAD, main or master)

Options:
  -C DIR             Run in DIR instead of the current directory
  --dpr F            Device pixels per CSS pixel (default: 2 on Retina, else 1)
  --scale F          Render at this fraction of the pane's pixel size (0.1-1.0)
  --serve            Do not open the viewer; print the URL and serve until Ctrl-C
  -h, --help         Show this help

Keys in the viewer: c compare, s split/unified, w wrap, t theme, j/k next/prev
file, x collapse file, e sidebar, / filter, r reload, q quit.";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

struct Opts {
    source: Option<git::Source>,
    dir: std::path::PathBuf,
    scale: f32,
    dpr: Option<f32>,
    serve: bool,
}

fn parse_opts() -> Result<Opts, String> {
    let mut opts = Opts { source: None, dir: ".".into(), scale: 1.0, dpr: None, serve: false };
    let src = |mode: &str| Some(git::Source { mode: mode.into(), base: None, range: None });
    let mut args = std::env::args().skip(1).peekable();
    while let Some(arg) = args.next() {
        let mut num = |name: &str| -> Result<f32, String> {
            args.next().and_then(|v| v.parse().ok()).ok_or_else(|| format!("{name} needs a number"))
        };
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "--scale" => opts.scale = num("--scale")?.clamp(0.1, 1.0),
            "--dpr" => opts.dpr = Some(num("--dpr")?),
            "--serve" => opts.serve = true,
            "-C" => opts.dir = args.next().ok_or("-C needs a directory")?.into(),
            "-u" | "--unstaged" => opts.source = src("unstaged"),
            "-s" | "--staged" | "--cached" => opts.source = src("staged"),
            "-a" | "--all" => opts.source = src("uncommitted"),
            "-b" | "--base" => {
                let base = args.next_if(|a| !a.starts_with('-'));
                opts.source = Some(git::Source { mode: "base".into(), base, range: None });
            }
            other if other.starts_with('-') => return Err(format!("unknown option: {other}\n\n{USAGE}")),
            range => {
                opts.source = Some(git::Source { mode: "range".into(), base: None, range: Some(range.into()) })
            }
        }
    }
    Ok(opts)
}

// ---------------------------------------------------------------------------
// Servo glue
// ---------------------------------------------------------------------------

struct Delegate {
    frame_ready: Cell<bool>,
    cursor: RefCell<Option<Cursor>>,
    /// The UI's origin; navigation elsewhere is blocked.
    base: String,
}

impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, _: WebView) {
        self.frame_ready.set(true);
    }
    fn request_navigation(&self, _: WebView, request: NavigationRequest) {
        let url = request.url.as_str();
        if url.starts_with(&self.base) {
            request.allow();
        } else {
            request.deny();
        }
    }
    fn notify_cursor_changed(&self, _: WebView, cursor: Cursor) {
        *self.cursor.borrow_mut() = Some(cursor);
    }
    fn request_create_new(&self, _: WebView, _: CreateNewWebViewRequest) {
        // No popups: dropping the request denies it.
    }
}

/// We poll Servo's event loop every couple of milliseconds, so wakeups are not needed.
#[derive(Clone)]
struct Waker;
impl EventLoopWaker for Waker {
    fn clone_box(&self) -> Box<dyn EventLoopWaker> {
        Box::new(Waker)
    }
    fn wake(&self) {}
}

/// Where Servo's log goes: $PDIFF_LOG, else ~/.cache/pdiff/pdiff.log.
fn log_path() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("PDIFF_LOG") {
        return p.into();
    }
    let home = std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into());
    let dir = std::path::Path::new(&home).join(".cache/pdiff");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("pdiff.log")
}

/// Send Servo's stderr logging to a file so it does not draw over the page.
fn redirect_stderr() {
    if let Ok(f) = OpenOptions::new().create(true).write(true).truncate(true).open(log_path()) {
        unsafe { libc::dup2(f.as_raw_fd(), libc::STDERR_FILENO) };
        std::mem::forget(f);
    }
}

/// CSS cursor name for OSC 22 (pointer shape).
fn css_cursor(c: &Cursor) -> &'static str {
    match c {
        Cursor::Pointer => "pointer",
        Cursor::Text | Cursor::VerticalText => "text",
        Cursor::Wait => "wait",
        Cursor::Progress => "progress",
        Cursor::Help => "help",
        Cursor::Crosshair => "crosshair",
        Cursor::Move | Cursor::AllScroll => "move",
        Cursor::NotAllowed | Cursor::NoDrop => "not-allowed",
        Cursor::Grab => "grab",
        Cursor::Grabbing => "grabbing",
        Cursor::EwResize | Cursor::EResize | Cursor::WResize | Cursor::ColResize => "ew-resize",
        Cursor::NsResize | Cursor::NResize | Cursor::SResize | Cursor::RowResize => "ns-resize",
        Cursor::NeswResize | Cursor::NeResize | Cursor::SwResize => "nesw-resize",
        Cursor::NwseResize | Cursor::NwResize | Cursor::SeResize => "nwse-resize",
        Cursor::Cell => "cell",
        Cursor::Copy => "copy",
        Cursor::Alias => "alias",
        Cursor::ZoomIn => "zoom-in",
        Cursor::ZoomOut => "zoom-out",
        Cursor::ContextMenu => "context-menu",
        Cursor::None => "none",
        Cursor::Default => "default",
    }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/// Device pixels per CSS pixel. Retina terminals have tall cells; use 2x there
/// so CSS pixels look normal.
fn dpr_for(geom: Geom, dpr_override: Option<f32>) -> f32 {
    dpr_override.unwrap_or(if geom.cell_h >= 26.0 { 2.0 } else { 1.0 })
}

struct App {
    dpr_override: Option<f32>,
    servo: Servo,
    ctx: Rc<SoftwareRenderingContext>,
    delegate: Rc<Delegate>,
    webview: WebView,
    geom: Geom,
    scale: f32,
    pixel_mouse: bool,
    render_size: (u32, u32),
    kitty: Kitty,
    dragging: bool,
    quit: bool,
    snapshot_path: Option<String>,
}

impl App {
    fn render_size_for(geom: Geom, scale: f32) -> (u32, u32) {
        let (w, h) = geom.view_px();
        (((w * scale) as u32).max(1), ((h * scale) as u32).max(1))
    }

    fn apply_geometry(&mut self, geom: Geom) {
        if geom == self.geom {
            return;
        }
        self.geom = geom;
        eprintln!("geometry {geom:?}");
        let (w, h) = Self::render_size_for(geom, self.scale);
        if (w, h) != self.render_size {
            self.render_size = (w, h);
            // WebView::resize resizes the shared RenderingContext too. Do not
            // call ctx.resize() first: Servo then skips the viewport update.
            self.webview.resize(PhysicalSize::new(w, h));
        }
        self.webview.set_hidpi_scale_factor(Scale::new(dpr_for(geom, self.dpr_override) * self.scale));
        self.kitty.clear();
        self.delegate.frame_ready.set(true);
    }

    // -- input --------------------------------------------------------------

    fn handle(&mut self, ev: Ev) {
        match ev {
            Ev::Key { key, mods } => self.on_key(key, mods),
            Ev::Paste(text) => {
                for c in text.chars() {
                    let key = match c {
                        '\n' | '\r' => Key::Named(servo::NamedKey::Enter),
                        '\t' => Key::Named(servo::NamedKey::Tab),
                        c => Key::Character(c.to_string()),
                    };
                    self.send_key(key, Modifiers::empty());
                }
            }
            Ev::Mouse { btn, x, y, press } => self.on_mouse(btn, x, y, press),
            Ev::Focus(focused) => self.webview.set_focused(focused),
            Ev::PixelMouse(on) => self.pixel_mouse = on,
            Ev::CellPx { w, h } if w > 0 && h > 0 => {
                let g = Geom { cell_w: w as f32, cell_h: h as f32, ..self.geom };
                self.apply_geometry(g);
            }
            Ev::TextAreaPx { .. } | Ev::CellPx { .. } => {}
            Ev::ImageReply { id, error } => self.kitty.on_reply(id, error),
        }
    }

    fn on_key(&mut self, key: Key, mods: Modifiers) {
        if mods.contains(Modifiers::CONTROL) {
            let ch = match &key {
                Key::Character(s) => s.to_lowercase(),
                _ => String::new(),
            };
            match ch.as_str() {
                "q" | "c" => return self.quit = true,
                "r" => return self.webview.reload(),
                "=" | "+" => return self.zoom(1.1),
                "-" => return self.zoom(1.0 / 1.1),
                "0" => return self.webview.set_page_zoom(1.0),
                _ => {}
            }
        }
        self.send_key(key, mods);
    }

    fn zoom(&self, factor: f32) {
        let wv = &self.webview;
        wv.set_page_zoom((wv.page_zoom() * factor).clamp(0.25, 5.0));
    }

    fn send_key(&self, key: Key, mods: Modifiers) {
        for state in [KeyState::Down, KeyState::Up] {
            self.webview.notify_input_event(InputEvent::Keyboard(KeyboardEvent::new_without_event(
                state,
                key.clone(),
                Code::Unidentified,
                Location::Standard,
                mods,
                false,
                false,
            )));
        }
    }

    fn on_mouse(&mut self, btn: u16, x: i32, y: i32, press: bool) {
        let g = self.geom;
        // Terminal pixel position (0-based).
        let (px, py) = if self.pixel_mouse {
            ((x - 1).max(0) as f32, (y - 1).max(0) as f32)
        } else {
            (((x - 1) as f32 + 0.5) * g.cell_w, ((y - 1) as f32 + 0.5) * g.cell_h)
        };
        let motion = btn & 32 != 0;
        let wheel = btn & 64 != 0;
        let button = btn & 3;
        // Shift is bit 2 of the SGR button code.
        let shift = btn & 4 != 0;

        let (vw, vh) = g.view_px();
        let point = DevicePoint::new(px.clamp(0.0, vw - 1.0) * self.scale, py.clamp(0.0, vh - 1.0) * self.scale);
        let wv = self.webview.clone();

        if wheel {
            let step = 3.0 * g.cell_h * self.scale;
            let (dx, dy) = match button {
                0 if shift => (-step, 0.0),
                1 if shift => (step, 0.0),
                0 => (0.0, -step),
                1 => (0.0, step),
                2 => (-step, 0.0),
                _ => (step, 0.0),
            };
            wv.notify_scroll_event(Scroll::Delta(DeviceVector2D::new(dx, dy).into()), point.into());
            return;
        }

        if motion {
            wv.notify_input_event(InputEvent::MouseMove(MouseMoveEvent::new(point.into())));
            return;
        }

        let mouse_button = match button {
            0 => MouseButton::Primary,
            1 => MouseButton::Auxiliary,
            _ => MouseButton::Secondary,
        };
        let action = if press { MouseButtonAction::Down } else { MouseButtonAction::Up };
        self.dragging = press;
        if press {
            wv.set_focused(true);
            wv.notify_input_event(InputEvent::MouseMove(MouseMoveEvent::new(point.into())));
        }
        // Shift-click: hold Shift around the click so the page sees `event.shiftKey`.
        if shift && press {
            self.send_modifier(KeyState::Down);
        }
        wv.notify_input_event(InputEvent::MouseButton(MouseButtonEvent::new(action, mouse_button, point.into())));
        if shift && !press {
            self.send_modifier(KeyState::Up);
        }
    }

    fn send_modifier(&self, state: KeyState) {
        self.webview.notify_input_event(InputEvent::Keyboard(KeyboardEvent::new_without_event(
            state,
            Key::Named(servo::NamedKey::Shift),
            Code::ShiftLeft,
            Location::Left,
            if state == KeyState::Down { Modifiers::SHIFT } else { Modifiers::empty() },
            false,
            false,
        )));
    }

    // -- output -------------------------------------------------------------

    fn paint_frame(&mut self) {
        // While the terminal is still reading the last frame, keep `frame_ready`
        // set and paint the newest frame when it is done. Frames in between drop.
        if !self.delegate.frame_ready.get() || !self.kitty.ready() {
            return;
        }
        self.delegate.frame_ready.set(false);
        let (w, h) = self.render_size;
        self.webview.paint();
        let rect = DeviceIntRect::new(DeviceIntPoint::origin(), DeviceIntPoint::new(w as i32, h as i32));
        if let Some(img) = self.ctx.read_to_image(rect) {
            self.ctx.present();
            if let Err(e) = self.kitty.show(&img, self.geom) {
                eprintln!("kitty output error: {e}");
            }
            // Debug aid: PDIFF_SNAPSHOT=path.png saves every frame (slow).
            if let Some(path) = &self.snapshot_path {
                let _ = img.save(path);
            }
        }
    }

    fn draw_cursor(&mut self) {
        if let Some(cursor) = self.delegate.cursor.borrow_mut().take() {
            let mut stdout = io::stdout().lock();
            let _ = write!(stdout, "\x1b]22;{}\x1b\\", css_cursor(&cursor));
            let _ = stdout.flush();
        }
    }
}

fn main() {
    let opts = match parse_opts() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("pdiff: {e}");
            std::process::exit(2);
        }
    };
    let repo = match git::Repo::discover(&opts.dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("pdiff: not in a git repository: {e}");
            std::process::exit(1);
        }
    };
    let initial = opts.source.clone().unwrap_or_else(|| repo.auto_source());
    let handle = server::start(repo, initial).expect("could not start the local server");

    if opts.serve {
        println!("{}", handle.base);
        loop {
            std::thread::park();
        }
    }

    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    redirect_stderr();

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        term::leave();
        default_hook(info);
    }));

    term::enter();
    let (geom, pixel_mouse) = term::query(term::ioctl_geom(None));
    let dpr = dpr_for(geom, opts.dpr);
    eprintln!("geometry {geom:?} pixel_mouse={pixel_mouse} dpr={dpr} url={}", handle.base);

    let winch = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGWINCH, winch.clone()).unwrap();
    let term_signal = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, term_signal.clone()).unwrap();
    signal_hook::flag::register(signal_hook::consts::SIGHUP, term_signal.clone()).unwrap();

    // Input thread: read stdin, parse, forward events to the main thread.
    let (tx, rx) = mpsc::channel::<Ev>();
    std::thread::spawn(move || {
        let mut parser = Parser::default();
        let mut buf = [0u8; 8192];
        let mut events = Vec::new();
        loop {
            let mut pfd = libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 };
            let timeout = if parser.pending() { 25 } else { 500 };
            let r = unsafe { libc::poll(&mut pfd, 1, timeout) };
            if r > 0 {
                let n = unsafe { libc::read(libc::STDIN_FILENO, buf.as_mut_ptr().cast(), buf.len()) };
                if n <= 0 {
                    return;
                }
                parser.feed(&buf[..n as usize], &mut events);
            } else if r == 0 && parser.pending() {
                parser.flush(&mut events);
            }
            for ev in events.drain(..) {
                if tx.send(ev).is_err() {
                    return;
                }
            }
        }
    });

    let scale = opts.scale;
    let (w, h) = App::render_size_for(geom, scale);
    let ctx = Rc::new(
        SoftwareRenderingContext::new(PhysicalSize::new(w, h)).expect("could not create SoftwareRenderingContext"),
    );
    ctx.make_current().expect("make_current failed");

    // Web features the diff renderer uses that Servo leaves off by default.
    let mut prefs = Preferences::default();
    let off = std::env::var("PDIFF_PREFS_OFF").unwrap_or_default();
    let on = |name: &str| !off.split(',').any(|o| o == name || o == "all");
    prefs.dom_adoptedstylesheet_enabled = on("adopted");
    prefs.dom_intersection_observer_enabled = on("io");
    prefs.dom_resize_observer_enabled = true;
    prefs.dom_fontface_enabled = on("fontface");
    prefs.layout_css_container_queries_enabled = on("cq");
    prefs.layout_css_columns_enabled = on("columns");
    let servo = ServoBuilder::default()
        .preferences(prefs)
        .event_loop_waker(Box::new(Waker))
        .build();
    let delegate = Rc::new(Delegate {
        frame_ready: Cell::new(false),
        cursor: RefCell::new(None),
        base: handle.base.clone(),
    });
    let url = Url::parse(&format!("{}?embed=1", handle.base)).unwrap();
    let webview = WebViewBuilder::new(&servo, ctx.clone())
        .url(url)
        .hidpi_scale_factor(Scale::new(dpr * scale))
        .delegate(delegate.clone())
        .build();
    webview.set_focused(true);

    let mut app = App {
        dpr_override: opts.dpr,
        servo,
        ctx,
        delegate,
        webview,
        geom,
        scale,
        pixel_mouse,
        render_size: (w, h),
        kitty: Kitty::default(),
        dragging: false,
        quit: false,
        snapshot_path: std::env::var("PDIFF_SNAPSHOT").ok(),
    };

    let eval_path = std::env::var_os("PDIFF_EVAL");
    while !app.quit && !term_signal.load(Ordering::Relaxed) {
        if winch.swap(false, Ordering::Relaxed) {
            let g = term::ioctl_geom(Some(app.geom));
            app.apply_geometry(g);
            term::request_cell_size();
        }

        // Wait briefly for input so typing feels instant without busy-waiting.
        if let Ok(ev) = rx.recv_timeout(Duration::from_millis(2)) {
            app.handle(ev);
            while let Ok(ev) = rx.try_recv() {
                app.handle(ev);
            }
        }

        // The page cannot set prefers-color-scheme; the diff renderer's
        // colors (CSS light-dark()) follow it, so the page asks us.
        if let Some(theme) = handle.control.theme.lock().unwrap().take() {
            app.webview.notify_theme_change(if theme == "light" { Theme::Light } else { Theme::Dark });
        }
        if handle.control.quit.load(Ordering::Relaxed) {
            break;
        }
        // Debug aid: PDIFF_EVAL=file runs the JavaScript written to that file
        // and logs the result.
        if let Some(path) = &eval_path {
            if let Ok(js) = std::fs::read_to_string(path) {
                let _ = std::fs::remove_file(path);
                app.webview.evaluate_javascript(js, |r| eprintln!("eval: {r:?}"));
            }
        }
        app.servo.spin_event_loop();
        app.paint_frame();
        app.draw_cursor();
    }

    app.kitty.discard_in_flight();
    term::leave();
}
