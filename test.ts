import "dotenv/config";

import { Desktop } from "@mediar-ai/terminator";
import * as Terminator from "@mediar-ai/terminator";
import { google } from "@ai-sdk/google";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import {
  createSnapshot,
  diffSnapshots,
  summarizeChanges,
  type TreeSnapshot,
} from "./tree-tracker";

import {
  detectActionableElements,
  formatActionableElements,
} from "./actionable-elements";

// ============================================================
// CONFIGURATION
// ============================================================

const desktop = new Desktop();

const MODEL = "gemini-3.5-flash-lite";

const MAX_STEPS = 20;
const MAX_TOTAL_INSPECTIONS = 12;
const MAX_CONSECUTIVE_INSPECTIONS = 3;

const MAX_DIFF_LINES = 60;

const TREE_OPTIONS = {
  formatOutput: true,
  propertyMode: Terminator.PropertyLoadingMode.Complete,
  treeOutputFormat: Terminator.TreeOutputFormat.CompactYaml,
  includeWindowScreenshot: false,
  includeMonitorScreenshots: false,
};

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type InspectionResult = {
  success: boolean;
  initialTree?: string;
  actionableElements?: string;
  changes?: string;
  error?: string;
};

type ParsedElement = {
  name: string;
  role: string;
  bounds: Bounds;
  line: string;
};

// ============================================================
// STATE
// ============================================================

// Full tree stays in local memory for element lookup.
// It is not repeatedly sent to the model.
let latestFormattedTree = "";

// Keep the previous snapshot even when the tree cache is invalidated.
let latestSnapshot: TreeSnapshot | undefined;

let totalInspections = 0;
let consecutiveInspections = 0;
let successfulActions = 0;

let treeIsCurrent = false;

// ============================================================
// HELPERS
// ============================================================

function invalidateTree(): void {
  // Invalidate the cached text but preserve latestSnapshot.
  // The snapshot is required to compare the next UI state.
  treeIsCurrent = false;
  latestFormattedTree = "";
}

function resetInspectionGuard(): void {
  consecutiveInspections = 0;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseBounds(line: string): Bounds | undefined {
  const match = line.match(
    /bounds:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/i,
  );

  if (!match) return undefined;

  const [, x, y, width, height] = match;

  const bounds = {
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
  };

  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return undefined;
  }

  return bounds;
}

