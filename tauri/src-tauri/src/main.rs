#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native;
mod shell;

use model::{Browser, Pin, Settings, Snapshot};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tabbar_core as model;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};
use tauri_plugin_opener::OpenerExt;

type Result<T> = std::result::Result<T, String>;
const TRUSTED: &[&str] = &["ribbon", "pane", "player", "downloads", "edge"];
static UNIQUE: AtomicU64 = AtomicU64::new(1);
const MEDIA_ENGINE: &str = include_str!("scripts/media-engine.js");

struct Runtime {
    browser: Mutex<Browser>,
    operations: tauri::async_runtime::Mutex<()>,
    settings_path: PathBuf,
    shell: Mutex<shell::State>,
}
fn edit<T>(app: &AppHandle, f: impl FnOnce(&mut Browser) -> T) -> T {
    f(&mut app
        .state::<Runtime>()
        .browser
        .lock()
        .expect("browser state"))
}
fn snapshot(app: &AppHandle) -> Snapshot {
    edit(app, |b| b.state.clone())
}
fn emit(app: &AppHandle) {
    let state = snapshot(app);
    for label in TRUSTED {
        let _ = app.emit_to(*label, "browser-state", &state);
    }
}
fn report(app: &AppHandle, error: String) {
    eprintln!("{error}");
    for label in ["ribbon", "pane"] {
        let _ = app.emit_to(label, "browser-error", &error);
    }
}
fn save(app: &AppHandle) -> Result<()> {
    let mut settings = snapshot(app).settings;
    settings.collapsed = snapshot(app).collapsed;
    let path = &app.state::<Runtime>().settings_path;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(&settings).map_err(err)?).map_err(err)?;
    fs::rename(temp, path).map_err(err)
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn view(app: &AppHandle, id: u64) -> Result<Webview> {
    app.get_webview(&format!("tab-{id}"))
        .ok_or_else(|| "This tab has no website open".into())
}
fn active_view(app: &AppHandle) -> Result<Webview> {
    view(app, snapshot(app).active.ok_or("Open a website first")?)
}
fn profile_path(app: &AppHandle, pin: Option<&Pin>) -> Result<PathBuf> {
    // Hex encoding keeps imported partition names within our own data directory.
    let key = pin
        .and_then(|p| p.partition.as_deref())
        .unwrap_or("persist:sidebar-browser");
    if key == "persist:sidebar-browser" {
        return Ok(app
            .path()
            .app_local_data_dir()
            .map_err(err)?
            .join("webview"));
    }
    let encoded: String = key.bytes().map(|b| format!("{b:02x}")).collect();
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(err)?
        .join("profiles")
        .join(encoded))
}

