//! Compiled and registered only with native debug assertions.
use crate::diagnostics_store::{now_ms, sanitize, Store};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const MAX_PAYLOAD: usize = 16 * 1024;
const MAX_WINDOWS: usize = 128;

pub struct Diagnostics(Mutex<Inner>, AtomicU64);
struct Inner {
    store: Store,
    snapshots: BTreeMap<String, Value>,
    renderers: BTreeMap<String, u64>,
    replies: BTreeMap<String, Value>,
    stale_reports: u64,
    anomalies: VecDeque<Value>,
    last_focus: Option<String>,
    move_times: BTreeMap<String, Instant>,
    rates: BTreeMap<String, (Instant, usize)>,
    dropped: u64,
    request_id: u64,
    exporting: bool,
    injection: Injection,
    smoke_stall_once: bool,
    smoke_phase: Option<&'static str>,
}

#[derive(Default)]
struct Injection {
    delay_ms: u64,
    fail_once: bool,
}
impl Injection {
    fn take(&mut self) -> Value {
        let fail = std::mem::take(&mut self.fail_once);
        json!({"delayMs": self.delay_ms.min(2000), "fail": fail})
    }
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let clean = std::env::var("SIMEIOMA_DEBUG_SESSION").as_deref() == Ok("clean");
    let session = now_ms();
    tauri::plugin::Builder::new("debug-bootstrap")
        .js_init_script(format!("Object.defineProperty(window, '__SIMEIOMA_DEBUG__', {{value: Object.freeze({{cleanSession: {clean}, session: '{session}'}})}});"))
        .build()
}

pub fn setup(app: &tauri::App) {
    let directory = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| dir.join("diagnostics"));
    let mut store = Store::new(directory, 1024 * 1024, 500);
    store.record("main", "session-start", json!({}));
    app.manage(Diagnostics(
        Mutex::new(Inner {
            store,
            snapshots: BTreeMap::new(),
            renderers: BTreeMap::new(),
            replies: BTreeMap::new(),
            stale_reports: 0,
            anomalies: VecDeque::new(),
            last_focus: Some("main".into()),
            move_times: BTreeMap::new(),
            rates: BTreeMap::new(),
            dropped: 0,
            request_id: 0,
            exporting: false,
            injection: Injection::default(),
            smoke_stall_once: false,
            smoke_phase: None,
        }),
        AtomicU64::new(0),
    ));
    let handle = app.handle().clone();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(state) = handle.try_state::<Diagnostics>() {
            if let Ok(mut inner) = state.0.try_lock() {
                inner.store.record(
                    "main",
                    "native-panic",
                    json!({"line": info.location().map(|l| l.line())}),
                );
            }
        }
        eprintln!("Simeioma native panic (message redacted); inspect diagnostic history.");
    }));
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let started = Instant::now();
    let Some(state) = window.app_handle().try_state::<Diagnostics>() else {
        return;
    };
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    let label = window.label();
    let (name, data) = match event {
        tauri::WindowEvent::Moved(position) => {
            if inner
                .move_times
                .get(label)
                .is_some_and(|at| at.elapsed() < Duration::from_millis(100))
            {
                return;
            }
            if inner.move_times.len() < MAX_WINDOWS {
                inner.move_times.insert(label.into(), Instant::now());
            }
            ("native-moved", json!({"x": position.x, "y": position.y}))
        }
        tauri::WindowEvent::Resized(size) => (
            "native-resized",
            json!({"width": size.width, "height": size.height}),
        ),
        tauri::WindowEvent::Focused(focused) => {
            if *focused {
                inner.last_focus = Some(label.into());
            }
            ("native-focused", json!({"focused": focused}))
        }
        tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
            ("native-scale-changed", json!({"scale": scale_factor}))
        }
        tauri::WindowEvent::Destroyed => {
            inner.snapshots.remove(label);
            inner.replies.remove(label);
            inner.move_times.remove(label);
            inner.rates.remove(label);
            inner.renderers.remove(label);
            ("native-destroyed", json!({}))
        }
        _ => return,
    };
    inner.store.record(label, name, data);
    if name == "native-destroyed" {
        inner.store.retire(label);
    }
    state
        .1
        .fetch_max(started.elapsed().as_micros() as u64, Ordering::Relaxed);
}

