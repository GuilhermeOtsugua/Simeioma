import { NOTE_COLORS } from "./simeiomaModel";

const SETTINGS_ACCENTS = NOTE_COLORS.filter((color) =>
  ["pink", "aqua", "papaya", "mint"].includes(color.key),
);

export function randomSettingsAccent(excludeKey?: string) {
  const choices = SETTINGS_ACCENTS.filter((color) => color.key !== excludeKey);
  return choices[Math.floor(Math.random() * choices.length)];
}
