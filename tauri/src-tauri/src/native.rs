//! Windows integration. COM objects stay on the WebView2 UI thread; only plain
//! metadata crosses into application state or IPC.
use super::Result;
use super::*;
use base64::Engine;
use std::{
    cell::RefCell,
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::menu::ContextMenu;
use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
use windows::{
    core::{Interface, BOOL, PWSTR},
    Win32::{
        Foundation::{HGLOBAL, LPARAM, LRESULT, POINT, WPARAM},
        Graphics::Dwm::{
            DwmFlush, DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
            DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE,
        },
        Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn},
        System::Com::{
            CoTaskMemFree, StructuredStorage::CreateStreamOnHGlobal, STATFLAG_NONAME, STATSTG,
            STREAM_SEEK_SET,
        },
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::{
            Shell::{
                SHAppBarMessage, ABE_LEFT, ABE_RIGHT, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE,
                ABM_SETPOS, APPBARDATA,
            },
            WindowsAndMessaging::{
                BeginDeferWindowPos, CallNextHookEx, DeferWindowPos, DispatchMessageW,
                EndDeferWindowPos, GetAncestor, GetCursorPos, GetMenuItemID, GetMessageW,
                GetWindowThreadProcessId, PostThreadMessageW, SetForegroundWindow, SetWindowPos,
                SetWindowsHookExW, ShowWindow, TrackPopupMenuEx, UnhookWindowsHookEx,
                WindowFromPoint, GA_ROOTOWNER, HC_ACTION, HMENU, HWND_TOPMOST, MSG, MSLLHOOKSTRUCT,
                SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE,
                SW_SHOWNOACTIVATE, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTALIGN, TPM_RIGHTBUTTON,
                WH_MOUSE_LL, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
                WM_XBUTTONDOWN,
            },
        },
    },
};

thread_local! { static DOWNLOADS: RefCell<HashMap<u64,ICoreWebView2DownloadOperation>> = RefCell::new(HashMap::new()); }
thread_local! { static CLICK_APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) }; }

struct ClickListener {
    thread_id: u32,
}

unsafe extern "system" fn mouse_click(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && matches!(
            message.0 as u32,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
        )
    {
        let point = (*(data.0 as *const MSLLHOOKSTRUCT)).pt;
        // Resolve the target before the click can dismiss a native menu or dialog.
        let target = WindowFromPoint(point);
        let owner = GetAncestor(target, GA_ROOTOWNER);
        let mut target_pid = 0;
        let mut owner_pid = 0;
        GetWindowThreadProcessId(target, Some(&mut target_pid));
        GetWindowThreadProcessId(owner, Some(&mut owner_pid));
        if target_pid != std::process::id() && owner_pid != std::process::id() {
            CLICK_APP.with(|slot| {
                if let Some(app) = slot.borrow().as_ref() {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || shell::outside_click(&handle));
                }
            });
        }
    }
    // Observe only: every click continues to its original recipient.
    CallNextHookEx(None, code, message, data)
}

pub fn start_click_listener(app: &AppHandle) -> Result<()> {
    let handle = app.clone();
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("tabbar-outside-click".into())
        .spawn(move || unsafe {
            CLICK_APP.with(|slot| *slot.borrow_mut() = Some(handle));
            let hook = GetModuleHandleW(None).and_then(|module| {
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_click), Some(module.into()), 0)
            });
            match hook {
                Ok(hook) => {
                    let _ = ready.send(Ok(GetCurrentThreadId()));
                    // A separate message loop keeps the hook responsive while WebView2 loads.
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        DispatchMessageW(&message);
                    }
                    let _ = UnhookWindowsHookEx(hook);
                }
                Err(error) => {
                    let _ = ready.send(Err(err(error)));
                }
            }
            CLICK_APP.with(|slot| *slot.borrow_mut() = None);
        })
        .map_err(err)?;
    let thread_id = started.recv().map_err(err)??;
    app.manage(ClickListener { thread_id });
    Ok(())
}