fn allowed_event(event: &str) -> bool {
    matches!(
        event,
        "frontend-ready"
            | "frontend-error"
            | "unhandled-rejection"
            | "resource-error"
            | "launcher-state"
            | "drag-start"
            | "drag-end"
            | "drag-native-return"
            | "drag-failed"
            | "drag-timeout"
            | "drag-superseded"
            | "drag-observation-failed"
            | "utility-placement"
            | "utility-placement-unavailable"
            | "queue-stalled"
            | "configuration-queued"
            | "configuration-started"
            | "configuration-completed"
            | "configuration-failed"
            | "resize-requested"
            | "resize-completed"
            | "position-requested"
            | "position-completed"
            | "native-command-failed"
            | "geometry-mismatch"
            | "state-saved"
            | "storage-error"
            | "snapshot"
            | "visibility-changed"
            | "frontend-focus"
            | "frontend-blur"
    )
}

#[tauri::command]
pub fn debug_register(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Diagnostics>,
    renderer_id: u64,
) -> Result<u64, String> {
    if renderer_id == 0 || renderer_id > 9_007_199_254_740_991 {
        return Err("invalid renderer identity".into());
    }
    let current = window
        .app_handle()
        .get_webview_window(window.label())
        .ok_or("closed diagnostic window")?;
    #[cfg(windows)]
    if window
        .hwnd()
        .ok()
        .zip(current.hwnd().ok())
        .is_none_or(|(old, live)| old != live)
    {
        return Err("replaced diagnostic window".into());
    }
    #[cfg(not(windows))]
    let _ = current;
    let mut inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
    let label = window.label();
    let instance = inner.store.instance(label);
    if instance == 0 {
        return Err("diagnostic window limit".into());
    }
    if inner.renderers.insert(label.into(), renderer_id) != Some(renderer_id) {
        inner.snapshots.remove(label);
        inner.replies.remove(label);
        inner.rates.remove(label);
        inner.store.record(
            label,
            "renderer-registered",
            json!({"rendererId": renderer_id}),
        );
    }
    Ok(instance)
}

fn snapshot_matches(
    snapshot: Option<&Value>,
    request_id: u64,
    instance: u64,
    renderer: u64,
) -> bool {
    snapshot.is_some_and(|s| {
        s["data"]["requestId"] == request_id
            && s["instance"] == instance
            && s["data"]["rendererId"] == renderer
    })
}

fn retain_reply(
    replies: &mut BTreeMap<String, Value>,
    active_request: Option<u64>,
    label: &str,
    snapshot: &Value,
) {
    if active_request.is_some_and(|id| snapshot["data"]["requestId"] == id) {
        replies.insert(label.into(), snapshot.clone());
    }
}

