use super::{expect_assertion, wait};

pub(super) async fn run(source: &tauri::WebviewWindow) -> Result<(), String> {
    source.eval(r#"(async () => {
      const canvas = document.querySelector('.sketch-canvas');
      const originalLine = Path2D.prototype.lineTo, originalStroke = CanvasRenderingContext2D.prototype.stroke;
      const probe = {compiled: 0, painted: 0, widths: new Set(), backup: null};
      Path2D.prototype.lineTo = function(...args) { probe.compiled++; return originalLine.apply(this, args); };
      CanvasRenderingContext2D.prototype.stroke = function(...args) {
        if (this.canvas === canvas && args[0] instanceof Path2D) { probe.painted++; probe.widths.add(canvas.width); }
        return originalStroke.apply(this, args);
      };
      probe.restore = () => { Path2D.prototype.lineTo = originalLine; CanvasRenderingContext2D.prototype.stroke = originalStroke; };
      window.__simeiomaVectorProbe = probe;
      await navigator.locks.request('simeioma:debug-clean:v1:mutation', () => {
        const key = 'simeioma:debug-clean:v1', state = JSON.parse(localStorage.getItem(key));
        probe.backup = state.notes.find(n => n.id === new URLSearchParams(location.search).get('id')).sketchStrokes;
        state.notes.find(n => n.id === new URLSearchParams(location.search).get('id')).sketchStrokes = Array.from({length: 200}, (_, i) => ({
          type: 'freehand', renderingMode: 'simeioma-adaptive', brushSize: 'default',
          points: Array.from({length: 80}, (_, j) => ({x: j * 4, y: 20 + (i % 100) * 3 + Math.sin(j) * 8, time: j * 16}))
        }));
        state.revision++; localStorage.setItem(key, JSON.stringify(state));
      });
      const channel = new BroadcastChannel('simeioma-debug-clean-sync'); channel.postMessage({type: 'state'}); channel.close();
      for (let i = 0; i < 60 && probe.painted < 200; i++) await new Promise(resolve => setTimeout(resolve, 50));
      probe.baseline = probe.compiled; probe.widths.clear();
      await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 9, passed: probe.compiled > 0 && probe.painted >= 200});
    })();"#).map_err(|_| "vector resize setup failed")?;
    expect_assertion(9).await?;
    for (width, height) in [(300.0, 240.0), (400.0, 280.0), (320.0, 260.0)] {
        source.set_size(tauri::LogicalSize::new(width, height)).map_err(|_| "vector resize failed")?;
        wait(250).await;
    }
    source.eval(r#"(async () => {
      const probe = window.__simeiomaVectorProbe;
      const passed = probe.compiled === probe.baseline && probe.widths.size >= 3;
      probe.restore();
      await navigator.locks.request('simeioma:debug-clean:v1:mutation', () => {
        const key = 'simeioma:debug-clean:v1', state = JSON.parse(localStorage.getItem(key));
        state.notes.find(n => n.id === new URLSearchParams(location.search).get('id')).sketchStrokes = probe.backup;
        state.revision++; localStorage.setItem(key, JSON.stringify(state));
      });
      delete window.__simeiomaVectorProbe;
      const channel = new BroadcastChannel('simeioma-debug-clean-sync'); channel.postMessage({type: 'state'}); channel.close();
      await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 10, passed});
    })();"#).map_err(|_| "vector resize assertion failed")?;
    expect_assertion(10).await?;
    let resize_events = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = resize_events.clone();
    source.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) { observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
    });
    source.eval(r#"(async () => {
      const handle = document.querySelector('.note-resize-handle'), capture = handle.setPointerCapture;
      handle.setPointerCapture = () => {};
      const width = innerWidth, height = innerHeight;
      const pointer = (type, x, y, buttons) => handle.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, buttons, pointerId: 43, clientX: x, clientY: y}));
      pointer('pointerdown', 100, 100, 1);
      await new Promise(resolve => setTimeout(resolve, 150));
      for (let i = 1; i <= 60; i++) pointer('pointermove', 100 + i * 2, 100 + i, 1);
      pointer('pointerup', 240, 180, 0);
      let passed = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const state = JSON.parse(localStorage.getItem('simeioma:debug-clean:v1'));
        const note = state.notes.find(n => n.id === new URLSearchParams(location.search).get('id'));
        if (innerWidth === width + 140 && innerHeight === height + 80 && note.size.width === innerWidth && note.size.height === innerHeight) { passed = true; break; }
      }
      handle.setPointerCapture = capture;
      await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 11, passed, metrics: [innerWidth, innerHeight, width + 140, height + 80]});
    })();"#).map_err(|_| "resize gesture evaluation failed")?;
    expect_assertion(11).await?;
    let count = resize_events.load(std::sync::atomic::Ordering::Relaxed);
    if !(1..=2).contains(&count) { return Err(format!("resize burst emitted {count} native resize events")); }
    Ok(())
}
