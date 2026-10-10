import { desktop } from "../desktop";

const MODIFIERS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  win: "Win",
  windows: "Win",
};

const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "ESC",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

function normalizeShortcut(shortcut: string): string {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("Shortcut cannot be empty");
  }

  return parts
    .map((part, index) => {
      const normalized = part.toLowerCase();

      if (MODIFIERS[normalized]) {
        return `{${MODIFIERS[normalized]}}`;
      }

      if (NAMED_KEYS[normalized]) {
        return `{${NAMED_KEYS[normalized]}}`;
      }

      if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) {
        return `{${part.toUpperCase()}}`;
      }

      if (/^[a-z]$/i.test(part) || /^[0-9]$/.test(part)) {
        // Keep the character unbraced, as required by the
        // working native syntax: "{Ctrl}{Shift}m".
        return part;
      }

      throw new Error(`Unsupported key "${part}" in shortcut "${shortcut}"`);
    })
    .join("");
}

export async function pressShortcut(
  shortcut: string,
  process?: string,
): Promise<void> {
  const normalized = normalizeShortcut(shortcut);

  await desktop.pressKey(normalized, process, false, false);
}
