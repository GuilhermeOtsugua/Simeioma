#[cfg(any(windows, test))]
mod clipboard_text;
#[cfg(debug_assertions)]
mod diagnostics_store;
#[cfg(debug_assertions)]
mod diagnostics_writer;
#[cfg(debug_assertions)]
mod diagnostics;
#[cfg(debug_assertions)]
mod diagnostics_smoke;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[derive(Default)]
struct PendingSettings(std::sync::atomic::AtomicBool);

#[tauri::command]
fn take_settings_request(window: tauri::WebviewWindow, pending: tauri::State<PendingSettings>) -> bool {
    window.label() == "main" && pending.0.swap(false, std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
fn save_text_file(directory: String, filename: String, contents: String) -> Result<String, String> {
    let path = export_path(directory, filename)?;
    std::fs::write(&path, contents).map_err(|error| error.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_binary_file(directory: String, filename: String, bytes: Vec<u8>) -> Result<String, String> {
    let path = export_path(directory, filename)?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn visible_note_window_labels(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            (label.starts_with("note-") && window.is_visible().unwrap_or(false)
                && !window.is_minimized().unwrap_or(false)).then_some(label)
        })
        .collect()
}

#[tauri::command]
fn set_note_windows_visibility(
    app: tauri::AppHandle,
    labels: Vec<String>,
    visible: bool,
) -> Result<(), String> {
    for label in &labels {
        if !label.starts_with("note-") {
            continue;
        }
        if let Some(window) = app.get_webview_window(label) {
            if visible {
                window.unminimize().map_err(|error| error.to_string())?;
                window.show().map_err(|error| error.to_string())?;
            } else {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
    }
    if visible {
        order_note_windows(&app, &labels)?;
        raise_control_window(&app, "main");
    }
    Ok(())
}

#[tauri::command]
fn restore_utility_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if !matches!(label.as_str(), "settings" | "notes-list") {
        return Ok(());
    }
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    restore_and_focus_utility(&window)
}

#[tauri::command]
fn window_spawn_geometry(app: tauri::AppHandle, label: String) -> Result<serde_json::Value, String> {
    if !matches!(label.as_str(), "main" | "settings" | "notes-list") && !label.starts_with("note-") {
        return Err("Invalid spawn window".into());
    }
    let window = app.get_webview_window(&label).ok_or("Spawn window closed")?;
    let (position, outer) = window_restore_bounds(&window)?;
    let inner = if window.is_minimized().map_err(|_| "Window state unavailable")? { outer }
        else { window.inner_size().map_err(|_| "Window size unavailable")? };
    let monitor = match window.current_monitor().map_err(|_| "Monitor unavailable")? {
        Some(monitor) => monitor,
        None => window.primary_monitor().map_err(|_| "Monitor unavailable")?.ok_or("Monitor unavailable")?,
    };
    let work = monitor.work_area();
    Ok(serde_json::json!({
        "position": {"x": position.x, "y": position.y},
        "outer": {"width": outer.width, "height": outer.height},
        "inner": {"width": inner.width, "height": inner.height},
        "monitor": {"scaleFactor": monitor.scale_factor(), "workArea": {
            "position": {"x": work.position.x, "y": work.position.y},
            "size": {"width": work.size.width, "height": work.size.height}
        }}
    }))
}

fn window_restore_bounds(window: &tauri::WebviewWindow) -> Result<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>), String> {
    #[cfg(windows)]
    if window.is_minimized().map_err(|_| "Window state unavailable")? {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GetWindowPlacement, GWL_EXSTYLE, WINDOWPLACEMENT, WS_EX_TOOLWINDOW};
        let hwnd = window.hwnd().map_err(|_| "Window handle unavailable")?.0 as _;
        let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
        placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        if unsafe { GetWindowPlacement(hwnd, &mut placement) } == 0 { return Err("Restore bounds unavailable".into()); }
        // Normal app windows use workspace coordinates; tool windows use screen coordinates.
        let mut offset = (0, 0);
        if unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW == 0 {
            let monitor = window.current_monitor().map_err(|_| "Monitor unavailable")?.ok_or("Monitor unavailable")?;
            offset = (monitor.work_area().position.x - monitor.position().x, monitor.work_area().position.y - monitor.position().y);
        }
        let rect = placement.rcNormalPosition;
        return Ok((tauri::PhysicalPosition::new(rect.left + offset.0, rect.top + offset.1),
            tauri::PhysicalSize::new((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32)));
    }
    let position = window.outer_position().map_err(|_| "Window position unavailable")?;
    let size = window.outer_size().map_err(|_| "Window size unavailable")?;
    Ok((position, size))
}

#[tauri::command]
fn set_utility_focus_state(
    app: tauri::AppHandle,
    label: String,
    focused: bool,
) -> Result<(), String> {
    if !matches!(label.as_str(), "settings" | "notes-list") {
        return Ok(());
    }
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    set_utility_window_level(&window, focused)
}

#[tauri::command]
fn raise_control(app: tauri::AppHandle, label: String) {
    if matches!(label.as_str(), "main" | "settings" | "notes-list") {
        raise_control_window(&app, &label);
    }
}

fn raise_control_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = raise_window_without_focus(&window);
    }
}

#[cfg(windows)]
fn order_note_windows(app: &tauri::AppHandle, labels: &[String]) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::HWND_TOPMOST;

    for label in labels {
        if let Some(window) = app.get_webview_window(label) {
            set_window_position(&window, HWND_TOPMOST, true)?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn order_note_windows(_app: &tauri::AppHandle, _labels: &[String]) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn restore_and_focus_utility<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, ShowWindow, HWND_TOPMOST, SW_RESTORE,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    unsafe {
        ShowWindow(hwnd, SW_RESTORE);
    }
    set_window_position(window, HWND_TOPMOST, true)?;
    unsafe {
        SetForegroundWindow(hwnd);
    }
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn restore_and_focus_utility<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(windows)]
fn set_utility_window_level<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    focused: bool,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST,
        WS_EX_TOPMOST,
    };

    if focused {
        return set_window_position(window, HWND_TOPMOST, false);
    }

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let foreground = unsafe { GetForegroundWindow() };
    let foreground_is_topmost = !foreground.is_null()
        && unsafe { GetWindowLongPtrW(foreground, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST != 0;
    let insert_after = if foreground.is_null() || foreground == hwnd || foreground_is_topmost {
        HWND_NOTOPMOST
    } else {
        foreground
    };
    set_window_position(window, insert_after, false)
}

#[cfg(not(windows))]
fn set_utility_window_level<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    focused: bool,
) -> Result<(), String> {
    window
        .set_always_on_top(focused)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn raise_window_without_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::HWND_TOPMOST;

    set_window_position(window, HWND_TOPMOST, false)
}

#[cfg(not(windows))]
fn raise_window_without_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn set_window_position<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    insert_after: windows_sys::Win32::Foundation::HWND,
    show: bool,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let flags = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | if show { SWP_SHOWWINDOW } else { 0 };
    let result = unsafe { SetWindowPos(hwnd.0, insert_after, 0, 0, 0, 0, flags) };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[tauri::command]
fn is_left_mouse_down() -> bool {
    left_mouse_down()
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    read_clipboard_text_native()
}

#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn read_clipboard_text_native() -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock, GlobalSize};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("Could not open clipboard.".to_string());
        }
        struct OpenClipboardGuard;
        impl Drop for OpenClipboardGuard { fn drop(&mut self) { unsafe { CloseClipboard(); } } }
        let _clipboard = OpenClipboardGuard;
        let handle = GetClipboardData(CF_UNICODETEXT as u32);
        if handle.is_null() { return Ok(String::new()); }
        let length = GlobalSize(handle);
        if length == 0 || length > isize::MAX as usize { return Err("Invalid clipboard allocation.".into()); }
        let pointer = GlobalLock(handle);
        if pointer.is_null() { return Err("Could not lock clipboard text.".into()); }
        struct LockedClipboardGuard(windows_sys::Win32::Foundation::HGLOBAL);
        impl Drop for LockedClipboardGuard { fn drop(&mut self) { unsafe { GlobalUnlock(self.0); } } }
        let _locked = LockedClipboardGuard(handle);
        clipboard_text::decode(std::slice::from_raw_parts(pointer.cast::<u8>(), length)).map_err(str::to_string)
    }
}

