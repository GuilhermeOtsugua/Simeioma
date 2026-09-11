import { type AppState, type ReminderNotice, unviewedReminderNotes, isReminderDue } from "./simeiomaModel";
import { transactState, loadState } from "./persistence";

export async function maybeTriggerReminder(
  setState: (state: AppState) => void,
  setNotice: (notice: ReminderNotice | null) => void,
) {
  const result = await transactState(state => {
    const unviewed = unviewedReminderNotes(state.notes, state.settings.reminderTarget);
    if (!state.settings.remindersEnabled || !unviewed.length || !isReminderDue(state.settings)) return { state, notice: null };
    return { state: { ...state, settings: { ...state.settings, lastReminderAt: new Date().toISOString() } },
      notice: { title: "Reminder", body: `${unviewed.length} notes need attention`, noteIds: unviewed.map(note => note.id) } };
  });
  setState(loadState());
  if (result.notice) setNotice(result.notice);
}