pub fn stop_click_listener(app: &AppHandle) {
    if let Some(listener) = app.try_state::<ClickListener>() {
        unsafe {
            let _ = PostThreadMessageW(listener.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn cursor() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe {
        GetCursorPos(&mut p).ok()?;
    }
    Some((p.x, p.y))
}
pub fn popup_menu(
    window: &tauri::Window,
    menu: Menu<tauri::Wry>,
    point: (i32, i32),
    side: model::Side,
) -> Result<()> {
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| -> Result<()> {
                let hwnd = w.hwnd().map_err(err)?;
                let handle = HMENU(menu.hpopupmenu().map_err(err)? as *mut _);
                let items = menu.items().map_err(err)?;
                // Tauri's default popup always aligns left. On the right dock that
                // forces Windows to clamp the menu against the monitor boundary.
                // Anchor the inward-facing edge at the original physical click.
                let alignment = if side == model::Side::Right {
                    TPM_RIGHTALIGN
                } else {
                    TPM_LEFTALIGN
                };
                let command = unsafe {
                    let _ = SetForegroundWindow(hwnd);
                    TrackPopupMenuEx(
                        handle,
                        (alignment | TPM_RETURNCMD | TPM_RIGHTBUTTON).0,
                        point.0,
                        point.1,
                        hwnd,
                        None,
                    )
                    .0 as u32
                };
                // Keep the existing Tauri item definitions and actions; only native
                // placement differs. A zero command means the menu was dismissed.
                if command != 0 {
                    for (index, item) in items.iter().enumerate() {
                        if unsafe { GetMenuItemID(handle, index as i32) } == command {
                            enqueue(
                                w.app_handle().clone(),
                                serde_json::from_str(item.id().as_ref()).map_err(err)?,
                            );
                            break;
                        }
                    }
                }
                Ok(())
            })();
            shell::touch(w.app_handle(), Duration::from_millis(300));
            if let Err(error) = result {
                report(w.app_handle(), error);
            }
        })
        .map_err(err)
}
pub fn move_pair(
    ribbon: &tauri::Window,
    pane: &tauri::Window,
    ribbon_x: i32,
    pane_x: i32,
    y: i32,
) -> Result<()> {
    unsafe {
        let flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        let batch = BeginDeferWindowPos(2).map_err(err)?;
        let batch = DeferWindowPos(
            batch,
            ribbon.hwnd().map_err(err)?,
            None,
            ribbon_x,
            y,
            0,
            0,
            flags,
        )
        .map_err(err)?;
        let batch = DeferWindowPos(
            batch,
            pane.hwnd().map_err(err)?,
            None,
            pane_x,
            y,
            0,
            0,
            flags,
        )
        .map_err(err)?;
        EndDeferWindowPos(batch).map_err(err)
    }
}
pub fn clip_window(w: &tauri::Window, x: i32, width: u32, height: u32) -> Result<()> {
    let hwnd = w.hwnd().map_err(err)?;
    unsafe {
        let region = CreateRectRgn(x, 0, x + width as i32, height as i32);
        if region.0.is_null() {
            return Err(err(windows::core::Error::from_thread()));
        }
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let error = windows::core::Error::from_thread();
            let _ = DeleteObject(region.into());
            return Err(err(error));
        }
        // SetWindowRgn transfers ownership to Windows on success.
    }
    Ok(())
}
pub fn clear_clip(w: &tauri::Window) -> Result<()> {
    if unsafe { SetWindowRgn(w.hwnd().map_err(err)?, None, true) } == 0 {
        return Err(err(windows::core::Error::from_thread()));
    }
    Ok(())
}
pub fn wait_for_frame() {
    // Only the short-lived animation worker waits; never block the UI thread.
    if unsafe { DwmFlush() }.is_err() {
        std::thread::sleep(Duration::from_millis(16));
    }
}
pub fn flat_window(w: &tauri::Window) -> Result<()> {
    let hwnd = w.hwnd().map_err(err)?;
    unsafe {
        let square = 1i32;
        let disabled = 1i32;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &square as *const _ as _,
            4,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &disabled as *const _ as _,
            4,
        );
    }
    Ok(())
}
pub fn preview_window(w: &tauri::Window) -> Result<()> {
    let hwnd = w.hwnd().map_err(err)?;
    let round = 2i32;
    let dark = i32::from(matches!(w.theme(), Ok(tauri::Theme::Dark)));
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &round as *const _ as _,
            4,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark as *const _ as _,
            4,
        );
    }
    Ok(())
}
pub fn show_overlay(w: &tauri::Window) -> Result<()> {
    // Tao's show activates the window. Use the native non-activating operation,
    // paired with hide_overlay rather than Tao's cached visibility state.
    let hwnd = w.hwnd().map_err(err)?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(err)?;
    }
    Ok(())
}
pub fn hide_overlay(w: &tauri::Window) -> Result<()> {
    unsafe {
        let _ = ShowWindow(w.hwnd().map_err(err)?, SW_HIDE);
    }
    Ok(())
}
pub fn reserve(
    w: &tauri::Window,
    r: shell::Rect,
    side: model::Side,
    register: bool,
) -> Result<shell::Rect> {
    let mut d = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: w.hwnd().map_err(err)?,
        uCallbackMessage: 0x8401,
        uEdge: if side == model::Side::Left {
            ABE_LEFT
        } else {
            ABE_RIGHT
        },
        rc: windows::Win32::Foundation::RECT {
            left: r.x,
            top: r.y,
            right: r.x + r.w as i32,
            bottom: r.y + r.h as i32,
        },
        ..Default::default()
    };
    unsafe {
        if register {
            SHAppBarMessage(ABM_NEW, &mut d);
        }
        SHAppBarMessage(ABM_QUERYPOS, &mut d);
        if side == model::Side::Left {
            d.rc.right = d.rc.left + r.w as i32;
        } else {
            d.rc.left = d.rc.right - r.w as i32;
        }
        SHAppBarMessage(ABM_SETPOS, &mut d);
    }
    Ok(shell::Rect {
        x: d.rc.left,
        y: d.rc.top,
        w: (d.rc.right - d.rc.left) as u32,
        h: (d.rc.bottom - d.rc.top) as u32,
    })
}
pub fn unreserve(w: &tauri::Window) {
    if let Ok(hwnd) = w.hwnd() {
        let mut d = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: hwnd,
            ..Default::default()
        };
        unsafe {
            SHAppBarMessage(ABM_REMOVE, &mut d);
        }
    }
}
unsafe fn text_property(f: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> String {
    let mut p = PWSTR::null();
    if f(&mut p).is_err() {
        return String::new();
    }
    let s = if p.is_null() {
        String::new()
    } else {
        p.to_string().unwrap_or_default()
    };
    CoTaskMemFree(Some(p.0 as _));
    s
}
unsafe fn refresh(app: &AppHandle, id: u64, core: &ICoreWebView2) {
    let source = text_property(|p| core.Source(p));
    let mut back = BOOL(0);
    let mut forward = BOOL(0);
    let mut audio = BOOL(0);
    let _ = core.CanGoBack(&mut back);
    let _ = core.CanGoForward(&mut forward);
    if let Ok(c) = core.cast::<ICoreWebView2_8>() {
        let _ = c.IsDocumentPlayingAudio(&mut audio);
    }
    let changed = edit(app, |b| {
        let Some(t) = b.state.tabs.iter_mut().find(|t| t.id == id) else {
            return false;
        };
        let changed = t.can_go_back != back.as_bool()
            || t.can_go_forward != forward.as_bool()
            || t.is_audio_playing != audio.as_bool()
            || (model::is_web_url(&source) && t.url != source);
        t.can_go_back = back.as_bool();
        t.can_go_forward = forward.as_bool();
        t.is_audio_playing = audio.as_bool();
        if model::is_web_url(&source) {
            t.url = source;
        }
        changed
    });
    if changed {
        emit(app);
    }
}
pub fn poll(v: &Webview, id: u64) {
    let app = v.app_handle().clone();
    let _ = v.with_webview(move |w| unsafe {
        if let Ok(core) = w.controller().CoreWebView2() {
            refresh(&app, id, &core);
        }
    });
}
pub fn history(v: &Webview, forward: bool) -> Result<()> {
    v.with_webview(move |w| unsafe {
        if let Ok(c) = w.controller().CoreWebView2() {
            if forward {
                let _ = c.GoForward();
            } else {
                let _ = c.GoBack();
            }
        }
    })
    .map_err(err)
}
pub fn install(v: &Webview, id: u64) -> Result<()> {
    let app = v.app_handle().clone();
    v.with_webview(move |w| unsafe {
        let result = (|| -> windows::core::Result<()> {
            let core = w.controller().CoreWebView2()?;
            let mut token = 0;
            let a = app.clone();
            core.add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(c) = sender {
                        refresh(&a, id, &c);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            let a = app.clone();
            core.add_ContainsFullScreenElementChanged(
                &ContainsFullScreenElementChangedEventHandler::create(Box::new(
                    move |sender, _| {
                        if let Some(c) = sender {
                            let mut enter = BOOL(0);
                            c.ContainsFullScreenElement(&mut enter)?;
                            enqueue(
                                a.clone(),
                                json!({"type":"htmlFullscreen","id":id,"entering":enter.as_bool()}),
                            );
                        }
                        Ok(())
                    },
                )),
                &mut token,
            )?;
            if let Ok(c) = core.cast::<ICoreWebView2_8>() {
                let a = app.clone();
                c.add_IsDocumentPlayingAudioChanged(
                    &IsDocumentPlayingAudioChangedEventHandler::create(Box::new(
                        move |sender, _| {
                            if let Some(c) = sender {
                                refresh(&a, id, &c);
                            }
                            Ok(())
                        },
                    )),
                    &mut token,
                )?;
            }
            install_downloads(&app, &core)?;
            import_cookies(&app, id, &core)?;
            refresh(&app, id, &core);
            Ok(())
        })();
        if let Err(e) = result {
            report(&app, format!("Browser integration: {e}"));
        }
    })
    .map_err(err)
}
pub fn install_popup(w: &tauri::WebviewWindow) {
    let app = w.app_handle().clone();
    let label = w.label().to_owned();
    let _ = w.with_webview(move |w| unsafe {
        if let Ok(c) = w.controller().CoreWebView2() {
            let _ = install_downloads(&app, &c);
            let mut token = 0;
            let _ = c.add_WindowCloseRequested(
                &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = w.close();
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    });
}
unsafe fn update_download(app: &AppHandle, id: u64, op: &ICoreWebView2DownloadOperation) {
    let mut received = 0;
    let mut total = 0;
    let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
    let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
    let _ = op.BytesReceived(&mut received);
    let _ = op.TotalBytesToReceive(&mut total);
    let _ = op.State(&mut state);
    let _ = op.InterruptReason(&mut reason);
    let status = if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
        "completed"
    } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
        if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
            "cancelled"
        } else if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_PAUSED {
            "paused"
        } else {
            "interrupted"
        }
    } else {
        "progressing"
    };
    edit(app, |b| {
        if let Some(d) = b.state.downloads.iter_mut().find(|d| d.id == id) {
            d.received_bytes = received;
            d.total_bytes = total;
            d.state = status.into();
        }
    });
    emit(app);
}
unsafe fn install_downloads(app: &AppHandle, core: &ICoreWebView2) -> windows::core::Result<()> {
    let c = core.cast::<ICoreWebView2_4>()?;
    let a = app.clone();
    let mut token = 0;
    c.add_DownloadStarting(
        &DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let op = args.DownloadOperation()?;
            let id = UNIQUE.fetch_add(1, Ordering::Relaxed);
            let path = text_property(|p| args.ResultFilePath(p));
            let url = text_property(|p| op.Uri(p));
            let name = PathBuf::from(&path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Download".into());
            args.SetHandled(true)?;
            edit(&a, |b| {
                b.state.downloads.insert(
                    0,
                    model::Download {
                        id,
                        filename: name,
                        url,
                        save_path: path,
                        state: "progressing".into(),
                        received_bytes: 0,
                        total_bytes: 0,
                        started_at: epoch_ms(),
                    },
                );
                let mut finished = 0;
                b.state.downloads.retain(|d| {
                    if matches!(d.state.as_str(), "progressing" | "paused") {
                        true
                    } else {
                        finished += 1;
                        finished <= 30
                    }
                });
            });
            DOWNLOADS.with(|d| {
                let keep: Vec<_> = snapshot(&a).downloads.iter().map(|d| d.id).collect();
                d.borrow_mut().retain(|k, _| keep.contains(k));
                d.borrow_mut().insert(id, op.clone());
            });
            let a2 = a.clone();
            let mut token = 0;
            op.add_BytesReceivedChanged(
                &BytesReceivedChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(op) = sender {
                        update_download(&a2, id, &op);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            let a2 = a.clone();
            op.add_StateChanged(
                &StateChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(op) = sender {
                        update_download(&a2, id, &op);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            update_download(&a, id, &op);
            Ok(())
        })),
        &mut token,
    )
}
pub fn cancel_download(app: &AppHandle, id: u64) -> Result<()> {
    app.run_on_main_thread(move || {
        DOWNLOADS.with(|d| {
            if let Some(op) = d.borrow().get(&id) {
                unsafe {
                    let _ = op.Cancel();
                }
            }
        })
    })
    .map_err(err)
}
pub async fn preview(v: &Webview) -> Result<Option<String>> {
    if !v.window().is_visible().map_err(err)? {
        return Ok(None);
    }
    let (send, recv) = tokio::sync::oneshot::channel();
    v.with_webview(move |w| unsafe {
        let mut visible = BOOL::default();
        if w.controller().IsVisible(&mut visible).is_err() || !visible.as_bool() {
            let _ = send.send(None);
            return;
        }
        let result = (|| -> windows::core::Result<()> {
            let c = w.controller().CoreWebView2()?;
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
            let output = stream.clone();
            let callback = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                let image = (|| -> windows::core::Result<String> {
                    result?;
                    let mut stat = STATSTG::default();
                    output.Stat(&mut stat, STATFLAG_NONAME)?;
                    if stat.cbSize > 20_000_000 {
                        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                            0x8007000Eu32 as i32,
                        )));
                    }
                    output.Seek(0, STREAM_SEEK_SET, None)?;
                    let mut bytes = vec![0u8; stat.cbSize as usize];
                    let mut read = 0;
                    output
                        .Read(bytes.as_mut_ptr() as _, bytes.len() as u32, Some(&mut read))
                        .ok()?;
                    bytes.truncate(read as usize);
                    Ok(format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    ))
                })();
                let _ = send.send(image.ok());
                Ok(())
            }));
            c.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &callback,
            )
        })();
        let _ = result;
    })
    .map_err(err)?;
    Ok(tokio::time::timeout(Duration::from_secs(5), recv)
        .await
        .ok()
        .and_then(|v| v.ok())
        .flatten())
}
async fn mute(v: &Webview, toggle: bool) -> Result<bool> {
    let (send, recv) = tokio::sync::oneshot::channel();
    v.with_webview(move |w| unsafe {
        let value = (|| -> windows::core::Result<bool> {
            let c = w.controller().CoreWebView2()?.cast::<ICoreWebView2_8>()?;
            let mut value = BOOL(0);
            c.IsMuted(&mut value)?;
            let value = if toggle {
                !value.as_bool()
            } else {
                value.as_bool()
            };
            if toggle {
                c.SetIsMuted(value)?;
            }
            Ok(value)
        })();
        let _ = send.send(value.map_err(err));
    })
    .map_err(err)?;
    tokio::time::timeout(Duration::from_secs(5), recv)
        .await
        .map_err(|_| "Mute request timed out")?
        .map_err(err)?
}
pub async fn toggle_mute(v: &Webview) -> Result<bool> {
    mute(v, true).await
}
pub async fn is_muted(v: &Webview) -> Result<bool> {
    mute(v, false).await
}

