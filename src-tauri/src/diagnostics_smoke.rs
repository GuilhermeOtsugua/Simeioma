//! Opt-in native integration fixture. Never runs against the regular app identity.
mod behavior;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Manager;

static ASSERTIONS: std::sync::Mutex<std::collections::BTreeMap<u8, bool>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[tauri::command]
pub fn smoke_assert(app: tauri::AppHandle, case_id: u8, passed: bool) -> Result<(), String> {
    if app.config().identifier != "com.otsugua.simeioma.diagnosticstest"
        || std::env::var("SIMEIOMA_DEBUG_SMOKE_TEST").as_deref() != Ok("1")
        || std::env::var("SIMEIOMA_DEBUG_SESSION").as_deref() != Ok("clean") || case_id > 15 {
        return Err("Not an isolated fixture".into());
    }
    ASSERTIONS.lock().map_err(|_| "fixture unavailable")?.insert(case_id, passed);
    Ok(())
}
async fn expect_assertion(case_id: u8) -> Result<(), String> {
    for _ in 0..50 {
        if let Some(passed) = ASSERTIONS.lock().map_err(|_| "fixture unavailable")?.get(&case_id).copied() {
            return if passed { Ok(()) } else { Err(format!("native assertion {case_id} failed")) };
        }
        wait(100).await;
    }
    Err(format!("native assertion {case_id} timed out"))
}

pub fn start(app: &tauri::App) {
    if std::env::var("SIMEIOMA_DEBUG_SMOKE_TEST").as_deref() != Ok("1") {
        return;
    }
    if app.config().identifier != "com.otsugua.simeioma.diagnosticstest"
        || std::env::var("SIMEIOMA_DEBUG_SESSION").as_deref() != Ok("clean")
    {
        eprintln!("Refusing smoke test outside isolated clean application identity.");
        return;
    }
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let result = run(&handle).await;
        let success = result.is_ok();
        if let Ok(dir) = handle.path().app_log_dir() {
            let dir = dir.join("diagnostics");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("smoke-result.json"), json!({
                "passed": success, "failure": result.as_ref().err(), "spawn": result.as_ref().ok(),
                "checks": ["frontend-bootstrap", "expanded-confirmation", "clipping-captured", "resize-failure-recovery", "delayed-resize", "missing-response-marked", "ipc-redaction", "reopened-window-identity", "settled-window-snapshot", "stale-instance-rejection", "writer-health", "persistent-geometry-mismatch", "queue-stall-watchdog", "saved-note-versus-native-geometry", "bounded-note-spawn", "edge-clone-geometry", "utility-placement", "tray-settings-placement", "minimized-utility-reservation", "compact-utility-size-preserved", "utility-opening-order", "editor-composition-source-integrity", "editor-undo-redo-cancel", "cross-webview-mutation-lock", "corrupt-session-recovery", "complete-content-png-export", "sketch-pending-save-continuity", "sketch-active-stroke-refresh"]
            }).to_string());
        }
        eprintln!("Native diagnostics smoke test passed: {success}");
        handle.exit(if success { 0 } else { 1 });
    });
}

async fn wait(ms: u64) {
    let _ =
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
            .await;
}

async fn bundle(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = super::diagnostics::export_bundle(app.clone()).await?;
    serde_json::from_slice(&std::fs::read(path).map_err(|_| "smoke bundle read failed")?)
        .map_err(|_| "smoke bundle parse failed".into())
}

async fn expect_width(app: &tauri::AppHandle, width: u64) -> Result<Value, String> {
    for _ in 0..12 {
        wait(150).await;
        let bundle = bundle(app).await?;
        if bundle["frontend"]["main"]["data"]["viewport"]["width"] == width
            && bundle["frontend"]["main"]["data"]["launcher"]["configuring"] == false
        {
            return Ok(bundle);
        }
    }
    Err(format!("viewport did not settle at {width}"))
}

async fn expect_window(app: &tauri::AppHandle, label: &str) -> Result<Value, String> {
    let alias = super::diagnostics::smoke_window_alias(app, label)?;
    for _ in 0..12 {
        wait(150).await;
        let capture = bundle(app).await?;
        if capture["frontend"][&alias]["data"]["requestId"] == capture["requestId"]
            && capture["frontend"][&alias]["data"]["rendererId"].is_number()
        {
            return Ok(capture);
        }
    }
    Err(format!("{alias} did not report a fresh snapshot"))
}

