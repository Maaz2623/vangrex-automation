export type UINode = {
  role: string;
  name: string;
  properties: {
    focused: boolean;
    focusable?: boolean;
    bounds?: string;
  };
  children: UINode[];
};

export type TreeSnapshot = {
  root: UINode;
};

export type MenuChange = {
  role: "Menu";
  name?: string;
  items: string[];
  focusedItem?: string;
};

export type ElementChange = {
  role: string;
  name: string;
  path?: string;
  kind?: "dialog" | "popup";
};

export type PropertyChange = {
  role: string;
  name: string;
  focus?: "gained" | "lost";
  properties?: Record<string, { before: unknown; after: unknown }>;
};

export type TreeDiff = {
  added: Array<MenuChange | ElementChange>;
  removed: Array<MenuChange | ElementChange>;
  changed: PropertyChange[];
};

function cleanAccessibleName(raw: string): string {
  return raw
    .replace(/\(bounds:\s*\[[^\]]*\](?:,\s*[^)]*)?\)/g, "")
    .replace(/\b(?:focused|focusable|enabled|disabled)\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,;:])/g, "$1")
    .replace(/([,;:])(?=\S)/g, "$1 ")
    .replace(/\s+/g, " ")
    .replace(/\.\.\.$/, "")
    .replace(/^[\s,;:]+|[\s,;:]+$/g, "")
    .trim();
}

function parseNodeLine(line: string): { indent: number; node: UINode } | null {
  const match = line.match(/^(\s*)(?:#\d+\s+|-\s*)?\[([^\]]+)\]\s*(.*)$/);

  if (!match) return null;

  const indent = match[1].length;
  const role = match[2].trim();
  const raw = match[3].trim();

  const boundsMatch = raw.match(/\(bounds:\s*(\[[^\]]*\])(?:,\s*[^)]*)?\)/);

  const properties: UINode["properties"] = {
    focused: /\bfocused\b/.test(raw),
  };

  if (/\bfocusable\b/.test(raw)) {
    properties.focusable = true;
  }

  if (boundsMatch) {
    properties.bounds = boundsMatch[1];
  }

  return {
    indent,
    node: {
      role,
      name: cleanAccessibleName(raw),
      properties,
      children: [],
    },
  };
}

export function createSnapshot(formattedTree: string): TreeSnapshot {
  const roots: UINode[] = [];

  const stack: Array<{
    indent: number;
    node: UINode;
  }> = [];

  for (const line of formattedTree.split(/\r?\n/)) {
    const parsed = parseNodeLine(line);
    if (!parsed) continue;

    const { indent, node } = parsed;

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }

    stack.push({ indent, node });
  }

  if (roots.length === 0) {
    throw new Error("No UI nodes found in the formatted Terminator tree.");
  }

  if (roots.length === 1) {
    return { root: roots[0] };
  }

  return {
    root: {
      role: "Root",
      name: "UI Tree",
      properties: { focused: false },
      children: roots,
    },
  };
}

function label(node: UINode): string {
  return node.name ? `${node.role}: ${node.name}` : node.role;
}

function identity(node: UINode): string {
  return `${node.role}|${node.name}`;
}

function findMenus(node: UINode): UINode[] {
  const result: UINode[] = [];

  if (node.role === "Menu") {
    result.push(node);
  }

  for (const child of node.children) {
    result.push(...findMenus(child));
  }

  return result;
}

function findMenuItems(node: UINode): UINode[] {
  const result: UINode[] = [];

  for (const child of node.children) {
    if (child.role === "MenuItem") {
      result.push(child);
    } else {
      result.push(...findMenuItems(child));
    }
  }

  return result;
}

function menuSummary(menu: UINode): MenuChange {
  const items = findMenuItems(menu);
  const focusedItem = items.find((item) => item.properties.focused);

  return {
    role: "Menu",
    ...(menu.name ? { name: menu.name } : {}),
    items: items
      .map((item) => cleanAccessibleName(item.name) || item.role)
      .filter(Boolean),
    ...(focusedItem
      ? {
          focusedItem:
            cleanAccessibleName(focusedItem.name) || focusedItem.role,
        }
      : {}),
  };
}

// Identify likely dialog and popup roots.
// A newly added Window is treated as a popup candidate.
// A Pane is classified only when its name suggests a dialog.
function classifyOverlay(node: UINode): "dialog" | "popup" | null {
  if (node.role === "Dialog") {
    return "dialog";
  }

  if (node.role === "Window") {
    return "popup";
  }

  if (node.role === "Pane") {
    const name = node.name.toLowerCase();

    if (
      /\b(dialog|popup|pop-up|confirmation|confirm|trust publisher|security warning|save as|open file)\b/.test(
        name,
      )
    ) {
      return "dialog";
    }
  }

  return null;
}

// Find the outermost overlay candidates in a newly added/removed subtree.
function findOverlays(node: UINode): UINode[] {
  if (classifyOverlay(node)) {
    return [node];
  }

  const result: UINode[] = [];

  for (const child of node.children) {
    result.push(...findOverlays(child));
  }

  return result;
}