#[tauri::command]
pub async fn debug_record(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Diagnostics>,
    event: String,
    data: Value,
    note_labels: Option<Vec<String>>,
    instance_id: u64,
) -> Result<(), String> {
    if !allowed_event(&event) || data.to_string().len() > MAX_PAYLOAD {
        return Err("diagnostic payload rejected".into());
    }
    let notes = note_labels.unwrap_or_default();
    if notes.len() > MAX_WINDOWS
        || notes
            .iter()
            .any(|label| label.len() > 128 || !label.starts_with("note-"))
    {
        return Err("diagnostic note references rejected".into());
    }
    let mut inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
    let label = window.label();
    let renderer = data["rendererId"].as_u64().filter(|id| *id > 0);
    if inner.store.current_instance(label) != Some(instance_id)
        || renderer.is_none()
        || renderer != inner.renderers.get(label).copied()
    {
        inner.stale_reports += 1;
        return Err("stale diagnostic instance".into());
    }
    if !inner.rates.contains_key(label) && inner.rates.len() >= MAX_WINDOWS {
        return Err("diagnostic window limit".into());
    }
    let rate = inner
        .rates
        .entry(label.into())
        .or_insert((Instant::now(), 0));
    if rate.0.elapsed() >= Duration::from_secs(1) {
        *rate = (Instant::now(), 0);
    }
    rate.1 += 1;
    if rate.1 > 100 {
        inner.dropped += 1;
        return Ok(());
    }
    let clean = sanitize(&data, 0);
    if event == "snapshot" || event == "geometry-mismatch" || event == "queue-stalled" {
        let refs: Vec<_> = notes.iter().map(|label| inner.store.alias(label)).collect();
        let snapshot = json!({"instance": instance_id, "receivedAt": now_ms(), "data": clean, "noteWindows": refs});
        let active_request = inner.exporting.then_some(inner.request_id);
        retain_reply(&mut inner.replies, active_request, label, &snapshot);
        inner.snapshots.insert(label.into(), snapshot);
    }
    inner.store.record_frontend(label, &event, clean.clone());
    drop(inner);
    if event == "geometry-mismatch" || event == "queue-stalled" {
        let native = native_snapshot(window.app_handle());
        let mut inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
        if inner.anomalies.len() >= 8 {
            inner.anomalies.pop_front();
        }
        let window_alias = inner.store.alias(label);
        let fixture_phase = inner.smoke_phase;
        inner
            .anomalies
            .push_back(json!({"window": window_alias, "instance": instance_id, "event": event, "frontend": clean, "native": native, "fixturePhase": fixture_phase}));
    }
    Ok(())
}

// Private native smoke hook: cannot be armed through IPC or the normal debug tray.
pub(super) fn smoke_window_alias(app: &tauri::AppHandle, label: &str) -> Result<String, String> {
    let state = app.state::<Diagnostics>();
    let inner = state.0.lock().map_err(|_| "diagnostics recorder unavailable")?;
    Ok(inner.store.alias(label))
}

pub fn smoke_stall_next_resize(app: &tauri::AppHandle) -> Result<(), String> {
    if app.config().identifier != "com.otsugua.simeioma.diagnosticstest"
        || std::env::var("SIMEIOMA_DEBUG_SMOKE_TEST").as_deref() != Ok("1")
        || std::env::var("SIMEIOMA_DEBUG_SESSION").as_deref() != Ok("clean")
    {
        return Err("smoke stall requires isolated fixture".into());
    }
    let state = app.state::<Diagnostics>();
    let mut inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
    inner.smoke_stall_once = true;
    inner.smoke_phase = Some("stalled-confirmation-resize");
    inner.store.record("main", "smoke-confirmation-stall", json!({"delayMs": 6500}));
    Ok(())
}

// Native fixture provenance only; no IPC command can annotate or excuse a real anomaly.
pub(super) fn smoke_confirmation_bounds(app: &tauri::AppHandle, narrowed: bool) -> Result<(), String> {
    if app.config().identifier != "com.otsugua.simeioma.diagnosticstest"
        || std::env::var("SIMEIOMA_DEBUG_SMOKE_TEST").as_deref() != Ok("1")
        || std::env::var("SIMEIOMA_DEBUG_SESSION").as_deref() != Ok("clean") {
        return Err("confirmation fixture requires isolated session".into());
    }
    let state = app.state::<Diagnostics>();
    let mut inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
    inner.smoke_phase = narrowed.then_some("forced-confirmation-bounds");
    inner.store.record("main", if narrowed { "smoke-confirmation-narrowed" } else { "smoke-confirmation-restored" },
        json!({"requested": {"width": if narrowed { 64 } else { 360 }, "height": 204}}));
    Ok(())
}