async fn run(app: &tauri::AppHandle) -> Result<Value, String> {
    let main = app.get_webview_window("main").ok_or("missing launcher")?;
    let evaluate = |js: &str| {
        main.eval(js)
            .map_err(|_| "smoke evaluation failed".to_string())
    };
    expect_width(app, 30).await?;
    // An incorrect size with no dialog must also be caught after it persists.
    main.set_size(tauri::LogicalSize::new(40.0, 112.0))
        .map_err(|_| "size mismatch fixture failed")?;
    wait(2500).await;
    let mismatch = bundle(app).await?;
    if !mismatch["anomalies"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|a| a["event"] == "geometry-mismatch" && a["frontend"]["viewport"]["width"] == 40)
    }) {
        return Err("persistent size mismatch was not captured".into());
    }
    main.set_size(tauri::LogicalSize::new(30.0, 112.0))
        .map_err(|_| "size mismatch recovery failed")?;
    expect_width(app, 30).await?;
    evaluate("{ const identity = window.__SIMEIOMA_DIAGNOSTICS__.status(); window.__TAURI_INTERNALS__.invoke('debug_record', {event: 'frontend-error', instanceId: identity.instanceId, data: {rendererId: identity.rendererId, line: 4321, text: 'SIMEIOMA_PRIVATE_SENTINEL', exportPath: 'SIMEIOMA_PRIVATE_SENTINEL'}, noteLabels: []}); }")?;
    wait(100).await;
    let redacted = bundle(app).await?;
    if redacted.to_string().contains("SIMEIOMA_PRIVATE_SENTINEL")
        || !redacted["events"].as_array().is_some_and(|events| {
            events
                .iter()
                .any(|event| event["event"] == "frontend-error" && event["data"]["line"] == 4321)
        })
    {
        return Err("IPC redaction failed".into());
    }
    main.set_focus().map_err(|_| "launcher focus failed")?;
    wait(150).await;
    evaluate("document.querySelector('.launcher-strip').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2}));")?;
    expect_width(app, 64).await?;
    super::diagnostics::smoke_stall_next_resize(app)?;
    evaluate("document.querySelector('[aria-label=\"Close Simeioma\"]').click();")?;
    wait(7000).await;
    let stalled = bundle(app).await?;
    if !stalled["anomalies"]
        .as_array()
        .is_some_and(|items| items.iter().any(|a| a["event"] == "queue-stalled"))
    {
        return Err("stalled queue was not captured".into());
    }
    let expanded = expect_width(app, 360).await?;
    if expanded["frontend"]["main"]["data"]["dialog"]["clipped"] != false {
        return Err("expanded dialog is clipped".into());
    }

    // Recreate the exact native bounds responsible for the original two-pixel sliver.
    main.set_size(tauri::LogicalSize::new(64.0, 204.0))
        .map_err(|_| "smoke native resize failed")?;
    wait(350).await;
    let clipped = expect_width(app, 64).await?;
    if clipped["frontend"]["main"]["data"]["dialog"]["clipped"] != true
        || !clipped["anomalies"].as_array().is_some_and(|items| {
            items.iter().any(|a| {
                a["frontend"]["viewport"]["width"] == 64
                    && a["frontend"]["dialog"]["clipped"] == true
            })
        })
    {
        return Err("clipping was not captured".into());
    }
    main.set_size(tauri::LogicalSize::new(360.0, 204.0))
        .map_err(|_| "smoke native restoration failed")?;
    expect_width(app, 360).await?;

    evaluate("document.querySelector('.exit-confirmation button:last-child').click();")?;
    expect_width(app, 64).await?;
    super::diagnostics::tray_action(app, "debug-fail");
    evaluate("document.querySelector('[aria-label=\"Close Simeioma\"]').click();")?;
    wait(500).await;
    let failed = expect_width(app, 64).await?;
    if !failed["events"].as_array().is_some_and(|events| {
        events
            .iter()
            .any(|event| event["event"] == "configuration-failed")
    }) {
        return Err("injected failure was not recorded".into());
    }
    evaluate("document.querySelector('.exit-confirmation button:last-child').click();")?;
    expect_width(app, 64).await?;
    super::diagnostics::tray_action(app, "debug-delay");
    evaluate("document.querySelector('[aria-label=\"Close Simeioma\"]').click();")?;
    expect_width(app, 360).await?;
    super::diagnostics::tray_action(app, "debug-clear");

    // Reopening a reused role label must produce a distinct native instance.
    let open_settings = |width, height| {
        tauri::WebviewWindowBuilder::new(
            app,
            "settings",
            tauri::WebviewUrl::App("index.html?role=settings".into()),
        )
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(|_| "settings fixture failed".to_string())
    };
    let settings = open_settings(434.0, 548.0)?;
    let first = expect_window(app, "settings").await?;
    let first_instance = first["frontend"]["settings"]["instance"].clone();
    settings
        .close()
        .map_err(|_| "settings fixture close failed")?;
    for _ in 0..30 {
        if app.get_webview_window("settings").is_none() {
            break;
        }
        wait(50).await;
    }
    let settings = open_settings(280.0, 300.0)?;
    let reopened = expect_window(app, "settings").await?;
    if reopened["frontend"]["settings"]["data"]["viewport"]["width"] != 280
        || reopened["frontend"]["settings"]["data"]["viewport"]["height"] != 300 {
        return Err("compact utility was reset to default dimensions".into());
    }
    if reopened["frontend"]["settings"]["instance"] == first_instance {
        return Err("window instance was reused".into());
    }
    settings
        .set_position(tauri::LogicalPosition::new(300.0, 250.0))
        .map_err(|_| "fixture movement failed")?;
    // Inspect the passive post-movement snapshot, not one caused by exporting.
    wait(700).await;
    let moved = bundle(app).await?;
    if !moved["events"].as_array().is_some_and(|events| {
        events.iter().any(|e| {
            e["event"] == "snapshot"
                && e["window"] == "settings"
                && e["data"]["requestId"] == 0
                && e["data"]["native"]["position"]["x"] == 300
                && e["data"]["native"]["position"]["y"] == 250
        })
    }) {
        return Err("settled movement snapshot missing".into());
    }
    settings
        .close()
        .map_err(|_| "settings fixture close failed")?;
    evaluate("{ const identity = window.__SIMEIOMA_DIAGNOSTICS__.status(); window.__TAURI_INTERNALS__.invoke('debug_record', {event: 'snapshot', instanceId: identity.instanceId + 999, data: {rendererId: identity.rendererId, requestId: 0}, noteLabels: []}).catch(() => {}); }")?;
    wait(100).await;
    let stale = bundle(app).await?;
    if stale["staleReports"].as_u64().unwrap_or(0) == 0 {
        return Err("stale instance was accepted".into());
    }
    if stale["writerFlushComplete"] != true
        || stale["writer"]["ioFailures"] != 0
        || stale["writer"]["dropped"] != 0
    {
        return Err("writer health failed".into());
    }

    // Exercise the real note persistence listener. Cancel preserves the menu unless a native
    // focus transition closed it; use a real action to close it rather than assuming OS activation.
    evaluate("document.querySelector('.exit-confirmation button:last-child').click(); document.querySelector('[aria-label=\"Open settings\"]')?.click();")?;
    expect_width(app, 30).await?;
    if let Some(settings) = app.get_webview_window("settings") { close_fixture(&settings, app).await?; }
    evaluate("document.querySelector('.launcher-strip').click();")?;
    let mut note_window = None;
    for _ in 0..30 {
        note_window = app
            .webview_windows()
            .into_iter()
            .find(|(label, window)| label.starts_with("note-") && window.is_visible().unwrap_or(false))
            .map(|(_, window)| window);
        if note_window.is_some() {
            break;
        }
        wait(100).await;
    }
    let note = note_window.ok_or("note fixture was not created")?;
    wait(500).await;
    note.set_position(tauri::LogicalPosition::new(600.0, 360.0))
        .map_err(|_| "note fixture move failed")?;
    wait(700).await;
    let saved = bundle(app).await?;
    let note_alias = saved["frontend"]["main"]["noteWindows"][0]
        .as_str()
        .ok_or("note mapping missing")?;
    let data = &saved["frontend"][note_alias]["data"];
    if data["requestId"] != saved["requestId"]
        || data["persistence"]["position"]["x"] != 600
        || data["persistence"]["position"]["y"] != 360
        || data["native"]["position"]["x"] != 600
        || data["native"]["position"]["y"] != 360
    {
        return Err("saved and native note geometry did not agree".into());
    }
    note.close().map_err(|_| "note fixture close failed")?;
    wait(150).await;

    let spawn = check_spawn_placement(app).await?;
    let checked = bundle(app).await?;
    if checked["events"].as_array().is_some_and(|events| events.iter().any(|event| event["event"] == "unhandled-rejection")) {
        return Err("unexpected frontend promise rejection during native fixture".into());
    }

    // A window without frontend instrumentation must be reported, not silently omitted.
    let missing = tauri::WebviewWindowBuilder::new(
        app,
        "smoke-missing",
        tauri::WebviewUrl::External("about:blank".parse().map_err(|_| "invalid blank URL")?),
    )
    .visible(false)
    .build()
    .map_err(|_| "missing-response fixture failed")?;
    wait(200).await;
    let incomplete = bundle(app).await?;
    if incomplete["missingFrontendResponses"]
        .as_array()
        .is_none_or(|items| items.is_empty())
    {
        return Err("missing frontend response was not reported".into());
    }
    missing.close().map_err(|_| "fixture close failed")?;
    Ok(spawn)
}

