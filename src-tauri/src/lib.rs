use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

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
            (label.starts_with("note-") && window.is_visible().unwrap_or(false)).then_some(label)
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
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("Could not open clipboard.".to_string());
        }
        let handle = GetClipboardData(CF_UNICODETEXT as u32);
        if handle.is_null() {
            CloseClipboard();
            return Ok(String::new());
        }
        let pointer = GlobalLock(handle);
        if pointer.is_null() {
            CloseClipboard();
            return Err("Could not lock clipboard text.".to_string());
        }
        let mut length = 0usize;
        let text_pointer = pointer as *const u16;
        while *text_pointer.add(length) != 0 {
            length += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(text_pointer, length));
        GlobalUnlock(handle);
        CloseClipboard();
        Ok(text)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_launcher(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Simeioma", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Simeioma", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;
    let mut tray = TrayIconBuilder::with_id("simeioma")
        .menu(&menu)
        .tooltip("Simeioma")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_launcher(app),
            "settings" => show_settings(app),
            "quit" => app.exit(0),
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
    if let Some(window) = app.get_webview_window("settings") {
        let _ = restore_and_focus_utility(&window);
        return;
    }

    let _ = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?role=settings".into()),
    )
    .title("Simeioma Settings")
    .inner_size(320.0, 440.0)
    .min_inner_size(280.0, 300.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(false)
    .skip_taskbar(false)
    .resizable(true)
    .build();
}