function recordSubtree(
  node: UINode,
  target: TreeDiff["added"],
  path: string,
): void {
  // Prefer reporting a dialog/popup over its individual descendants.
  const overlays = findOverlays(node);

  if (overlays.length > 0) {
    for (const overlay of overlays) {
      const kind = classifyOverlay(overlay);

      target.push({
        role: overlay.role,
        name: overlay.name,
        path,
        ...(kind ? { kind } : {}),
      });
    }

    return;
  }

  const menus = findMenus(node);

  if (menus.length > 0) {
    for (const menu of menus) {
      target.push(menuSummary(menu));
    }

    return;
  }

  target.push({
    role: node.role,
    name: node.name,
    path,
  });
}

function compareProperties(
  before: UINode,
  after: UINode,
): Record<string, { before: unknown; after: unknown }> {
  const result: Record<string, { before: unknown; after: unknown }> = {};

  if (before.properties.focused !== after.properties.focused) {
    result.focused = {
      before: before.properties.focused,
      after: after.properties.focused,
    };
  }

  if (before.properties.bounds !== after.properties.bounds) {
    result.bounds = {
      before: before.properties.bounds ?? null,
      after: after.properties.bounds ?? null,
    };
  }

  return result;
}

function diffNode(
  before: UINode,
  after: UINode,
  path: string,
  diff: TreeDiff,
): void {
  const propertyChanges = compareProperties(before, after);

  if (Object.keys(propertyChanges).length > 0) {
    const focusChange = propertyChanges.focused;

    diff.changed.push({
      role: after.role,
      name: after.name,
      ...(focusChange
        ? {
            focus: focusChange.after ? "gained" : "lost",
          }
        : {}),
      ...(Object.keys(propertyChanges).some((key) => key !== "focused")
        ? { properties: propertyChanges }
        : {}),
    });
  }

  // Match siblings by role/name and occurrence, not tree index.
  const oldChildren = new Map<string, UINode>();
  const newChildren = new Map<string, UINode>();
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();

  for (const child of before.children) {
    const base = identity(child);
    const occurrence = oldCounts.get(base) ?? 0;

    oldCounts.set(base, occurrence + 1);
    oldChildren.set(`${base}|${occurrence}`, child);
  }

  for (const child of after.children) {
    const base = identity(child);
    const occurrence = newCounts.get(base) ?? 0;

    newCounts.set(base, occurrence + 1);
    newChildren.set(`${base}|${occurrence}`, child);
  }

  for (const [key, oldChild] of oldChildren) {
    const childPath = `${path} > ${label(oldChild)}`;
    const newChild = newChildren.get(key);

    if (!newChild) {
      recordSubtree(oldChild, diff.removed, childPath);
      continue;
    }

    diffNode(oldChild, newChild, `${path} > ${label(newChild)}`, diff);
  }

  for (const [key, newChild] of newChildren) {
    if (oldChildren.has(key)) continue;

    recordSubtree(newChild, diff.added, `${path} > ${label(newChild)}`);
  }
}

export function diffSnapshots(
  before: TreeSnapshot,
  after: TreeSnapshot,
): TreeDiff {
  const diff: TreeDiff = {
    added: [],
    removed: [],
    changed: [],
  };

  diffNode(before.root, after.root, label(after.root), diff);

  return diff;
}

export function summarizeChanges(diff: TreeDiff): string {
  const lines: string[] = [];

  for (const item of diff.added) {
    if (item.role === "Menu" && "items" in item) {
      lines.push(`MENU OPENED: ${item.items.join(", ")}`);

      if (item.focusedItem) {
        lines.push(`MENU FOCUS: ${item.focusedItem}`);
      }

      continue;
    }

    if ("kind" in item && item.kind === "dialog") {
      lines.push(`DIALOG OPENED: ${item.role}: ${item.name || "(unnamed)"}`);
      continue;
    }

    if ("kind" in item && item.kind === "popup") {
      lines.push(
        `POPUP/WINDOW OPENED: ${item.role}: ${item.name || "(unnamed)"}`,
      );
      continue;
    }

    lines.push(`ADDED: ${item.role}: ${item.name}`);
  }

  for (const item of diff.removed) {
    if (item.role === "Menu" && "items" in item) {
      lines.push(`MENU CLOSED: ${item.items.join(", ")}`);
      continue;
    }

    if ("kind" in item && item.kind === "dialog") {
      lines.push(`DIALOG CLOSED: ${item.role}: ${item.name || "(unnamed)"}`);
      continue;
    }

    if ("kind" in item && item.kind === "popup") {
      lines.push(
        `POPUP/WINDOW CLOSED: ${item.role}: ${item.name || "(unnamed)"}`,
      );
      continue;
    }

    lines.push(`REMOVED: ${item.role}: ${item.name}`);
  }

  for (const item of diff.changed) {
    if (item.focus) {
      lines.push(
        `FOCUS ${item.focus.toUpperCase()}: ${item.role}: ${item.name}`,
      );
    }

    if (item.properties) {
      lines.push(
        `PROPERTIES CHANGED: ${item.role}: ${item.name} ${JSON.stringify(item.properties)}`,
      );
    }
  }

  return lines.length > 0
    ? lines.join("\n")
    : "No meaningful UI changes detected.";
}
