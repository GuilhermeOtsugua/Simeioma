import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createLifetime } from "./lifetime";
import { invokeObserved, recordDiagnostic } from "./diagnostics";

export function observeUtilityFocus(onBlur?: () => void) {
  const life = createLifetime(() => recordDiagnostic("native-command-failed"));
  if (!isTauri()) return life.dispose;
  const window = getCurrentWindow();
  let eventSeen = false;
  const apply = async (focused: boolean) => {
    if (!focused) onBlur?.();
    await invokeObserved("set_utility_focus_state", { label: window.label, focused });
  };
  life.after(window.isFocused(), focused => eventSeen ? undefined : apply(focused));
  life.own(window.onFocusChanged(life.guard(({ payload }) => {
    eventSeen = true;
    life.after(apply(payload), () => {});
  })));
  return life.dispose;
}