#[cfg(not(windows))]
fn read_clipboard_text_native() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn left_mouse_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

#[cfg(not(windows))]
fn left_mouse_down() -> bool {
    false
}

fn export_path(directory: String, filename: String) -> Result<std::path::PathBuf, String> {
    let directory = std::path::PathBuf::from(directory);

    if !directory.exists() {
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    }

    if !directory.is_dir() {
        return Err("Export path must be a directory.".to_string());
    }

    let safe_name = filename
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            _ => character,
        })
        .collect::<String>();

    Ok(directory.join(safe_name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(PendingSettings::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_launcher(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            diagnostics::setup(app);
            setup_tray(app)?;
            #[cfg(debug_assertions)]
            diagnostics_smoke::start(app);
            Ok(())
        });
    #[cfg(debug_assertions)]
    let builder = builder
        .plugin(diagnostics::plugin())
        .on_window_event(diagnostics::window_event)
        .invoke_handler(tauri::generate_handler![
            save_text_file,
            save_binary_file,
            visible_note_window_labels,
            set_note_windows_visibility,
            restore_utility_window,
            set_utility_focus_state,
            raise_control,
            is_left_mouse_down,
            read_clipboard_text,
            write_clipboard_text,
            take_settings_request,
            window_spawn_geometry,
            diagnostics_smoke::smoke_assert,
            diagnostics::debug_record,
            diagnostics::debug_register,
            diagnostics::debug_before_resize,
            diagnostics::debug_export,
        ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
            save_text_file,
            save_binary_file,
            visible_note_window_labels,
            set_note_windows_visibility,
            restore_utility_window,
            set_utility_focus_state,
            raise_control,
            is_left_mouse_down,
            read_clipboard_text,
            write_clipboard_text,
            take_settings_request,
            window_spawn_geometry,
        ]);
    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Simeioma", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Simeioma", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;
    #[cfg(debug_assertions)]
    menu.append(&diagnostics::tray_menu(app)?)?;
    let mut tray = TrayIconBuilder::with_id("simeioma")
        .menu(&menu)
        .tooltip("Simeioma")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_launcher(app),
            "settings" => show_settings(app),
            "quit" => app.exit(0),
            #[cfg(debug_assertions)]
            id if id.starts_with("debug-") => diagnostics::tray_action(app, id),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn show_launcher(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_settings(app: &tauri::AppHandle) {
    // The launcher owns the shared placement/creation queue. Retain early tray clicks
    // until its listener is ready, rather than constructing a differently placed Settings window here.
    app.state::<PendingSettings>().0.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = app.emit_to("main", "simeioma:settings-requested", ());
}