fn logical_rect(window: &tauri::WebviewWindow) -> Result<[f64; 4], String> {
    let scale = window.scale_factor().map_err(|_| "fixture scale unavailable")?;
    let position = window.outer_position().map_err(|_| "fixture position unavailable")?;
    let size = window.inner_size().map_err(|_| "fixture size unavailable")?;
    Ok([position.x as f64 / scale, position.y as f64 / scale, size.width as f64 / scale, size.height as f64 / scale])
}

fn same_rect(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a.iter().zip(b).all(|(a, b)| (a - b).abs() <= 1.0)
}

fn overlaps(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]
}

async fn expect_notes(app: &tauri::AppHandle, count: usize) -> Result<Vec<tauri::WebviewWindow>, String> {
    for _ in 0..50 {
        let notes: Vec<_> = app.webview_windows().into_iter().filter(|(label, window)| label.starts_with("note-") && window.is_visible().unwrap_or(false)).map(|(_, window)| window).collect();
        if notes.len() == count { return Ok(notes); }
        wait(100).await;
    }
    Err(format!("expected {count} native notes"))
}

async fn close_fixture(window: &tauri::WebviewWindow, app: &tauri::AppHandle) -> Result<(), String> {
    window.close().map_err(|_| "fixture close failed")?;
    for _ in 0..30 {
        if app.get_webview_window(window.label()).is_none() { return Ok(()); }
        wait(50).await;
    }
    Err("fixture did not close".into())
}