/// The shell's media button is a user action. Propagate that activation through
/// WebView2's protocol API so play() is not rejected by autoplay policy.
pub async fn user_gesture(v: &Webview, script: &str) -> Result<Value> {
    let script = script.to_owned();
    let (send, recv) = tokio::sync::oneshot::channel();
    v.with_webview(move |w| unsafe {
        let result = (|| -> windows::core::Result<()> {
            let core = w.controller().CoreWebView2()?;
            let args = windows::core::HSTRING::from(json!({"expression":script,"userGesture":true,"returnByValue":true,"awaitPromise":true}).to_string());
            core.CallDevToolsProtocolMethod(windows::core::w!("Runtime.evaluate"), &args,
                &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, raw| {
                    let value = result.map_err(err).and_then(|_| serde_json::from_str::<Value>(&raw).map_err(err)).and_then(|value| {
                        if !value["exceptionDetails"].is_null() { Err("The website could not perform this media action".into()) }
                        else { Ok(value["result"]["value"].clone()) }
                    });
                    let _ = send.send(value); Ok(())
                })))
        })(); let _ = result;
    }).map_err(err)?;
    tokio::time::timeout(Duration::from_secs(8), recv)
        .await
        .map_err(|_| "Media action timed out")?
        .map_err(err)?
}