#[tauri::command]
pub async fn debug_before_resize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Diagnostics>,
    operation_id: u64,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("launcher-only injection".into());
    }
    let (injection, stall) = {
        let mut inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
        let injection = inner.injection.take();
        let stall = std::mem::take(&mut inner.smoke_stall_once);
        let renderer = inner.renderers.get("main").copied();
        inner.store.record("main", "resize-injection", json!({"operationId": operation_id, "rendererId": renderer, "delayMs": injection["delayMs"], "fail": injection["fail"]}));
        if stall {
            inner.store.record(
                "main",
                "smoke-stall-injected",
                json!({"operationId": operation_id, "durationMs": 6500}),
            );
        }
        (injection, stall)
    };
    if stall {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(6500)))
            .await
            .map_err(|_| "smoke stall failed")?;
    }
    Ok(injection)
}

fn native_snapshot(app: &tauri::AppHandle) -> Value {
    let capture_start = now_ms();
    let state = app.state::<Diagnostics>();
    let windows: Vec<_> = app.webview_windows().into_iter().take(MAX_WINDOWS).map(|(label, window)| {
        let (alias, instance, renderer) = state.0.lock().map(|mut inner| (inner.store.alias(&label), inner.store.instance(&label), inner.renderers.get(&label).copied())).unwrap_or_default();
        // Every read can race; missing values remain null rather than pretending success.
        json!({"window": alias, "instance": instance, "rendererId": renderer, "capturedAt": now_ms(), "innerSizePhysical": window.inner_size().ok(),
            "outerSizePhysical": window.outer_size().ok(), "positionPhysical": window.outer_position().ok(),
            "scale": window.scale_factor().ok(), "visible": window.is_visible().ok(),
            "focused": window.is_focused().ok(), "minimized": window.is_minimized().ok(),
            "alwaysOnTop": window.is_always_on_top().ok(),
            "monitor": window.current_monitor().ok().flatten().map(|m| json!({
                "positionPhysical": m.position(), "sizePhysical": m.size(),
                "scale": m.scale_factor(), "workAreaPhysical": m.work_area()
            }))})
    }).collect();
    let monitors = app.available_monitors().ok().map(|monitors| monitors.into_iter().take(16).map(|m| json!({
        "positionPhysical": m.position(), "sizePhysical": m.size(), "scale": m.scale_factor(), "workAreaPhysical": m.work_area()
    })).collect::<Vec<_>>());
    json!({"captureStartedAt": capture_start, "captureCompletedAt": now_ms(), "windows": windows, "monitors": monitors})
}

pub async fn export_bundle(app: tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<Diagnostics>();
    let (request_id, labels) = {
        let mut inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
        if inner.exporting {
            return Err("diagnostic export already running".into());
        }
        inner.exporting = true;
        inner.replies.clear();
        inner.request_id += 1;
        (
            inner.request_id,
            app.webview_windows()
                .into_keys()
                .take(MAX_WINDOWS)
                .map(|label| {
                    let instance = inner.store.instance(&label);
                    let renderer = inner.renderers.get(&label).copied().unwrap_or(0);
                    (label, instance, renderer)
                })
                .collect::<Vec<_>>(),
        )
    };
    let result = export_requested(&app, request_id, &labels).await;
    if let Ok(mut inner) = state.0.lock() {
        inner.exporting = false;
        inner.store.record(
            "main",
            "export-completed",
            json!({"failed": result.is_err(), "requestId": request_id}),
        );
    }
    result
}

