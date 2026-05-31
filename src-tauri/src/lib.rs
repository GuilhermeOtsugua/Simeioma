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
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
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
        .invoke_handler(tauri::generate_handler![save_text_file, save_binary_file, is_left_mouse_down, read_clipboard_text, write_clipboard_text])
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
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let _ = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?role=settings".into()),
    )
    .title("Simeioma Settings")
    .inner_size(380.0, 520.0)
    .min_inner_size(340.0, 440.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(false)
    .resizable(true)
    .build();
}