fn launch_view(app: &AppHandle, id: u64) -> Result<()> {
    let state = snapshot(app);
    let tab = state
        .tabs
        .iter()
        .find(|t| t.id == id)
        .ok_or("Unknown tab")?;
    if tab.url == "about:blank" || app.get_webview(&format!("tab-{id}")).is_some() {
        return Ok(());
    }
    let pin = state
        .settings
        .pins
        .iter()
        .find(|p| Some(&p.id) == tab.pin_id.as_ref());
    let profile = profile_path(app, pin)?;
    fs::create_dir_all(&profile).map_err(err)?;
    let nav_app = app.clone();
    let title_app = app.clone();
    let load_app = app.clone();
    let popup_app = app.clone();
    let popup_profile = profile.clone();
    let ua = pin.and_then(|p| p.user_agent.clone());
    let popup_ua = ua.clone();
    let builder = WebviewBuilder::new(
        format!("tab-{id}"),
        WebviewUrl::External(tab.url.parse().map_err(err)?),
    )
    .data_directory(profile)
    .disable_drag_drop_handler()
    .focused(false)
    .initialization_script(include_str!("scripts/page.js"))
    .on_navigation(move |url| {
        if !model::is_web_url(url.as_str()) {
            return false;
        }
        edit(&nav_app, |b| {
            if let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id) {
                t.url = url.to_string();
                t.has_media = false;
                t.is_audio_playing = false;
            }
        });
        emit(&nav_app);
        true
    })
    .on_document_title_changed(move |_, title| {
        edit(&title_app, |b| {
            if let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id) {
                (t.unread_count, t.unread_dot) = model::unread(&title);
                t.title = title.chars().take(512).collect();
            }
        });
        emit(&title_app);
    })
    .on_page_load(move |_, payload| {
        edit(&load_app, |b| {
            if let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id) {
                t.loading = matches!(payload.event(), PageLoadEvent::Started);
                if t.loading {
                    t.has_media = false;
                    t.is_audio_playing = false;
                }
                t.url = payload.url().to_string();
            }
        });
        emit(&load_app);
    })
    .on_new_window(move |url, features| {
        if !model::is_web_url(url.as_str()) && url.as_str() != "about:blank" {
            return NewWindowResponse::Deny;
        }
        // Returning a native WebView2 child preserves window.opener for OAuth.
        // Ordinary target=_blank links still enter the tab strip.
        if features.size().is_none() && url.as_str() != "about:blank" {
            enqueue(
                popup_app.clone(),
                json!({"type":"openTab", "url":url.as_str()}),
            );
            return NewWindowResponse::Deny;
        }
        let label = format!("popup-{}", UNIQUE.fetch_add(1, Ordering::Relaxed));
        let mut builder = tauri::WebviewWindowBuilder::new(
            &popup_app,
            &label,
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .data_directory(popup_profile.clone())
        .window_features(features)
        .title("Tabbar — sign in")
        .inner_size(520.0, 720.0)
        .on_navigation(|url| model::is_web_url(url.as_str()) || url.as_str() == "about:blank")
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(&title);
        });
        if let Some(ua) = &popup_ua {
            builder = builder.user_agent(ua);
        }
        match builder.build() {
            Ok(window) => {
                native::install_popup(&window);
                NewWindowResponse::Create { window }
            }
            Err(error) => {
                report(&popup_app, err(error));
                NewWindowResponse::Deny
            }
        }
    });
    let builder = if let Some(ua) = ua {
        builder.user_agent(&ua)
    } else {
        builder
    };
    let webview = shell::window(app, "pane")?
        .add_child(
            builder,
            LogicalPosition::new(4., 44.),
            LogicalSize::new(1., 1.),
        )
        .map_err(err)?;
    webview.hide().map_err(err)?;
    native::install(&webview, id)?;
    Ok(())
}
fn create_tab(app: &AppHandle, url: String, pin: Option<String>) -> Result<u64> {
    let previous = snapshot(app);
    let id = edit(app, |b| b.add(url, pin));
    if let Err(error) = launch_view(app, id) {
        edit(app, |b| b.state = previous);
        return Err(error);
    }
    Ok(id)
}
fn activate_pin(app: &AppHandle, site: &str) -> Result<u64> {
    let state = snapshot(app);
    if let Some(t) = state
        .tabs
        .iter()
        .find(|t| t.pin_id.as_deref() == Some(site))
    {
        edit(app, |b| b.state.active = Some(t.id));
        return Ok(t.id);
    }
    let pin = state
        .settings
        .pins
        .iter()
        .find(|p| p.id == site)
        .ok_or("Unknown pinned site")?;
    create_tab(app, pin.url.clone(), Some(site.to_owned()))
}
fn pin_tab(app: &AppHandle, id: u64) -> Result<()> {
    edit(app, |b| {
        let t = b
            .state
            .tabs
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or("Unknown tab")?;
        if !model::is_web_url(&t.url) {
            return Err("Open a website before pinning it".into());
        }
        if t.pin_id.is_some() {
            return Ok(());
        }
        if let Some(pin) = b.state.settings.pins.iter().find(|p| p.url == t.url) {
            t.pin_id = Some(pin.id.clone());
            return Ok(());
        }
        let site = format!("site-{}-{}", native::epoch_ms(), id);
        b.state.settings.pins.push(Pin {
            id: site.clone(),
            title: t.title.clone(),
            url: t.url.clone(),
            favicon_data_url: t.favicon_data_url.clone(),
            expanded_width: Some(t.expanded_width),
            partition: None,
            user_agent: None,
        });
        // Preserve the current login; isolation can be selected explicitly in the site menu.
        t.pin_id = Some(site);
        Ok(())
    })
}
fn context_menu(app: &AppHandle, action: &Value) -> Result<()> {
    let ribbon = shell::window(app, "ribbon")?;
    // Capture the click before constructing the menu or queuing its native
    // popup. Client coordinates remain correct across mixed-DPI displays.
    let point = if let (Ok(x), Ok(y)) = (number(action, "x"), number(action, "y")) {
        let origin = ribbon.inner_position().map_err(err)?;
        let offset = app
            .get_webview("ribbon")
            .map(|v| v.position())
            .transpose()
            .map_err(err)?
            .unwrap_or_default();
        let scale = ribbon.scale_factor().map_err(err)?;
        (
            origin.x + offset.x + (x * scale).round() as i32,
            origin.y + offset.y + (y * scale).round() as i32,
        )
    } else {
        native::cursor().ok_or("Unable to locate the menu anchor")?
    };
    let s = snapshot(app);
    let menu = Menu::new(app).map_err(err)?;
    let item = |action: Value, title: &str| -> Result<()> {
        menu.append(
            &MenuItem::with_id(app, action.to_string(), title, true, None::<&str>).map_err(err)?,
        )
        .map_err(err)
    };
    let check = |action: Value, title: &str, checked: bool| -> Result<()> {
        menu.append(
            &CheckMenuItem::with_id(app, action.to_string(), title, true, checked, None::<&str>)
                .map_err(err)?,
        )
        .map_err(err)
    };
    let site = action["siteId"]
        .as_str()
        .and_then(|id| s.settings.pins.iter().find(|p| p.id == id));
    if let Some(pin) = site {
        item(
            json!({"type":"launchPin","siteId":pin.id,"expand":true}),
            "Open site",
        )?;
        item(json!({"type":"unpin","siteId":pin.id}), "Unpin site")?;
        check(
            json!({"type":"isolate","siteId":pin.id}),
            "Isolated login session",
            pin.partition.is_some(),
        )?;
        for (key, title) in [
            ("default", "User agent: Default"),
            ("mobile", "User agent: Mobile"),
            ("desktop", "User agent: Desktop"),
        ] {
            check(
                json!({"type":"userAgent","siteId":pin.id,"preset":key}),
                title,
                match key {
                    "default" => pin.user_agent.is_none(),
                    "mobile" => pin
                        .user_agent
                        .as_ref()
                        .is_some_and(|s| s.contains("iPhone")),
                    _ => pin
                        .user_agent
                        .as_ref()
                        .is_some_and(|s| !s.contains("iPhone")),
                },
            )?;
        }
        if let Some(t) = s.tabs.iter().find(|t| t.pin_id.as_deref() == Some(&pin.id)) {
            item(json!({"type":"close","id":t.id}), "Close tab")?;
        }
    } else if let Some(id) = action["id"].as_u64() {
        item(json!({"type":"pin","id":id}), "Pin to Tabbar")?;
        item(json!({"type":"close","id":id}), "Close tab")?;
    } else {
        check(
            json!({"type":"togglePinned"}),
            "Pin Tabbar to desktop",
            s.settings.pinned,
        )?;
        item(
            json!({"type":"toggleSide"}),
            if s.settings.side == model::Side::Left {
                "Dock right"
            } else {
                "Dock left"
            },
        )?;
        item(json!({"type":"fullscreen"}), "Toggle fullscreen")?;
        item(json!({"type":"downloadsPanel"}), "Downloads")?;
        item(json!({"type":"hide"}), "Hide to tray")?;
        item(json!({"type":"quit"}), "Quit")?;
    }
    shell::touch(app, Duration::from_secs(30));
    native::popup_menu(&ribbon, menu, point, s.settings.side)
}