function parseElementLine(line: string): ParsedElement | undefined {
  const roleMatch = line.match(/\[[^\]]+\]/);
  if (!roleMatch) return undefined;

  const bounds = parseBounds(line);
  if (!bounds) return undefined;

  const role = roleMatch[0].slice(1, -1);

  const name = line
    .slice((roleMatch.index ?? 0) + roleMatch[0].length)
    .replace(/\(bounds:.*$/i, "")
    .replace(/,\s*(focused|focusable|offscreen|disabled)\b/gi, "")
    .trim()
    .replace(/^["']|["']$/g, "");

  return { name, role, bounds, line };
}

function findElement(requestedName: string): ParsedElement | undefined {
  if (!latestFormattedTree) return undefined;

  const requested = normalizeText(requestedName);
  if (!requested) return undefined;

  const candidates = latestFormattedTree
    .split(/\r?\n/)
    .map(parseElementLine)
    .filter((element): element is ParsedElement => Boolean(element));

  const exactMatches = candidates.filter(
    (element) => normalizeText(element.name) === requested,
  );

  if (exactMatches.length === 1) return exactMatches[0];

  if (exactMatches.length > 1) {
    console.log(`[Click] Multiple exact matches for "${requestedName}".`);
    return undefined;
  }

  const partialMatches = candidates.filter((element) => {
    const name = normalizeText(element.name);
    return name && (name.includes(requested) || requested.includes(name));
  });

  if (partialMatches.length === 1) return partialMatches[0];

  if (partialMatches.length > 1) {
    console.log(
      `[Click] Ambiguous element "${requestedName}":`,
      partialMatches.map(({ name, role, bounds }) => ({
        name,
        role,
        bounds,
      })),
    );
  }

  return undefined;
}

// ============================================================
// TEXT-BASED TREE DIFF
// ============================================================

// Produces concrete added/removed tree lines in addition to the
// structured snapshot diff. The full tree remains private in memory.
function getTreeLineDiff(oldTree: string, newTree: string): string {
  const oldLines = oldTree
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const newLines = newTree
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const removed = oldLines.filter((line) => !newSet.has(line));
  const added = newLines.filter((line) => !oldSet.has(line));

  if (removed.length === 0 && added.length === 0) {
    return "No textual tree changes detected.";
  }

  const limitedRemoved = removed.slice(0, MAX_DIFF_LINES);
  const limitedAdded = added.slice(0, MAX_DIFF_LINES);

  const sections: string[] = [];

  if (added.length > 0) {
    sections.push(
      `ADDED OR CHANGED LINES (${added.length}):\n` +
        limitedAdded.map((line) => `+ ${line}`).join("\n"),
    );
  }

  if (removed.length > 0) {
    sections.push(
      `REMOVED OR CHANGED LINES (${removed.length}):\n` +
        limitedRemoved.map((line) => `- ${line}`).join("\n"),
    );
  }

  const omitted =
    Math.max(0, added.length - limitedAdded.length) +
    Math.max(0, removed.length - limitedRemoved.length);

  if (omitted > 0) {
    sections.push(`${omitted} additional changed lines omitted.`);
  }

  return sections.join("\n\n");
}

// ============================================================
// INSPECT UI
// ============================================================

async function inspectCurrentApplication(
  reason: string,
  forceRefresh = false,
): Promise<InspectionResult> {
  if (treeIsCurrent && !forceRefresh && latestFormattedTree) {
    console.log("[Inspect] UI has not been invalidated; using cached state.");

    return {
      success: true,
      changes: "No new tree read was needed; the cached UI state is current.",
      actionableElements: formatActionableElements(
        detectActionableElements(latestFormattedTree),
      ),
    };
  }

  if (totalInspections >= MAX_TOTAL_INSPECTIONS) {
    return {
      success: false,
      error: `Inspection budget exhausted (${MAX_TOTAL_INSPECTIONS}).`,
    };
  }

  if (consecutiveInspections >= MAX_CONSECUTIVE_INSPECTIONS) {
    return {
      success: false,
      error:
        `Inspection limit reached (${MAX_CONSECUTIVE_INSPECTIONS} consecutive reads). ` +
        "Choose an action using the latest available UI information.",
    };
  }

  totalInspections++;
  consecutiveInspections++;

  console.log(`\n[Inspect] ${reason}`);
  console.log(
    `[Inspect] Read ${totalInspections}/${MAX_TOTAL_INSPECTIONS}; ` +
      `consecutive ${consecutiveInspections}/${MAX_CONSECUTIVE_INSPECTIONS}`,
  );

  try {
    const application = await desktop.getCurrentApplication();
    const processName = await application.processName();

    console.log("[Inspect] Current process:", processName);

    if (!processName) {
      return {
        success: false,
        error: "Could not determine the focused application's process.",
      };
    }

    const result = await desktop.getWindowTreeResult(
      processName,
      undefined,
      TREE_OPTIONS,
    );

    const formattedTree =
      typeof result.formatted === "string" ? result.formatted : "";

    console.log("[Inspect Debug] Formatted type:", typeof result.formatted);
    console.log("[Inspect Debug] Formatted length:", formattedTree.length);

    if (!formattedTree.trim()) {
      treeIsCurrent = false;

      return {
        success: false,
        error: "The UI tree returned no formatted text.",
      };
    }

    // Capture the old state BEFORE replacing it.
    const oldTree = latestFormattedTree;
    const oldSnapshot = latestSnapshot;

    // Build the new state.
    const newSnapshot = createSnapshot(formattedTree);

    let changeSummary: string;
    let lineDiff: string;

    if (oldSnapshot && oldTree) {
      const snapshotDiff = diffSnapshots(oldSnapshot, newSnapshot);

      changeSummary = summarizeChanges(snapshotDiff);
      lineDiff = getTreeLineDiff(oldTree, formattedTree);

      console.log("[Inspect] Compared new snapshot with previous snapshot.");
    } else {
      changeSummary = "Initial snapshot: no previous UI state to compare.";
      lineDiff = "Initial inspection; the complete tree is provided once.";

      console.log("[Inspect] Captured initial snapshot.");
    }

    // Save the latest state for future comparisons and click lookups.
    latestSnapshot = newSnapshot;
    latestFormattedTree = formattedTree;
    treeIsCurrent = true;

    const actionableElements = formatActionableElements(
      detectActionableElements(formattedTree),
    );

    console.log("[Inspect] Tree captured successfully.");

    // Only the first inspection returns the complete tree.
    if (!oldSnapshot || !oldTree) {
      return {
        success: true,
        initialTree: formattedTree,
        actionableElements,
        changes: changeSummary,
      };
    }

    // Subsequent inspections return a diff and current actionable elements.
    return {
      success: true,
      changes: `${changeSummary}\n\n${lineDiff}`,
      actionableElements,
    };
  } catch (error) {
    treeIsCurrent = false;

    const message = error instanceof Error ? error.message : String(error);

    console.error("[Inspect] Failed:", message);

    return {
      success: false,
      error: message,
    };
  }
}

// ============================================================
// CLICK ELEMENT — MOUSE ONLY
// ============================================================

async function clickElement(
  elementName: string,
): Promise<Record<string, unknown>> {
  if (!elementName.trim()) {
    return {
      success: false,
      error: "Provide the accessible name of the element to click.",
    };
  }

  if (!treeIsCurrent || !latestFormattedTree) {
    const inspection = await inspectCurrentApplication(
      "Refresh UI before clicking",
    );

    if (!inspection.success) return inspection;
  }

  const element = findElement(elementName);

  if (!element) {
    return {
      success: false,
      error:
        `No unique element named "${elementName}" with usable bounds ` +
        "was found in the latest UI tree. Inspect the latest changes and " +
        "actionable elements, then select an exact accessible name.",
      actionableElements: latestFormattedTree
        ? formatActionableElements(
            detectActionableElements(latestFormattedTree),
          )
        : undefined,
    };
  }

  console.log(`[Click] "${element.name}" (${element.role})`, element.bounds);

  try {
    const { x, y, width, height } = element.bounds;

    await desktop.clickAtBounds(x, y, width, height);

    successfulActions++;
    resetInspectionGuard();
    invalidateTree();

    console.log("[Click] Click call completed.");

    return {
      success: true,
      clickedElement: element.name,
      role: element.role,
      verified: false,
      message: "Click completed. Inspect the UI to see what changed.",
    };
  } catch (error) {
    return {
      success: false,
      element: element.name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================
// TYPE TEXT — NO KEYBOARD SHORTCUTS
// ============================================================

async function typeText(textToType: string): Promise<Record<string, unknown>> {
  if (!textToType.length) {
    return { success: false, error: "No text was supplied." };
  }

  try {
    const application = await desktop.getCurrentApplication();

    // The intended input must already be focused by a mouse click.
    await application.typeText(textToType, {
      clearBeforeTyping: true,
      includeWindowScreenshot: false,
    });

    successfulActions++;
    resetInspectionGuard();
    invalidateTree();

    console.log(`[Type] Typed ${textToType.length} character(s).`);

    return {
      success: true,
      characterCount: textToType.length,
      verified: false,
      message: "Text entry completed. Inspect the UI to see what changed.",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================
// AI TOOLS
// ============================================================

const terminatorTools = {
  inspectUI: tool({
    description:
      "Refresh and inspect the current application's UI. The initial " +
      "inspection returns the full tree. Later inspections return only " +
      "the UI diff, added/removed tree lines, and current actionable " +
      "elements. Use those changes to decide the next action.",

    inputSchema: z.object({
      reason: z.string(),
    }),

    execute: async ({ reason }) => {
      return await inspectCurrentApplication(reason);
    },
  }),

  clickElement: tool({
    description:
      "Click an element by its exact accessible name from the latest UI " +
      "information. Uses mouse clicks only. Never invent element names.",

    inputSchema: z.object({
      elementName: z.string(),
    }),

    execute: async ({ elementName }) => {
      return await clickElement(elementName);
    },
  }),

  typeText: tool({
    description:
      "Type literal text into the currently focused input. Click the " +
      "target field first. This tool does not perform keyboard shortcuts.",

    inputSchema: z.object({
      text: z.string(),
    }),

    execute: async ({ text }) => {
      return await typeText(text);
    },
  }),
};

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `
You are a desktop UI automation agent.

INTERACTION RULES:
- Use mouse clicks and literal text entry only.
- Never press keyboard keys or use keyboard shortcuts.
- Never invent element names or coordinates.
- The click tool uses the latest UI tree held internally.

DIFF-DRIVEN INSPECTION:
- The initial prompt contains the complete UI tree.
- After an action, inspect the updated UI.
- Subsequent inspections provide a diff, changed tree lines, and current
  actionable elements instead of the full tree.
- Compare these changes with the previous UI state to understand what
  happened after your action.
- Use the actionable elements to choose the next exact element name.
- Do not request repeated inspections of an unchanged UI.
- If inspection fails, use its error and do not retry blindly.
- Do not assume a click succeeded merely because the tool call completed.

TASK COMPLETION:
- Verify important actions by inspecting the resulting UI.
- Do not claim an extension was installed unless the UI confirms it.
- If a required operation cannot be completed using clicks and text entry,
  explain the limitation honestly.
`;

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();

  if (!task) {
    console.error('Usage: bun run ./test.ts "Describe the desktop task"');
    process.exitCode = 1;
    return;
  }

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.error("Missing GOOGLE_GENERATIVE_AI_API_KEY in .env.");
    process.exitCode = 1;
    return;
  }

  console.log("Starting desktop agent...");
  console.log("Task:", task);
  console.log("Model:", MODEL);
  console.log("Interaction methods: mouse clicks + text entry only.");
  console.log("UI context: initial tree, then diffs + actionable elements.");

  const initialInspection = await inspectCurrentApplication(
    "Initial inspection before executing the task",
    true,
  );

  if (!initialInspection.success || !initialInspection.initialTree) {
    console.error(
      "\nCould not inspect the initial application:",
      initialInspection.error,
    );
    process.exitCode = 1;
    return;
  }

  const initialContext = `
INITIAL UI TREE:
${initialInspection.initialTree}

ACTIONABLE ELEMENTS:
${initialInspection.actionableElements ?? "None identified."}

TASK:
${task}

The initial tree is your baseline. After each action, inspect the UI and
reason from the returned changes and actionable elements. Do not expect
the full tree to be repeated.
`;

  try {
    const result = await generateText({
      model: google(MODEL),
      system: SYSTEM_PROMPT,
      prompt: initialContext,
      tools: terminatorTools,
      stopWhen: stepCountIs(MAX_STEPS),
    });

    console.log("\n================ AGENT RESULT ================\n");
    console.log(result.text || "(No final text returned.)");
    console.log("\n================================================");

    console.log("\nExecution summary:");
    console.log(`- Total tree reads: ${totalInspections}`);
    console.log(`- Successful action calls: ${successfulActions}`);
    console.log(`- Consecutive inspections: ${consecutiveInspections}`);
    console.log("- Keyboard interaction: disabled");
    console.log("- Follow-up UI context: diffs + actionable elements");
  } catch (error) {
    console.error("\nAgent execution failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