async fn export_requested(
    app: &tauri::AppHandle,
    request_id: u64,
    labels: &[(String, u64, u64)],
) -> Result<String, String> {
    app.emit("simeioma:debug-snapshot", request_id)
        .map_err(|_| "snapshot request failed")?;
    let state = app.state::<Diagnostics>();
    for _ in 0..30 {
        let complete = {
            let inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
            labels.iter().all(|(label, instance, renderer)| {
                snapshot_matches(inner.replies.get(label), request_id, *instance, *renderer)
            })
        };
        if complete {
            break;
        }
        // Sleep off the UI thread without introducing another runtime dependency.
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(25)))
            .await
            .map_err(|_| "snapshot wait failed")?;
    }
    let native = native_snapshot(app);
    let (writer, flush_sequence) = {
        let inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
        (inner.store.writer.clone(), inner.store.sequence)
    };
    let writer_flush_complete =
        tauri::async_runtime::spawn_blocking(move || writer.flush(Duration::from_millis(500)))
            .await
            .map_err(|_| "writer flush failed")?;
    let inner = state.0.lock().map_err(|_| "diagnostics unavailable")?;
    let missing: Vec<_> = labels
        .iter()
        .filter(|(label, instance, renderer)| {
            !snapshot_matches(inner.replies.get(label), request_id, *instance, *renderer)
        })
        .map(|(label, _, _)| inner.store.alias(label))
        .collect();
    let snapshots: BTreeMap<_, _> = inner
        .snapshots
        .iter()
        .map(|(label, data)| {
            (
                inner.store.alias(label),
                inner.replies.get(label).unwrap_or(data).clone(),
            )
        })
        .collect();
    let expected: Vec<_> = labels.iter().map(|(label, instance, renderer)| json!({
        "window": inner.store.alias(label), "instance": instance, "rendererId": renderer,
        "responded": snapshot_matches(inner.replies.get(label), request_id, *instance, *renderer)
    })).collect();
    let bundle = json!({"schemaVersion": 2, "session": inner.store.session, "exportedAt": now_ms(),
        "requestId": request_id, "missingFrontendResponses": missing, "expectedWindows": expected,
        "staleReports": inner.stale_reports,
        "captureIsAtomic": false, "build": {"version": env!("CARGO_PKG_VERSION"),
            "commit": env!("SIMEIOMA_BUILD_COMMIT"), "dirty": env!("SIMEIOMA_BUILD_DIRTY"),
            "nativeDebug": true, "tauri": tauri::VERSION, "webview": tauri::webview_version().ok(),
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH},
        "droppedEvents": inner.dropped, "ioFailures": inner.store.writer.status()["ioFailures"],
        "writer": inner.store.writer.status(), "writerFlushComplete": writer_flush_complete, "writerFlushThroughSequence": flush_sequence,
        "recorderMaxMicros": inner.store.max_record_micros, "nativeHandlerMaxMicros": state.1.load(Ordering::Relaxed),
        "reproduction": {"cleanSession": std::env::var("SIMEIOMA_DEBUG_SESSION").as_deref() == Ok("clean"),
            "delayMs": inner.injection.delay_ms, "failOnceArmed": inner.injection.fail_once},
        "native": native, "frontend": snapshots, "anomalies": inner.anomalies, "events": inner.store.events});
    let dir = inner
        .store
        .directory
        .clone()
        .ok_or("diagnostic directory unavailable")?;
    drop(inner); // Export serialization and disk writes must not block native recorder producers.
    std::fs::create_dir_all(&dir).map_err(|_| "diagnostic directory creation failed")?;
    // Keep one bundle and one staging file, never an unbounded export history.
    let temporary = dir.join("latest.tmp.json");
    let destination = dir.join("latest.json");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&bundle).map_err(|_| "bundle serialization failed")?,
    )
    .map_err(|_| "bundle write failed")?;
    std::fs::rename(temporary, &destination).map_err(|_| "bundle replacement failed")?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn debug_export(app: tauri::AppHandle) -> Result<String, String> {
    export_bundle(app).await
}