async fn check_spawn_placement(app: &tauri::AppHandle) -> Result<Value, String> {
    let main = app.get_webview_window("main").ok_or("missing launcher")?;
    let monitor = main.current_monitor().map_err(|_| "fixture monitor unavailable")?.ok_or("fixture monitor unavailable")?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let left = work.position.x as f64 / scale;
    let top = work.position.y as f64 / scale;
    let right = (work.position.x as f64 + work.size.width as f64) / scale;
    let bottom = (work.position.y as f64 + work.size.height as f64) / scale;
    let note_bottom = bottom - 12.0 - (184.0 - 96.0) / 2.0;
    main.set_position(tauri::LogicalPosition::new(left + 19.0, bottom - 160.0)).map_err(|_| "launcher fixture movement failed")?;
    wait(350).await;
    main.eval("document.querySelector('.launcher-strip').click();").map_err(|_| "note creation evaluation failed")?;
    let source = expect_notes(app, 1).await?.remove(0);
    expect_window(app, source.label()).await?;
    behavior::run(app, &main, &source).await?;
    source.set_size(tauri::LogicalSize::new(320.0, 240.0)).map_err(|_| "source resize failed")?;
    source.set_position(tauri::LogicalPosition::new(left + 80.0, note_bottom - 250.0)).map_err(|_| "source placement failed")?;
    let anchor = logical_rect(&source)?;
    // Real frontend creation queue, deliberately before the debounced source persistence settles.
    main.eval("{ const strip = document.querySelector('.launcher-strip'); for (let i = 0; i < 2; i++) strip.dispatchEvent(new PointerEvent('pointerup', {bubbles: true})); }").map_err(|_| "burst creation evaluation failed")?;
    let notes = expect_notes(app, 3).await?;
    wait(400).await;
    for note in &notes {
        if !same_rect(&logical_rect(note)?, &anchor) { return Err("bounded note did not inherit exact anchor geometry".into()); }
    }
    // The keyboard path must retain a partially off-screen source, including its dimensions.
    source.set_position(tauri::LogicalPosition::new(left - 40.0, note_bottom - 20.0)).map_err(|_| "edge source placement failed")?;
    let edge = logical_rect(&source)?;
    source.eval("window.dispatchEvent(new KeyboardEvent('keydown', {key: 'n', ctrlKey: true, bubbles: true, cancelable: true}));").map_err(|_| "shortcut evaluation failed")?;
    let all_notes = expect_notes(app, 4).await?;
    let clone = all_notes.iter().find(|candidate| !notes.iter().any(|old| old.label() == candidate.label())).ok_or("edge clone missing")?;
    expect_window(app, clone.label()).await?;
    let cloned = logical_rect(clone)?;
    if !same_rect(&edge, &cloned) { return Err("manual edge override was clamped or resized".into()); }

    super::show_settings(app); // The actual tray handler, not a second native builder.
    expect_window(app, "settings").await?;
    let settings = app.get_webview_window("settings").ok_or("tray settings missing")?;
    let settings_rect = logical_rect(&settings)?;
    settings.minimize().map_err(|_| "settings minimize failed")?;
    wait(200).await;
    main.eval("document.querySelector('.launcher-strip').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2}));").map_err(|_| "list menu evaluation failed")?;
    expect_width(app, 64).await?;
    main.eval("document.querySelector('[aria-label=\"Open session notes\"]').click();").map_err(|_| "list creation evaluation failed")?;
    expect_window(app, "notes-list").await?;
    let list = app.get_webview_window("notes-list").ok_or("notes list missing")?;
    let list_rect = logical_rect(&list)?;
    if !settings.is_minimized().map_err(|_| "settings state unavailable")? { return Err("opening notes list restored the minimized settings window".into()); }
    if overlaps(&settings_rect, &list_rect) { return Err("utilities spawned on top of each other".into()); }
    for rect in [&settings_rect, &list_rect] {
        if rect[0] < left + 11.0 || rect[1] < top + 11.0 || rect[0] + rect[2] > right - 11.0 || rect[1] + rect[3] > bottom - 11.0 { return Err("utility spawned outside work area".into()); }
        for note in &all_notes {
            if overlaps(rect, &logical_rect(note)?) { return Err("utility covered a visible note at spawn".into()); }
        }
    }
    super::show_settings(app);
    wait(250).await;
    if !same_rect(&settings_rect, &logical_rect(&settings)?) { return Err("restoring settings moved or resized it".into()); }
    // Reverse opening order; deterministic slots should be unchanged.
    close_fixture(&settings, app).await?;
    close_fixture(&list, app).await?;
    main.eval("document.querySelector('.launcher-strip').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2}));").map_err(|_| "reverse menu evaluation failed")?;
    expect_width(app, 64).await?;
    main.eval("document.querySelector('[aria-label=\"Open session notes\"]').click();").map_err(|_| "reverse list evaluation failed")?;
    expect_window(app, "notes-list").await?;
    super::show_settings(app);
    expect_window(app, "settings").await?;
    let settings = app.get_webview_window("settings").ok_or("reopened settings missing")?;
    let list = app.get_webview_window("notes-list").ok_or("reopened list missing")?;
    if !same_rect(&settings_rect, &logical_rect(&settings)?) || !same_rect(&list_rect, &logical_rect(&list)?) { return Err("utility opening order changed spawn slots".into()); }
    close_fixture(&settings, app).await?;
    close_fixture(&list, app).await?;
    for note in all_notes { close_fixture(&note, app).await?; }
    Ok(json!({"bottomLimit": note_bottom, "boundedAnchor": anchor, "boundedCopies": 2,
        "edgeSource": edge, "edgeClone": cloned, "settings": settings_rect, "notesList": list_rect,
        "minimizedReservationPreserved": true, "openingOrderStable": true}))
}