pub fn register_protocol() -> Result<()> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(err)?;
    let command = format!("\"{}\" \"%1\"", exe.display());
    // Existing shortcuts keep working after the product and executable rename.
    for scheme in ["tabbar", "sidebar"] {
        let key = format!(r"HKCU\Software\Classes\{scheme}");
        let open = format!(r"{key}\shell\open\command");
        for args in [
            vec!["add", &key, "/ve", "/d", "URL:Tabbar Protocol", "/f"],
            vec!["add", &key, "/v", "URL Protocol", "/d", "", "/f"],
            vec!["add", &open, "/ve", "/d", &command, "/f"],
        ] {
            let output = std::process::Command::new("reg.exe")
                .args(args)
                .creation_flags(0x08000000)
                .output()
                .map_err(err)?;
            if !output.status.success() {
                return Err("Windows could not register the Tabbar link handler".into());
            }
        }
    }
    Ok(())
}

unsafe fn import_cookies(
    app: &AppHandle,
    id: u64,
    core: &ICoreWebView2,
) -> windows::core::Result<()> {
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };
    let s = snapshot(app);
    let pin = s.tabs.iter().find(|t| t.id == id).and_then(|t| {
        s.settings
            .pins
            .iter()
            .find(|p| Some(&p.id) == t.pin_id.as_ref())
    });
    let partition = pin
        .and_then(|p| p.partition.as_deref())
        .unwrap_or("persist:sidebar-browser");
    let filename: String = partition.bytes().map(|b| format!("{b:02x}")).collect();
    let Ok(base) = app.path().app_local_data_dir() else {
        return Ok(());
    };
    let file = base.join("migration").join(format!("{filename}.bin"));
    let Ok(mut bytes) = fs::read(&file) else {
        return Ok(());
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    CryptUnprotectData(
        &input,
        None,
        None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        &mut output,
    )?;
    let cookies = serde_json::from_slice::<Vec<Value>>(std::slice::from_raw_parts(
        output.pbData,
        output.cbData as usize,
    ));
    std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
    LocalFree(Some(HLOCAL(output.pbData as _)));
    let Ok(cookies) = cookies else { return Ok(()) };
    let manager = core.cast::<ICoreWebView2_2>()?.CookieManager()?;
    let mut imported = 0;
    let mut skipped = 0;
    for c in cookies {
        let text = |key: &str| HSTRING::from(c[key].as_str().unwrap_or(""));
        let outcome = (|| -> windows::core::Result<()> {
            let cookie = manager.CreateCookie(
                &text("name"),
                &text("value"),
                &text("domain"),
                &text("path"),
            )?;
            cookie.SetIsHttpOnly(c["httpOnly"].as_bool().unwrap_or(false))?;
            cookie.SetIsSecure(c["secure"].as_bool().unwrap_or(false))?;
            if let Some(expires) = c["expirationDate"].as_f64() {
                cookie.SetExpires(expires)?;
            }
            cookie.SetSameSite(match c["sameSite"].as_str() {
                Some("strict") => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                Some("no_restriction") => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
                _ => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
            })?;
            manager.AddOrUpdateCookie(&cookie)
        })();
        if outcome.is_ok() {
            imported += 1;
        } else {
            skipped += 1;
        }
    }
    let _ = fs::write(
        file.with_extension("report.json"),
        json!({"imported":imported,"skipped":skipped}).to_string(),
    );
    let _ = fs::remove_file(&file);
    if imported > 0 {
        let _ = core.Reload();
    }
    Ok(())
}