pub fn tray_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{MenuItem, Submenu};
    let export = MenuItem::with_id(
        app,
        "debug-export",
        "Export diagnostic bundle",
        true,
        None::<&str>,
    )?;
    let inspect = MenuItem::with_id(
        app,
        "debug-inspect",
        "Inspect last focused window",
        true,
        None::<&str>,
    )?;
    let launcher = MenuItem::with_id(
        app,
        "debug-inspect-launcher",
        "Inspect launcher",
        true,
        None::<&str>,
    )?;
    let delay = MenuItem::with_id(
        app,
        "debug-delay",
        "Toggle launcher resize delay (0 / 500 ms)",
        true,
        None::<&str>,
    )?;
    let fail = MenuItem::with_id(
        app,
        "debug-fail",
        "Fail next launcher resize once",
        true,
        None::<&str>,
    )?;
    let clear = MenuItem::with_id(
        app,
        "debug-clear",
        "Clear resize injections",
        true,
        None::<&str>,
    )?;
    Submenu::with_items(
        app,
        "Debug",
        true,
        &[&export, &inspect, &launcher, &delay, &fail, &clear],
    )
}

pub fn tray_action(app: &tauri::AppHandle, id: &str) {
    if id == "debug-export" {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match export_bundle(app).await {
                Ok(path) => eprintln!("Diagnostic bundle: {path}"),
                Err(_) => eprintln!("Diagnostic export failed; check log directory availability."),
            }
        });
        return;
    }
    let state = app.state::<Diagnostics>();
    if id == "debug-inspect" || id == "debug-inspect-launcher" {
        let label = if id == "debug-inspect-launcher" {
            Some("main".into())
        } else {
            state
                .0
                .lock()
                .ok()
                .and_then(|inner| inner.last_focus.clone())
        };
        if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
            if let Ok(mut inner) = state.0.lock() {
                inner
                    .store
                    .record(window.label(), "devtools-requested", json!({}));
            }
            window.open_devtools();
        }
        return;
    }
    if let Ok(mut inner) = state.0.lock() {
        match id {
            "debug-delay" => {
                inner.injection.delay_ms = if inner.injection.delay_ms == 0 {
                    500
                } else {
                    0
                }
            }
            "debug-fail" => inner.injection.fail_once = true,
            "debug-clear" => inner.injection = Injection::default(),
            _ => return,
        }
        let controls =
            json!({"delayMs": inner.injection.delay_ms, "fail": inner.injection.fail_once});
        inner
            .store
            .record("main", "injection-changed", controls.clone());
        eprintln!("Launcher resize injection: {controls}");
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn injection_is_bounded_and_failure_is_one_shot() {
        let mut injection = Injection {
            delay_ms: 9000,
            fail_once: true,
        };
        assert_eq!(injection.take(), json!({"delayMs": 2000, "fail": true}));
        assert_eq!(injection.take(), json!({"delayMs": 2000, "fail": false}));
    }
    #[test]
    fn routine_snapshots_do_not_overwrite_export_replies() {
        let mut replies = BTreeMap::new();
        let requested = json!({"data": {"requestId": 5}});
        retain_reply(&mut replies, Some(5), "main", &requested);
        retain_reply(
            &mut replies,
            Some(5),
            "main",
            &json!({"data": {"requestId": 0}}),
        );
        assert_eq!(replies["main"], requested);
    }

    #[test]
    fn old_window_or_renderer_cannot_satisfy_a_fresh_export() {
        let snapshot = json!({"instance": 2, "data": {"requestId": 9, "rendererId": 42}});
        assert!(snapshot_matches(Some(&snapshot), 9, 2, 42));
        assert!(!snapshot_matches(Some(&snapshot), 9, 3, 42));
        assert!(!snapshot_matches(Some(&snapshot), 9, 2, 43));
        assert!(!snapshot_matches(Some(&snapshot), 10, 2, 42));
    }

    #[test]
    fn arbitrary_error_messages_cannot_be_event_names() {
        assert!(!allowed_event("private note text"));
        assert!(allowed_event("configuration-failed"));
    }
}
