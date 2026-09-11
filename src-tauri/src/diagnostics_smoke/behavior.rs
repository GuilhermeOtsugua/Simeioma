use super::{expect_assertion, expect_width, wait};
use tauri::Manager;

pub(super) async fn run(app: &tauri::AppHandle, main: &tauri::WebviewWindow, source: &tauri::WebviewWindow) -> Result<(), String> {
    source.eval(r#"(async () => {
      const editor = document.querySelector('[aria-label="Note line"]');
      editor.focus();
      const text = '# Heading\n**bold**\nedit';
      editor.dispatchEvent(new InputEvent('beforeinput', {inputType: 'insertText', data: text, bubbles: true, cancelable: true}));
      editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      editor.textContent = text + '日本語';
      editor.dispatchEvent(new InputEvent('input', {inputType: 'insertCompositionText', bubbles: true}));
      editor.dispatchEvent(new CompositionEvent('compositionend', {data: '日本語', bubbles: true}));
      const body = async () => {
        await navigator.locks.request('simeioma:debug-clean:v1:mutation', () => {});
        const state = JSON.parse(localStorage.getItem('simeioma:debug-clean:v1'));
        return state.notes.find(n => n.id === new URLSearchParams(location.search).get('id')).lines[0].text;
      };
      let passed = await body() === text + '日本語';
      const key = key => editor.dispatchEvent(new KeyboardEvent('keydown', {key, ctrlKey: true, bubbles: true, cancelable: true}));
      key('z'); passed = passed && await body() === text;
      key('y'); passed = passed && await body() === text + '日本語';
      editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      editor.dispatchEvent(new CompositionEvent('compositionend', {data: '', bubbles: true}));
      key('z'); passed = passed && await body() === text;
      key('y'); passed = passed && await body() === text + '日本語';
      await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 0, passed});
    })();"#).map_err(|_| "composition evaluation failed")?;
    expect_assertion(0).await?;

    // Two real WebView2 contexts hold the actual mutation lock while deliberately yielding.
    main.eval("localStorage.removeItem('simeioma:smoke-counter');").map_err(|_| "lock fixture reset failed")?;
    wait(100).await;
    for (window, case_id) in [(main, 1), (source, 2)] {
        window.eval(&format!(r#"(async () => {{
          await navigator.locks.request('simeioma:debug-clean:v1:mutation', async () => {{
            const value = Number(localStorage.getItem('simeioma:smoke-counter') || 0);
            await new Promise(resolve => setTimeout(resolve, 300));
            localStorage.setItem('simeioma:smoke-counter', String(value + 1));
          }});
          await window.__TAURI_INTERNALS__.invoke('smoke_assert', {{caseId: {case_id}, passed: true}});
        }})();"#)).map_err(|_| "lock fixture evaluation failed")?;
    }
    expect_assertion(1).await?; expect_assertion(2).await?;
    main.eval("window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 3, passed: localStorage.getItem('simeioma:smoke-counter') === '2'}); localStorage.removeItem('simeioma:smoke-counter');").map_err(|_| "lock assertion evaluation failed")?;
    expect_assertion(3).await?;

    // This corruption is confined to the clean fixture identity. No normal session is touched.
    source.eval("localStorage.setItem('simeioma:smoke-backup', localStorage.getItem('simeioma:debug-clean:v1')); localStorage.setItem('simeioma:debug-clean:v1', '{invalid fixture'); location.reload();").map_err(|_| "recovery fixture setup failed")?;
    wait(700).await;
    source.eval(r#"(async () => {
      for (let i = 0; i < 30; i++) {
        if (document.body?.textContent.includes('Stored session needs recovery')) {
          await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 4, passed: localStorage.getItem('simeioma:debug-clean:v1') === '{invalid fixture'}); return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 4, passed: false});
    })();"#).map_err(|_| "recovery assertion evaluation failed")?;
    expect_assertion(4).await?;
    source.eval("localStorage.setItem('simeioma:debug-clean:v1', localStorage.getItem('simeioma:smoke-backup')); localStorage.removeItem('simeioma:smoke-backup'); [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry loading').click();").map_err(|_| "recovery retry failed")?;
    wait(700).await;
    source.eval(r#"(async () => {
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('[aria-label="Note line"]')) {
          await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 5, passed: true}); return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 5, passed: false});
    })();"#).map_err(|_| "recovery retry assertion failed")?;
    expect_assertion(5).await?;

    let directory = app.path().app_log_dir().map_err(|_| "fixture export directory unavailable")?.join("smoke-exports");
    if directory.exists() { std::fs::remove_dir_all(&directory).map_err(|_| "old fixture export cleanup failed")?; }
    std::fs::create_dir_all(&directory).map_err(|_| "fixture export directory creation failed")?;
    let encoded_directory = serde_json::to_string(&directory.to_string_lossy()).map_err(|_| "fixture directory encoding failed")?;
    main.set_focus().map_err(|_| "export launcher focus failed")?;
    wait(150).await;
    main.eval(&format!(r#"(async () => {{
      await navigator.locks.request('simeioma:debug-clean:v1:mutation', () => {{
        const key = 'simeioma:debug-clean:v1';
        localStorage.setItem('simeioma:smoke-backup', localStorage.getItem(key));
        const state = JSON.parse(localStorage.getItem(key));
        state.notes[0].lines[0].text = Array.from({{length: 30}}, (_, i) => 'export row ' + i).join('\n');
        state.notes[0].layout = 'two-column'; state.notes[0].rightText = 'right column\nfinal right row';
        state.notes[0].sketchStrokes = [{{type: 'line', start: {{x: 0, y: 0}}, end: {{x: 384, y: 384}}}}];
        state.settings.exportPath = {encoded_directory}; state.settings.exportFormat = 'png';
        state.revision += 1; localStorage.setItem(key, JSON.stringify(state));
      }});
      document.querySelector('.launcher-strip').dispatchEvent(new MouseEvent('contextmenu', {{bubbles: true, cancelable: true, button: 2}}));
    }})();"#)).map_err(|_| "export fixture evaluation failed")?;
    expect_width(app, 64).await?;
    main.eval("document.querySelector('[aria-label=\"Bulk export notes\"]').click();").map_err(|_| "export click failed")?;
    let mut valid = false;
    for _ in 0..50 {
        for entry in std::fs::read_dir(&directory).map_err(|_| "fixture exports unavailable")?.flatten() {
            if let Ok(bytes) = std::fs::read(entry.path()) {
                if bytes.len() >= 24 && &bytes[..8] == b"\x89PNG\r\n\x1a\n"
                    && u32::from_be_bytes(bytes[16..20].try_into().unwrap()) == 720
                    && u32::from_be_bytes(bytes[20..24].try_into().unwrap()) > 700 { valid = true; }
            }
        }
        if valid { break; } wait(100).await;
    }
    if !valid { return Err("complete-content PNG export missing or invalid".into()); }
    main.eval(r#"(async () => {
      await navigator.locks.request('simeioma:debug-clean:v1:mutation', () => {
        const key = 'simeioma:debug-clean:v1';
        const restored = JSON.parse(localStorage.getItem('simeioma:smoke-backup'));
        restored.revision = JSON.parse(localStorage.getItem(key)).revision + 1;
        localStorage.setItem(key, JSON.stringify(restored)); localStorage.removeItem('simeioma:smoke-backup');
      });
      await window.__TAURI_INTERNALS__.invoke('smoke_assert', {caseId: 6, passed: true});
    })();"#).map_err(|_| "export fixture restoration failed")?;
    expect_assertion(6).await?;
    main.set_focus().map_err(|_| "launcher focus failed")?;
    wait(100).await;
    source.set_focus().map_err(|_| "note focus failed")?;
    expect_width(app, 30).await?;
    Ok(())
}
