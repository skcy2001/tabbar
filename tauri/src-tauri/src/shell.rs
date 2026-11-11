use super::*;
use model::Side;
use tauri::{PhysicalPosition, PhysicalSize, Window, WindowEvent};

const SLIDE_DURATION: Duration = Duration::from_millis(300);
const PLAYER_WIDTH: f64 = 300.;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}
impl Rect {
    pub fn contains(self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w as i32 && y < self.y + self.h as i32
    }
}
pub struct State {
    pub visible: bool,
    pub manual_hidden: bool,
    pub dragging: bool,
    pub hold_until: Instant,
    pub player_hide: Option<Instant>,
    pub player_anchor_y: Option<i32>,
    pub player_height: f64,
    pub player_animation: u64,
    pub reservation: Option<Rect>,
    pub ribbon: Rect,
    pub pane: Rect,
    pub monitor_bounds: Rect,
    pub slide_offset: i32,
    pub clipped: bool,
    pub edge_since: Option<Instant>,
    pub outside_since: Option<Instant>,
    pub laying_out: bool,
    pub animating: bool,
    pub animation: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            visible: true,
            manual_hidden: false,
            dragging: false,
            hold_until: Instant::now() + Duration::from_secs(3),
            player_hide: None,
            player_anchor_y: None,
            player_height: 248.,
            player_animation: 0,
            reservation: None,
            ribbon: Rect::default(),
            pane: Rect::default(),
            monitor_bounds: Rect::default(),
            slide_offset: 0,
            clipped: false,
            edge_since: None,
            outside_since: None,
            laying_out: false,
            animating: false,
            animation: 0,
        }
    }
}
fn state<T>(app: &AppHandle, f: impl FnOnce(&mut State) -> T) -> T {
    f(&mut app.state::<Runtime>().shell.lock().unwrap())
}
pub fn window(app: &AppHandle, label: &str) -> Result<Window> {
    app.get_window(label)
        .ok_or_else(|| format!("Missing {label} window"))
}
pub fn create(app: &AppHandle) -> Result<()> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(err)?
        .join("webview");
    fs::create_dir_all(&data).map_err(err)?;
    for (label, width, height) in [
        ("ribbon", 56., 800.),
        ("pane", 368., 800.),
        ("player", PLAYER_WIDTH, 248.),
        ("downloads", 360., 420.),
    ] {
        let w = tauri::window::WindowBuilder::new(app, label)
            .title(format!("Tabbar — {label}"))
            .inner_size(width, height)
            .decorations(false)
            // Tao's default undecorated shadow adds non-client insets. Docked
            // windows must fill exactly the physical rectangle reserved for them.
            .shadow(label == "player")
            .resizable(false)
            .focusable(label != "player")
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(err)?;
        let dev = app.config().build.dev_url.clone();
        let builder = WebviewBuilder::new(
            label,
            WebviewUrl::App(format!("index.html?role={label}").into()),
        )
        .data_directory(data.clone())
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (url.scheme() == "http"
                    && url.host_str() == Some("tauri.localhost")
                    && url.port().is_none());
            matches!(url.path(), "/" | "/index.html")
                && (packaged
                    || (cfg!(dev) && dev.as_ref().is_some_and(|d| d.origin() == url.origin())))
        });
        w.add_child(
            builder,
            LogicalPosition::new(0., 0.),
            LogicalSize::new(width, height),
        )
        .map_err(err)?;
        if label == "player" {
            native::preview_window(&w)?;
        } else {
            native::flat_window(&w)?;
        }
    }
    Ok(())
}
fn set_rect(w: &Window, r: Rect) -> Result<()> {
    let size = PhysicalSize::new(r.w.max(1), r.h.max(1));
    let pos = PhysicalPosition::new(r.x, r.y);
    if w.outer_position().map_err(err)? != pos {
        w.set_position(pos).map_err(err)?;
    }
    if w.inner_size().map_err(err)? != size {
        w.set_size(size).map_err(err)?;
    }
    if let Some(v) = w.app_handle().get_webview(w.label()) {
        v.set_size(size).map_err(err)?;
    }
    Ok(())
}
fn monitor(app: &AppHandle) -> Result<tauri::Monitor> {
    let w = window(app, "ribbon")?;
    let name = snapshot(app).settings.monitor;
    let all = w.available_monitors().map_err(err)?;
    all.into_iter()
        .find(|m| name.as_ref().is_some_and(|n| m.name() == Some(n)))
        .or(w.current_monitor().map_err(err)?)
        .or(w.primary_monitor().map_err(err)?)
        .ok_or_else(|| "No display available".into())
}
// Placement and animation frames share the UI thread. A background layout can
// otherwise enqueue a stale position after an animation frame has moved it.
fn on_ui(
    app: &AppHandle,
    operation: impl FnOnce(&AppHandle) -> Result<()> + Send + 'static,
) -> Result<()> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = operation(&handle) {
            report(&handle, error);
        }
    })
    .map_err(err)
}
pub fn layout(app: &AppHandle) -> Result<()> {
    on_ui(app, layout_now)
}
fn layout_now(app: &AppHandle) -> Result<()> {
    if state(app, |s| {
        if s.laying_out || s.animating {
            true
        } else {
            s.laying_out = true;
            false
        }
    }) {
        return Ok(());
    }
    let result = layout_inner(app);
    state(app, |s| s.laying_out = false);
    result
}
fn layout_inner(app: &AppHandle) -> Result<()> {
    let s = snapshot(app);
    let mon = monitor(app)?;
    let scale = mon.scale_factor();
    let area = mon.work_area();
    let mut area = Rect {
        x: area.position.x,
        y: area.position.y,
        w: area.size.width,
        h: area.size.height,
    };
    if let Some(old) = state(app, |s| s.reservation) {
        if old.y == area.y {
            if old.x + old.w as i32 == area.x {
                area.x -= old.w as i32;
                area.w += old.w;
            } else if old.x == area.x + area.w as i32 {
                area.w += old.w;
            }
        }
    }
    let monitor_bounds = Rect {
        x: mon.position().x,
        y: mon.position().y,
        w: mon.size().width,
        h: mon.size().height,
    };
    // Fullscreen uses the physical display edge, including the taskbar area.
    // The ribbon overlays the page instead of reserving or taking its space.
    if s.fullscreen {
        area = monitor_bounds;
    }
    let rw = (model::RIBBON * scale).round() as u32;
    let pw = ((s
        .tabs
        .iter()
        .find(|t| Some(t.id) == s.active)
        .map(|t| t.expanded_width)
        .unwrap_or(s.settings.pane_width)
        + 4.)
        * scale)
        .round() as u32;
    let pw = pw.min(area.w.saturating_sub(rw));
    let mut ribbon = Rect {
        x: if s.settings.side == Side::Left {
            area.x
        } else {
            area.x + area.w as i32 - rw as i32
        },
        y: area.y,
        w: rw,
        h: area.h,
    };
    let visible = state(app, |s| s.visible);
    if s.settings.pinned && !s.fullscreen && !state(app, |s| s.manual_hidden) {
        let old = state(app, |s| s.reservation);
        if old != Some(ribbon) {
            ribbon = native::reserve(
                &window(app, "ribbon")?,
                ribbon,
                s.settings.side,
                old.is_none(),
            )?;
            state(app, |s| s.reservation = Some(ribbon));
        }
    } else {
        unreserve(app);
    }
    let pane = Rect {
        x: if s.settings.side == Side::Left {
            ribbon.x + rw as i32
        } else {
            ribbon.x - pw as i32
        },
        y: ribbon.y,
        w: pw,
        h: ribbon.h,
    };
    state(app, |s| {
        s.ribbon = ribbon;
        s.pane = pane;
        s.monitor_bounds = monitor_bounds;
    });
    let rw = window(app, "ribbon")?;
    let pw = window(app, "pane")?;
    set_rect(&rw, ribbon)?;
    if !s.fullscreen {
        set_rect(&pw, pane)?;
    }
    let clipped = state(app, |s| s.clipped);
    if clipped {
        for label in ["ribbon", "pane"] {
            if let Some(v) = app.get_webview(label) {
                v.set_position(PhysicalPosition::new(0, 0)).map_err(err)?;
            }
        }
    }
    layout_views(app)?;
    if clipped {
        native::clear_clip(&rw)?;
        native::clear_clip(&pw)?;
        state(app, |s| {
            s.clipped = false;
            s.slide_offset = 0;
        });
    }
    set_visible(
        &pw,
        !s.collapsed && (visible || (s.fullscreen && !state(app, |s| s.manual_hidden))),
    )?;
    if s.fullscreen && visible {
        // Fullscreen and the ribbon are both topmost windows. Keep the popup
        // above the page without activating it or interrupting playback.
        native::show_overlay(&rw)
    } else {
        set_visible(&rw, visible)
    }
}
fn set_visible(w: &Window, visible: bool) -> Result<()> {
    if w.is_visible().map_err(err)? != visible {
        if w.label() == "ribbon" {
            if visible {
                native::show_overlay(w)?;
            } else {
                native::hide_overlay(w)?;
            }
        } else if visible {
            w.show().map_err(err)?;
        } else {
            w.hide().map_err(err)?;
        }
    }
    Ok(())
}
pub fn layout_views(app: &AppHandle) -> Result<()> {
    let s = snapshot(app);
    let w = window(app, "pane")?;
    let scale = w.scale_factor().map_err(err)?;
    let size = w.inner_size().map_err(err)?.to_logical::<f64>(scale);
    if let Some(v) = app.get_webview("pane") {
        v.set_size(size).map_err(err)?;
    }
    for t in &s.tabs {
        if let Ok(v) = view(app, t.id) {
            if s.collapsed || s.active != Some(t.id) {
                v.hide().map_err(err)?;
            } else {
                let x = if s.settings.side == Side::Right && !s.fullscreen {
                    4.
                } else {
                    0.
                };
                let top = if s.html_fullscreen { 0. } else { 44. };
                v.set_position(LogicalPosition::new(x, top)).map_err(err)?;
                v.set_size(LogicalSize::new(
                    (size.width - if s.fullscreen { 0. } else { 4. }).max(1.),
                    (size.height - top).max(1.),
                ))
                .map_err(err)?;
                v.show().map_err(err)?;
            }
        }
    }
    Ok(())
}
pub fn unreserve(app: &AppHandle) {
    if state(app, |s| s.reservation.take()).is_some() {
        if let Ok(w) = window(app, "ribbon") {
            native::unreserve(&w);
        }
    }
}
pub fn touch(app: &AppHandle, for_time: Duration) {
    state(app, |s| {
        s.hold_until = Instant::now() + for_time;
        s.outside_since = None;
    });
}
pub fn show(app: &AppHandle) -> Result<()> {
    on_ui(app, show_now)
}
fn show_now(app: &AppHandle) -> Result<()> {
    let (was_visible, animating) = state(app, |s| {
        s.manual_hidden = false;
        (s.visible, s.animating)
    });
    // Let the reveal settle without keeping a collapsed ribbon onscreen for seconds.
    touch(app, SLIDE_DURATION);
    if was_visible {
        // A second hover/show request must not restart an in-flight reveal.
        return layout_now(app);
    }
    if !animating {
        // Calculate the dock and size the windows while they are still hidden.
        // Showing at the dock before moving offscreen causes a one-frame flash.
        layout_now(app)?;
    }
    animate(app, true, animating)
}
pub fn hide(app: &AppHandle, manual: bool) -> Result<()> {
    on_ui(app, move |app| {
        let (visible, animating) = state(app, |s| {
            s.manual_hidden = manual;
            (s.visible, s.animating)
        });
        close_player(app);
        set_visible(&window(app, "downloads")?, false)?;
        if manual {
            state(app, |s| {
                s.visible = false;
                s.animating = false;
                s.animation += 1;
            });
            unreserve(app);
            for label in ["ribbon", "pane"] {
                set_visible(&window(app, label)?, false)?;
            }
            return Ok(());
        }
        if !visible {
            return Ok(());
        }
        animate(app, false, animating)
    })
}
fn slide_frame(app: &AppHandle, r: Rect, p: Rect, bounds: Rect, offset: i32) -> Result<()> {
    let ribbon = model::slide_frame(r.x, r.w, offset, bounds.x, bounds.w);
    let rw = window(app, "ribbon")?;
    if snapshot(app).fullscreen {
        // The fullscreen page must never move, resize, or receive a clip while
        // the independent ribbon slides across it.
        if let Some(v) = app.get_webview("ribbon") {
            v.set_position(PhysicalPosition::new(ribbon.content_x, 0))
                .map_err(err)?;
        }
        native::clip_window(&rw, ribbon.clip_x, ribbon.clip_width, r.h)?;
        state(app, |s| s.slide_offset = offset);
        return Ok(());
    }
    let pane = model::slide_frame(p.x, p.w, offset, bounds.x, bounds.w);
    let pw = window(app, "pane")?;
    // Both native rectangles remain entirely on the original display. Regions
    // crop the moving contents, including WebView2's composited website views.
    native::move_pair(&rw, &pw, ribbon.window_x, pane.window_x, r.y)?;
    for (label, shift) in [("ribbon", ribbon.content_x), ("pane", pane.content_x)] {
        if let Some(v) = app.get_webview(label) {
            v.set_position(PhysicalPosition::new(shift, 0))
                .map_err(err)?;
        }
    }
    let s = snapshot(app);
    if let Some(id) = s.active {
        if let Ok(v) = view(app, id) {
            let scale = pw.scale_factor().map_err(err)?;
            let x = if s.settings.side == Side::Right {
                4.
            } else {
                0.
            };
            v.set_position(PhysicalPosition::new(
                (x * scale).round() as i32 + pane.content_x,
                (44. * scale).round() as i32,
            ))
            .map_err(err)?;
        }
    }
    native::clip_window(&rw, ribbon.clip_x, ribbon.clip_width, r.h)?;
    native::clip_window(&pw, pane.clip_x, pane.clip_width, p.h)?;
    state(app, |s| s.slide_offset = offset);
    Ok(())
}
fn animate(app: &AppHandle, showing: bool, reversing: bool) -> Result<()> {
    let s = snapshot(app);
    let (r, p, bounds) = state(app, |s| (s.ribbon, s.pane, s.monitor_bounds));
    let rw = window(app, "ribbon")?;
    let pw = window(app, "pane")?;
    let fullscreen = s.fullscreen;
    let distance = (r.w + if s.collapsed || fullscreen { 0 } else { p.w }) as i32;
    let hidden_offset = if s.settings.side == Side::Left {
        -distance
    } else {
        distance
    };
    let from = if reversing {
        state(app, |s| s.slide_offset)
    } else if showing {
        hidden_offset
    } else {
        0
    };
    let to = if showing { 0 } else { hidden_offset };
    let generation = state(app, |s| {
        s.visible = showing;
        s.animating = true;
        s.animation += 1;
        s.clipped = true;
        s.edge_since = None;
        s.outside_since = None;
        s.animation
    });
    // Apply the starting clip before showing either native window.
    let prepared = (|| {
        slide_frame(app, r, p, bounds, from)?;
        if showing {
            set_visible(&rw, true)?;
            if !fullscreen {
                set_visible(&pw, !s.collapsed)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = prepared {
        state(app, |s| s.animating = false);
        let _ = layout_now(app);
        return Err(error);
    }
    let start = Instant::now();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            // Follow compositor frames instead of coarse Windows sleep timers.
            // Await each UI update: slow frames cannot build up a queue of jumps.
            native::wait_for_frame();
            let (send, recv) = std::sync::mpsc::sync_channel(1);
            let handle = app.clone();
            let rw = rw.clone();
            let pw = pw.clone();
            if app
                .run_on_main_thread(move || {
                    if state(&handle, |s| s.animation != generation) {
                        let _ = send.send(false);
                        return;
                    }
                    let progress =
                        (start.elapsed().as_secs_f64() / SLIDE_DURATION.as_secs_f64()).min(1.);
                    let eased = 1. - (1. - progress).powi(4);
                    let offset = (from as f64 + (to - from) as f64 * eased).round() as i32;
                    let result = slide_frame(&handle, r, p, bounds, offset);
                    if let Err(error) = result {
                        state(&handle, |s| s.animating = false);
                        report(&handle, error);
                        let _ = layout_now(&handle);
                        let _ = send.send(false);
                        return;
                    }
                    if progress >= 1. {
                        if !showing {
                            let _ = set_visible(&rw, false);
                            if !fullscreen {
                                let _ = set_visible(&pw, false);
                            }
                        }
                        state(&handle, |s| s.animating = false);
                        let _ = layout_now(&handle);
                    }
                    let _ = send.send(progress < 1.);
                })
                .is_err()
            {
                break;
            }
            if !recv.recv().unwrap_or(false) {
                break;
            }
        }
    });
    Ok(())
}
pub fn dragging(app: &AppHandle, dragging: bool) {
    state(app, |s| s.dragging = dragging);
    touch(app, Duration::from_millis(600));
}
pub fn place(app: &AppHandle, x: f64, y: f64) -> Result<()> {
    // JS screen coordinates are logical. The native cursor is authoritative across mixed-DPI displays.
    let (x, y) = native::cursor().unwrap_or((x.round() as i32, y.round() as i32));
    let monitors = window(app, "ribbon")?.available_monitors().map_err(err)?;
    if let Some(m) = monitors.into_iter().min_by_key(|m| {
        let p = m.position();
        let z = m.size();
        let dx = (x - p.x).clamp(0, z.width as i32);
        let dy = (y - p.y).clamp(0, z.height as i32);
        (x - p.x - dx).abs() as i64 + (y - p.y - dy).abs() as i64
    }) {
        unreserve(app);
        edit(app, |b| {
            b.state.settings.side = if x < m.position().x + m.size().width as i32 / 2 {
                Side::Left
            } else {
                Side::Right
            };
            b.state.settings.monitor = m.name().cloned();
        });
    }
    dragging(app, false);
    show(app)
}
pub fn fullscreen(app: &AppHandle, enter: bool) -> Result<()> {
    if snapshot(app).fullscreen == enter {
        return layout(app);
    }
    state(app, |s| {
        s.animation += 1;
        s.animating = false;
        s.visible = !enter;
        s.manual_hidden = false;
        s.edge_since = None;
        s.outside_since = None;
    });
    edit(app, |b| {
        b.state.fullscreen = enter;
        if enter {
            b.state.collapsed = false;
        }
    });
    close_player(app);
    if enter {
        unreserve(app);
    }
    window(app, "pane")?.set_fullscreen(enter).map_err(err)?;
    touch(app, Duration::from_secs(1));
    layout(app)
}
fn popup_position(app: &AppHandle, label: &str, y: f64) -> Result<()> {
    let w = window(app, label)?;
    let m = monitor(app)?;
    let area = m.work_area();
    let size = w.inner_size().map_err(err)?;
    let r = state(app, |s| s.ribbon);
    let left = snapshot(app).settings.side == Side::Left;
    let x = if left {
        r.x + r.w as i32 + 6
    } else {
        r.x - size.width as i32 - 6
    };
    let y = (y * m.scale_factor()).round() as i32;
    w.set_position(PhysicalPosition::new(
        x.clamp(
            area.position.x,
            (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x),
        ),
        y.clamp(
            area.position.y,
            (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y),
        ),
    ))
    .map_err(err)
}
pub fn show_player(app: &AppHandle, a: &Value) -> Result<()> {
    let id = id(a)?;
    if !snapshot(app).tabs.iter().any(|t| t.id == id && t.has_media) {
        return Ok(());
    }
    edit(app, |b| b.state.player_target = Some(id));
    state(app, |s| s.player_hide = None);
    touch(app, Duration::from_millis(400));
    let anchor_top = a["anchorTop"].as_f64();
    let anchor_height = a["anchorHeight"].as_f64().unwrap_or(24.);
    on_ui(app, move |app| {
        if snapshot(app).player_target != Some(id) {
            return Ok(());
        }
        let ribbon = window(app, "ribbon")?;
        let anchor_y = if let Some(top) = anchor_top {
            ribbon.outer_position().map_err(err)?.y
                + ((top + anchor_height / 2.) * ribbon.scale_factor().map_err(err)?).round() as i32
        } else {
            native::cursor().map(|(_, y)| y).unwrap_or(0)
        };
        state(app, |s| s.player_anchor_y = Some(anchor_y));
        reveal_player(app)
    })
}
fn player_position(app: &AppHandle) -> Result<PhysicalPosition<i32>> {
    let w = window(app, "player")?;
    let mon = monitor(app)?;
    let area = mon.work_area();
    // Establish the correct DPI while hidden before measuring its native frame.
    if w.current_monitor()
        .map_err(err)?
        .as_ref()
        .and_then(|m| m.name())
        != mon.name()
    {
        native::hide_overlay(&w)?;
        w.set_position(PhysicalPosition::new(
            area.position.x + 32,
            area.position.y + 32,
        ))
        .map_err(err)?;
    }
    let height = state(app, |s| s.player_height);
    w.set_size(LogicalSize::new(PLAYER_WIDTH, height))
        .map_err(err)?;
    // Child webviews do not automatically follow a native window's DPI change.
    // Refit the preview after moving between monitors with different scaling.
    if let Some(v) = app.get_webview("player") {
        v.set_size(w.inner_size().map_err(err)?).map_err(err)?;
    }
    let size = w.outer_size().map_err(err)?;
    let r = state(app, |s| s.ribbon);
    let gap = (8. * mon.scale_factor()).round() as i32;
    let margin = (16. * mon.scale_factor()).round() as i32;
    let left = snapshot(app).settings.side == Side::Left;
    let x = if left {
        r.x + r.w as i32 + gap
    } else {
        r.x - size.width as i32 - gap
    };
    let y = state(app, |s| s.player_anchor_y.unwrap_or(r.y)) - size.height as i32 / 2;
    Ok(PhysicalPosition::new(
        x.clamp(
            area.position.x + margin,
            (area.position.x + area.size.width as i32 - size.width as i32 - margin)
                .max(area.position.x + margin),
        ),
        y.clamp(
            area.position.y + margin,
            (area.position.y + area.size.height as i32 - size.height as i32 - margin)
                .max(area.position.y + margin),
        ),
    ))
}
fn reveal_player(app: &AppHandle) -> Result<()> {
    let w = window(app, "player")?;
    let target = player_position(app)?;
    let visible = w.is_visible().map_err(err)?;
    let mon = monitor(app)?;
    let area = mon.work_area();
    let distance = (18. * mon.scale_factor()).round() as i32;
    let direction = if snapshot(app).settings.side == Side::Right {
        1
    } else {
        -1
    };
    let from = if visible {
        w.outer_position().map_err(err)?
    } else {
        PhysicalPosition::new(
            (target.x + direction * distance).clamp(
                area.position.x,
                (area.position.x + area.size.width as i32
                    - w.outer_size().map_err(err)?.width as i32)
                    .max(area.position.x),
            ),
            target.y,
        )
    };
    let generation = state(app, |s| {
        s.player_animation += 1;
        s.player_animation
    });
    w.set_position(from).map_err(err)?;
    native::show_overlay(&w)?;
    let app = app.clone();
    let start = Instant::now();
    tauri::async_runtime::spawn_blocking(move || loop {
        native::wait_for_frame();
        let (send, recv) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        let w = w.clone();
        if app
            .run_on_main_thread(move || {
                if state(&handle, |s| s.player_animation != generation) {
                    let _ = send.send(false);
                    return;
                }
                let progress =
                    (start.elapsed().as_secs_f64() / SLIDE_DURATION.as_secs_f64()).min(1.);
                let eased = 1. - (1. - progress).powi(4);
                let position = PhysicalPosition::new(
                    (from.x as f64 + (target.x - from.x) as f64 * eased).round() as i32,
                    (from.y as f64 + (target.y - from.y) as f64 * eased).round() as i32,
                );
                if let Err(error) = w.set_position(position) {
                    report(&handle, err(error));
                    let _ = send.send(false);
                    return;
                }
                let _ = send.send(progress < 1.);
            })
            .is_err()
        {
            break;
        }
        if !recv.recv().unwrap_or(false) {
            break;
        }
    });
    Ok(())
}
pub fn schedule_player_hide(app: &AppHandle) {
    state(app, |s| {
        s.player_hide = Some(Instant::now() + Duration::from_millis(350))
    });
}
pub fn keep_player(app: &AppHandle) {
    state(app, |s| s.player_hide = None);
    touch(app, Duration::from_millis(400));
}
pub fn close_player(app: &AppHandle) {
    state(app, |s| {
        s.player_animation += 1;
        s.player_hide = None;
        s.player_anchor_y = None;
    });
    let _ = window(app, "player").and_then(|w| native::hide_overlay(&w));
    let changed = edit(app, |b| b.state.player_target.take().is_some());
    if changed {
        emit(app);
    }
}
pub fn resize_player(app: &AppHandle, height: f64) -> Result<()> {
    let height = height.clamp(120., 420.);
    if state(app, |s| (s.player_height - height).abs() < 2.) {
        return Ok(());
    }
    state(app, |s| {
        s.player_height = height;
        s.player_animation += 1;
    });
    on_ui(app, move |app| {
        let w = window(app, "player")?;
        w.set_size(LogicalSize::new(PLAYER_WIDTH, height))
            .map_err(err)?;
        if let Some(v) = app.get_webview("player") {
            v.set_size(w.inner_size().map_err(err)?).map_err(err)?;
        }
        if w.is_visible().map_err(err)? {
            w.set_position(player_position(app)?).map_err(err)?;
        }
        Ok(())
    })
}
pub fn downloads_panel(app: &AppHandle, _x: Option<f64>, y: Option<f64>) -> Result<()> {
    let w = window(app, "downloads")?;
    if w.is_visible().map_err(err)? {
        w.hide().map_err(err)?;
    } else {
        popup_position(app, "downloads", y.unwrap_or(50.))?;
        w.show().map_err(err)?;
        w.set_focus().map_err(err)?;
        touch(app, Duration::from_secs(1));
    }
    Ok(())
}
pub fn on_window_event(w: &Window, e: &WindowEvent) {
    if !TRUSTED.contains(&w.label()) {
        return;
    }
    let app = w.app_handle();
    match e {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            enqueue(app.clone(), json!({"type":"hide"}));
        }
        WindowEvent::Resized(_) => {
            if w.label() == "pane" {
                let _ = layout_views(app);
            } else if let Some(v) = app.get_webview(w.label()) {
                if let Ok(size) = w.inner_size() {
                    let _ = v.set_size(size);
                }
            }
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let _ = layout(app);
        }
        WindowEvent::ThemeChanged(_) if w.label() == "player" => {
            let _ = native::preview_window(w);
        }
        WindowEvent::Focused(false) if w.label() == "downloads" => {
            let _ = w.hide();
        }
        _ => {}
    }
}
fn cursor_inside(app: &AppHandle, x: i32, y: i32, fullscreen: bool) -> bool {
    for (label, w) in app.windows() {
        if label == "edge" || (fullscreen && label == "pane") {
            continue;
        }
        if !w.is_visible().unwrap_or(false) {
            continue;
        }
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
            if (Rect {
                x: p.x,
                y: p.y,
                w: s.width,
                h: s.height,
            })
            .contains(x, y)
            {
                return true;
            }
        }
    }
    false
}
pub fn outside_click(app: &AppHandle) {
    let s = snapshot(app);
    let dismiss = state(app, |s| s.visible && !s.manual_hidden && !s.dragging);
    if dismiss && !s.collapsed && !s.settings.pinned && !s.fullscreen {
        // Only an expanded pane uses click-away dismissal. The collapsed ribbon
        // follows the pointer, independently of clicks and focus changes.
        let _ = hide(app, false);
    }
}
pub fn start_polling(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            tick += 1;
            let now = Instant::now();
            let s = snapshot(&app);
            if let Some((x, y)) = native::cursor() {
                let inside = cursor_inside(&app, x, y, s.fullscreen);
                let (visible, manual, dragging, held, r) = state(&app, |s| {
                    (
                        s.visible,
                        s.manual_hidden,
                        s.dragging,
                        now < s.hold_until,
                        s.ribbon,
                    )
                });
                if state(&app, |s| s.player_hide.is_some_and(|d| now >= d)) {
                    let player = window(&app, "player")
                        .ok()
                        .and_then(|w| {
                            let p = w.outer_position().ok()?;
                            let z = w.outer_size().ok()?;
                            Some(
                                Rect {
                                    x: p.x,
                                    y: p.y,
                                    w: z.width,
                                    h: z.height,
                                }
                                .contains(x, y),
                            )
                        })
                        .unwrap_or(false);
                    if !player {
                        close_player(&app);
                        state(&app, |s| s.player_hide = None);
                        emit(&app);
                    }
                }
                if (s.fullscreen || !s.settings.pinned) && !dragging && !manual {
                    let edge = if s.settings.side == Side::Left {
                        x >= r.x && x <= r.x + 2
                    } else {
                        x >= r.x + r.w as i32 - 3 && x < r.x + r.w as i32
                    };
                    if !visible && edge && y >= r.y && y < r.y + r.h as i32 {
                        let ready = state(&app, |s| {
                            let start = s.edge_since.get_or_insert(now);
                            now.duration_since(*start) >= Duration::from_millis(100)
                        });
                        if ready {
                            let _ = show(&app);
                        }
                    } else {
                        state(&app, |s| s.edge_since = None);
                    }
                    let panel_open = (!s.collapsed && !s.fullscreen)
                        || ["player", "downloads"].iter().any(|label| {
                            window(&app, label).is_ok_and(|w| w.is_visible().unwrap_or(false))
                        });
                    if visible && !inside && !panel_open && !held {
                        let ready = state(&app, |s| {
                            let start = s.outside_since.get_or_insert(now);
                            now.duration_since(*start) >= Duration::from_millis(100)
                        });
                        if ready {
                            let _ = hide(&app, false);
                        }
                    } else {
                        state(&app, |s| s.outside_since = None);
                    }
                }
            }
            // Keep layout and media polling at 1.5 seconds despite faster edge checks.
            if tick % 30 == 0 {
                let _ = layout(&app);
                for t in s.tabs {
                    if let Ok(v) = view(&app, t.id) {
                        native::poll(&v, t.id);
                        let app = app.clone();
                        let id = t.id;
                        let script = format!("JSON.stringify({MEDIA_ENGINE}.status())");
                        let _ = v.eval_with_callback(script, move |raw| {
                            let value = serde_json::from_str::<String>(&raw)
                                .ok()
                                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
                            if let Some(value) = value {
                                let media = value["hasMedia"].as_bool().unwrap_or(false);
                                let changed = edit(&app, |b| {
                                    let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id)
                                    else {
                                        return false;
                                    };
                                    if value["pageUrl"].as_str() != Some(&t.url) {
                                        return false;
                                    }
                                    let icon = value["favicon"]
                                        .as_str()
                                        .filter(|s| {
                                            s.len() < 400000
                                                && (s.starts_with("data:image/")
                                                    || model::is_web_url(s))
                                        })
                                        .map(str::to_owned);
                                    let changed =
                                        t.has_media != media || t.favicon_data_url != icon;
                                    t.has_media = media;
                                    t.favicon_data_url = icon.clone();
                                    if let Some(p) = b
                                        .state
                                        .settings
                                        .pins
                                        .iter_mut()
                                        .find(|p| Some(&p.id) == t.pin_id.as_ref())
                                    {
                                        p.favicon_data_url = icon;
                                    }
                                    changed
                                });
                                if changed {
                                    emit(&app);
                                }
                                if !media && snapshot(&app).player_target == Some(id) {
                                    close_player(&app);
                                }
                            }
                        });
                    }
                }
            }
        }
    });
}
