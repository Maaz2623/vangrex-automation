export interface ActionableElement {
  role: string;
  name: string;
  depth: number;
  enabled: boolean | null;
  focused: boolean;
  focusable: boolean;
}

const ACTIONABLE_ROLES = new Set([
  "Button",
  "MenuItem",
  "SplitButton",
  "ToggleButton",
  "CheckBox",
  "RadioButton",
  "ComboBox",
  "ListItem",
  "TreeItem",
  "Tab",
  "Hyperlink",
  "Slider",
  "Spinner",
  "TextBox",
  "Edit",
]);

function cleanName(rawName: string): string {
  return rawName
    .replace(/\(bounds:\s*\[[^\]]*\](?:,\s*[^)]*)?\)/g, "")
    .replace(/\(\s*(?:disabled|enabled|focused|focusable)\s*\)/gi, "")
    .replace(/\b(?:focused|focusable|enabled|disabled)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectActionableElements(
  formattedTree: string,
): ActionableElement[] {
  const actionable: ActionableElement[] = [];

  for (const line of formattedTree.split(/\r?\n/)) {
    const match = line.match(/^(\s*)(?:#\d+\s+|-\s*)?\[([^\]]+)\]\s*(.*)$/);

    if (!match) continue;

    const indentation = match[1] ?? "";
    const role = (match[2] ?? "").trim();
    const rawName = match[3] ?? "";

    if (!ACTIONABLE_ROLES.has(role)) continue;

    const name = cleanName(rawName);
    if (!name) continue;

    let enabled: boolean | null = null;

    if (/\(\s*disabled\s*\)/i.test(rawName)) {
      enabled = false;
    } else if (/\(\s*enabled\s*\)/i.test(rawName)) {
      enabled = true;
    }

    actionable.push({
      role,
      name,
      depth: indentation.length,
      enabled,
      focused: /\bfocused\b/i.test(rawName),
      focusable: /\bfocusable\b/i.test(rawName),
    });
  }

  return actionable;
}

export function formatActionableElements(
  elements: ActionableElement[],
): string {
  if (elements.length === 0) {
    return "No named actionable elements detected.";
  }

  return elements
    .map(({ role, name, enabled, focused, focusable }) => {
      const enabledState =
        enabled === false
          ? "DISABLED"
          : enabled === true
            ? "ENABLED"
            : "UNKNOWN";

      const focusState = focused ? "FOCUSED" : "NOT FOCUSED";
      const focusableState = focusable ? "FOCUSABLE" : "NOT MARKED FOCUSABLE";

      return (
        `- [${role}] ${name}` +
        ` [${enabledState}]` +
        ` [${focusState}]` +
        ` [${focusableState}]`
      );
    })
    .join("\n");
}