fn number(action: &Value, name: &str) -> Result<f64> {
    action[name]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("Missing {name}"))
}
fn id(action: &Value) -> Result<u64> {
    action["id"].as_u64().ok_or_else(|| "Missing tab ID".into())
}
fn string<'a>(action: &'a Value, name: &str) -> Result<&'a str> {
    action[name]
        .as_str()
        .ok_or_else(|| format!("Missing {name}"))
}

async fn apply(app: &AppHandle, a: Value) -> Result<()> {
    let runtime = app.state::<Runtime>();
    let _operation = runtime.operations.lock().await;
    let kind = string(&a, "type")?;
    let mut persist = false;
    match kind {
        "create" => {
            create_tab(
                app,
                model::normalize_url(a["url"].as_str().unwrap_or(""))?,
                None,
            )?;
            if a["url"].is_null() {
                let _ = app.emit_to("pane", "focus-address", ());
            }
        }
        "activate" => {
            let id = id(&a)?;
            edit(app, |b| {
                if b.state.tabs.iter().any(|t| t.id == id) {
                    b.state.active = Some(id);
                }
            });
        }
        "close" => {
            let id = id(&a)?;
            if snapshot(app).player_target == Some(id) {
                shell::close_player(app);
            }
            if snapshot(app).active == Some(id) && snapshot(app).fullscreen {
                edit(app, |b| b.state.html_fullscreen = false);
                shell::fullscreen(app, false)?;
            }
            if let Ok(v) = view(app, id) {
                v.close().map_err(err)?;
            }
            edit(app, |b| b.remove(id));
        }
        "navigate" => {
            let url = model::normalize_url(string(&a, "url")?)?;
            if let Some(id) = snapshot(app).active {
                if let Ok(v) = view(app, id) {
                    if url == "about:blank" {
                        v.close().map_err(err)?;
                        edit(app, |b| {
                            if let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id) {
                                t.url = url;
                                t.title = "New tab".into();
                                t.can_go_back = false;
                                t.can_go_forward = false;
                            }
                        });
                    } else {
                        v.navigate(url.parse().map_err(err)?).map_err(err)?;
                    }
                } else {
                    edit(app, |b| {
                        if let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id) {
                            t.url = url;
                        }
                    });
                    launch_view(app, id)?;
                }
            } else {
                create_tab(app, url, None)?;
            }
            edit(app, |b| b.state.collapsed = false);
        }
        "openTab" => {
            let url =
                model::launch_url(string(&a, "url")?).ok_or("Only web links are supported")?;
            create_tab(app, url, None)?;
            edit(app, |b| b.state.collapsed = false);
            shell::show(app)?;
        }
        "openUrl" => {
            let url =
                model::launch_url(string(&a, "url")?).ok_or("Only web links are supported")?;
            let s = snapshot(app);
            let pin = s
                .settings
                .pins
                .iter()
                .find(|p| model::same_host(&p.url, &url));
            if let Some(p) = pin {
                let id = activate_pin(app, &p.id)?;
                view(app, id)?
                    .navigate(url.parse().map_err(err)?)
                    .map_err(err)?;
            } else {
                create_tab(app, url, None)?;
            }
            edit(app, |b| b.state.collapsed = false);
            shell::show(app)?;
        }
        "back" => native::history(&active_view(app)?, false)?,
        "forward" => native::history(&active_view(app)?, true)?,
        "reload" => {
            if let Ok(v) = active_view(app) {
                v.reload().map_err(err)?;
            }
        }
        "toggleCollapsed" => {
            if snapshot(app).fullscreen {
                edit(app, |b| b.state.html_fullscreen = false);
                if let Ok(v) = active_view(app) {
                    let _ = v.eval("if(document.fullscreenElement)document.exitFullscreen()");
                }
                shell::fullscreen(app, false)?;
            }
            edit(app, |b| b.state.collapsed = !b.state.collapsed);
            persist = true;
        }
        "toggleSide" => {
            shell::unreserve(app);
            edit(app, |b| {
                b.state.settings.side = if b.state.settings.side == model::Side::Left {
                    model::Side::Right
                } else {
                    model::Side::Left
                }
            });
            persist = true;
        }
        "togglePinned" => {
            shell::unreserve(app);
            edit(app, |b| b.state.settings.pinned = !b.state.settings.pinned);
            shell::show(app)?;
            persist = true;
        }
        "setWidth" => {
            let width = model::clamp_width(number(&a, "width")?);
            edit(app, |b| {
                b.state.settings.pane_width = width;
                if let Some(t) = b
                    .state
                    .tabs
                    .iter_mut()
                    .find(|t| Some(t.id) == b.state.active)
                {
                    t.expanded_width = width;
                    if let Some(p) = b
                        .state
                        .settings
                        .pins
                        .iter_mut()
                        .find(|p| Some(&p.id) == t.pin_id.as_ref())
                    {
                        p.expanded_width = Some(width);
                    }
                }
            });
            persist = true;
        }
        "pin" => {
            pin_tab(app, id(&a)?)?;
            persist = true;
        }
        "unpin" => {
            let site = string(&a, "siteId")?;
            edit(app, |b| {
                b.state.settings.pins.retain(|p| p.id != site);
                for t in &mut b.state.tabs {
                    if t.pin_id.as_deref() == Some(site) {
                        t.pin_id = None;
                    }
                }
            });
            persist = true;
        }
        "launchPin" => {
            activate_pin(app, string(&a, "siteId")?)?;
            if a["expand"] == true {
                edit(app, |b| b.state.collapsed = false);
            }
        }
        "reorderPins" => {
            let from = string(&a, "fromSiteId")?;
            let to = string(&a, "toSiteId")?;
            edit(app, |b| {
                let v = &mut b.state.settings.pins;
                if let (Some(f), Some(t)) = (
                    v.iter().position(|p| p.id == from),
                    v.iter().position(|p| p.id == to),
                ) {
                    model::reorder(v, f, t, a["before"].as_bool().unwrap_or(true));
                }
            });
            persist = true;
        }
        "reorderTabs" => {
            edit(app, |b| {
                let v = &mut b.state.tabs;
                if let (Some(f), Some(t)) = (
                    v.iter().position(|t| Some(t.id) == a["fromId"].as_u64()),
                    v.iter().position(|t| Some(t.id) == a["toId"].as_u64()),
                ) {
                    model::reorder(v, f, t, a["before"].as_bool().unwrap_or(true));
                }
            });
        }
        "isolate" | "userAgent" => {
            let site = string(&a, "siteId")?;
            edit(app, |b| {
                if let Some(p) = b.state.settings.pins.iter_mut().find(|p| p.id == site) {
                    if kind == "isolate" {
                        p.partition = if p.partition.is_some() {
                            None
                        } else {
                            Some(format!("persist:site-{}", p.id))
                        };
                    } else {
                        p.user_agent=match a["preset"].as_str(){Some("mobile")=>Some("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1".into()),Some("desktop")=>Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36".into()),_=>None};
                    }
                }
            });
            for t in snapshot(app)
                .tabs
                .iter()
                .filter(|t| t.pin_id.as_deref() == Some(site))
            {
                if let Ok(v) = view(app, t.id) {
                    v.close().map_err(err)?;
                }
                launch_view(app, t.id)?;
            }
            persist = true;
        }
        "menu" => return context_menu(app, &a),
        "openExternal" => {
            let url = active_view(app)?.url().map_err(err)?;
            if model::is_web_url(url.as_str()) {
                app.opener()
                    .open_url(url.as_str(), None::<&str>)
                    .map_err(err)?;
            }
        }
        "fullscreen" => {
            let fullscreen = !snapshot(app).fullscreen;
            edit(app, |b| b.state.html_fullscreen = false);
            if !fullscreen {
                if let Ok(v) = active_view(app) {
                    let _ = v.eval("if(document.fullscreenElement)document.exitFullscreen()");
                }
            }
            shell::fullscreen(app, fullscreen)?;
        }
        "htmlFullscreen" => {
            if snapshot(app).active == a["id"].as_u64() {
                let enter = a["entering"].as_bool().unwrap_or(false);
                edit(app, |b| b.state.html_fullscreen = enter);
                shell::fullscreen(app, enter)?;
            }
        }
        "placement" => {
            shell::place(app, number(&a, "x")?, number(&a, "y")?)?;
            persist = true;
        }
        "dragging" => {
            shell::dragging(app, a["dragging"].as_bool().unwrap_or(false));
            return Ok(());
        }
        "show" => shell::show(app)?,
        "hide" => {
            shell::hide(app, true)?;
            return Ok(());
        }
        "showPlayer" => {
            shell::show_player(app, &a)?;
        }
        "hidePlayer" => {
            shell::schedule_player_hide(app);
            return Ok(());
        }
        "keepPlayer" => {
            shell::keep_player(app);
            return Ok(());
        }
        "resizePlayer" => {
            shell::resize_player(app, number(&a, "height")?)?;
            return Ok(());
        }
        "openPlayer" => {
            if let Some(id) = snapshot(app).player_target {
                edit(app, |b| {
                    b.state.active = Some(id);
                    b.state.collapsed = false;
                });
                shell::close_player(app);
                shell::show(app)?;
            }
        }
        "downloadsPanel" => shell::downloads_panel(app, a["x"].as_f64(), a["y"].as_f64())?,
        "closeDownloads" => {
            shell::window(app, "downloads")?.hide().map_err(err)?;
            return Ok(());
        }
        "cancelDownload" => native::cancel_download(app, id(&a)?)?,
        "clearDownloads" => edit(app, |b| {
            b.state
                .downloads
                .retain(|d| matches!(d.state.as_str(), "progressing" | "paused"))
        }),
        "openDownload" | "revealDownload" => {
            let s = snapshot(app);
            let d = s
                .downloads
                .iter()
                .find(|d| Some(d.id) == a["id"].as_u64())
                .ok_or("Unknown download")?;
            if kind == "openDownload" {
                if d.state != "completed" {
                    return Err("The download is not complete".into());
                }
                app.opener()
                    .open_path(&d.save_path, None::<&str>)
                    .map_err(err)?;
            } else {
                app.opener().reveal_item_in_dir(&d.save_path).map_err(err)?;
            }
        }
        "registerProtocol" => native::register_protocol()?,
        "importElectron" => {
            edit(app, |b| import_electron(&mut b.state.settings));
            persist = true;
        }
        "quit" => {
            save(app)?;
            shell::unreserve(app);
            app.exit(0);
            return Ok(());
        }
        _ => return Err("Unknown Tabbar action".into()),
    }
    shell::layout(app)?;
    if !snapshot(app).collapsed {
        if (kind == "create" && a["url"].is_null())
            || (kind == "toggleCollapsed"
                && snapshot(app)
                    .tabs
                    .iter()
                    .any(|t| Some(t.id) == snapshot(app).active && t.url == "about:blank"))
        {
            shell::window(app, "pane")?.set_focus().map_err(err)?;
            if let Some(v) = app.get_webview("pane") {
                let _ = v.set_focus();
            }
            let _ = app.emit_to("pane", "focus-address", ());
        } else if matches!(
            kind,
            "navigate"
                | "openUrl"
                | "openTab"
                | "activate"
                | "launchPin"
                | "openPlayer"
                | "fullscreen"
        ) {
            shell::window(app, "pane")?.set_focus().map_err(err)?;
            if let Ok(v) = active_view(app) {
                let _ = v.set_focus();
            }
        }
    }
    emit(app);
    if persist {
        save(app)?;
    }
    Ok(())
}
fn enqueue(app: AppHandle, action: Value) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = apply(&app, action).await {
            report(&app, e);
        }
    });
}
fn authorize(v: &Webview) -> Result<()> {
    if TRUSTED.contains(&v.label()) {
        Ok(())
    } else {
        Err("Only the Tabbar interface may call native commands".into())
    }
}
#[tauri::command]
fn get_state(webview: Webview, app: AppHandle) -> Result<Snapshot> {
    authorize(&webview)?;
    Ok(snapshot(&app))
}
#[tauri::command]
async fn act(webview: Webview, app: AppHandle, action: Value) -> Result<()> {
    authorize(&webview)?;
    apply(&app, action).await
}
async fn evaluate(view: &Webview, script: &str) -> Result<Value> {
    let (send, recv) = tokio::sync::oneshot::channel();
    let send = Mutex::new(Some(send));
    view.eval_with_callback(script, move |s| {
        if let Some(send) = send.lock().unwrap().take() {
            let _ = send.send(s);
        }
    })
    .map_err(err)?;
    let value = tokio::time::timeout(Duration::from_secs(8), recv)
        .await
        .map_err(|_| "The website did not respond")?
        .map_err(err)?;
    serde_json::from_str(&value).map_err(err)
}
#[tauri::command]
async fn query(webview: Webview, app: AppHandle, kind: String, id: Option<u64>) -> Result<Value> {
    authorize(&webview)?;
    let id = id.ok_or("Missing tab")?;
    let Ok(v) = view(&app, id) else {
        if matches!(kind.as_str(), "playPause" | "nextTrack" | "mute") {
            return Err("This media tab is no longer available".into());
        }
        return Ok(Value::Null);
    };
    match kind.as_str() {
        "preview" => native::preview(&v).await.map(|v| json!(v)),
        "playPause" => {
            let result = native::user_gesture(&v, &format!("{MEDIA_ENGINE}.toggle()")).await?;
            if result["ok"] == true {
                Ok(Value::Null)
            } else {
                Err("This track is not ready. Open the tab to start playback.".into())
            }
        }
        "nextTrack" => native::user_gesture(&v, &format!("{MEDIA_ENGINE}.next()")).await,
        "mute" => {
            let info = evaluate(&v, &format!("{MEDIA_ENGINE}.info()")).await?;
            if info["hasMedia"] != true {
                return Err("No playable media is available in this tab".into());
            }
            native::toggle_mute(&v).await.map(|v| json!(v))
        }
        "media" => {
            let mut info = evaluate(&v, &format!("{MEDIA_ENGINE}.info()")).await?;
            if !snapshot(&app)
                .tabs
                .iter()
                .any(|t| t.id == id && info["pageUrl"].as_str() == Some(&t.url))
            {
                return Ok(Value::Null);
            }
            let has_media = info["hasMedia"] == true;
            let changed = edit(&app, |b| {
                let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id) else {
                    return false;
                };
                let changed = t.has_media != has_media;
                t.has_media = has_media;
                changed
            });
            if !has_media && snapshot(&app).player_target == Some(id) {
                shell::close_player(&app);
            }
            if changed {
                emit(&app);
            }
            if let Some(t) = snapshot(&app).tabs.iter().find(|t| t.id == id) {
                info["tabId"] = json!(id);
                info["sourceTitle"] = json!(t.title);
                info["sourceUrl"] = json!(t.url);
                info["faviconDataUrl"] = json!(t.favicon_data_url);
                let muted = native::is_muted(&v).await;
                info["canMute"] = json!(has_media && muted.is_ok());
                info["isMuted"] = json!(muted.unwrap_or(false));
                if info["title"].as_str().is_none_or(str::is_empty) {
                    info["title"] = json!(t.title);
                }
            }
            Ok(info)
        }
        _ => Err("Unknown query".into()),
    }
}
fn import_electron(settings: &mut Settings) {
    let Some(roaming) = std::env::var_os("APPDATA") else {
        return;
    };
    let dir = PathBuf::from(roaming).join("sidebar");
    if let Ok(bytes) = fs::read(dir.join("pinned-sites.json")) {
        if let Ok(pins) = serde_json::from_slice::<Vec<Pin>>(&bytes) {
            for pin in pins {
                if !settings
                    .pins
                    .iter()
                    .any(|p| p.id == pin.id || p.url == pin.url)
                {
                    settings.pins.push(pin);
                }
            }
        }
    }
    if let Ok(bytes) = fs::read(dir.join("shell-placement.json")) {
        if let Ok(s) = serde_json::from_slice::<Value>(&bytes) {
            settings.side = if s["side"] == "left" {
                model::Side::Left
            } else {
                model::Side::Right
            };
            settings.pinned = s["pinned"].as_bool().unwrap_or(false);
            settings.collapsed = s["collapsed"].as_bool().unwrap_or(true);
        }
    }
    settings.imported_electron = true;
    settings.sanitize();
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            enqueue(app.clone(), json!({"type":"show"}));
            for url in args.iter().skip(1).filter_map(|s| model::launch_url(s)) {
                enqueue(app.clone(), json!({"type":"openUrl","url":url}));
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_state, act, query])
        .on_menu_event(|app, event| {
            if let Ok(action) = serde_json::from_str(event.id.as_ref()) {
                enqueue(app.clone(), action);
            }
        })
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            fs::create_dir_all(&dir)?;
            let settings_path = dir.join("settings.json");
            let mut settings: Settings = match fs::read(&settings_path) {
                Ok(bytes) => serde_json::from_slice(&bytes)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
                Err(e) => return Err(e.into()),
            };
            if !settings.imported_electron {
                import_electron(&mut settings);
            }
            settings.sanitize();
            app.manage(Runtime {
                browser: Mutex::new(Browser::new(settings)),
                operations: tauri::async_runtime::Mutex::new(()),
                settings_path,
                shell: Mutex::new(shell::State::default()),
            });
            shell::create(app.handle()).map_err(std::io::Error::other)?;
            let menu = Menu::new(app)?;
            for (kind, title) in [
                ("show", "Show Tabbar"),
                ("togglePinned", "Pin / unpin Tabbar"),
                ("quit", "Quit"),
            ] {
                menu.append(&MenuItem::with_id(
                    app,
                    json!({"type":kind}).to_string(),
                    title,
                    true,
                    None::<&str>,
                )?)?;
            }
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Tabbar")
                .menu(&menu)
                .build(app)?;
            shell::show(app.handle()).map_err(std::io::Error::other)?;
            save(app.handle()).map_err(std::io::Error::other)?;
            for url in std::env::args()
                .skip(1)
                .filter_map(|s| model::launch_url(&s))
            {
                enqueue(app.handle().clone(), json!({"type":"openUrl","url":url}));
            }
            native::start_click_listener(app.handle()).map_err(std::io::Error::other)?;
            shell::start_polling(app.handle());
            if let Err(error) = native::register_protocol() {
                report(app.handle(), error);
            }
            Ok(())
        })
        .on_window_event(|w, e| shell::on_window_event(w, e))
        .build(tauri::generate_context!())
        .expect("Failed to initialize Tabbar")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                native::stop_click_listener(app);
                shell::unreserve(app);
            }
        });
}
