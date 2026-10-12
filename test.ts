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

// Full current tree is retained locally for reliable element lookup.
let latestFormattedTree = "";

// Preserve snapshots across actions so diffs compare consecutive states.
let latestSnapshot: TreeSnapshot | undefined;

let totalInspections = 0;
let consecutiveInspections = 0;
let successfulActions = 0;

let treeIsCurrent = false;

// ============================================================
// HELPERS
// ============================================================

function invalidateTree(): void {
  // Preserve latestSnapshot for the next diff.
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
// TREE DIFF
// ============================================================

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

  if (!removed.length && !added.length) {
    return "No textual tree changes detected.";
  }

  const sections: string[] = [];

  if (added.length) {
    sections.push(
      `ADDED OR CHANGED LINES (${added.length}):\n` +
        added
          .slice(0, MAX_DIFF_LINES)
          .map((line) => `+ ${line}`)
          .join("\n"),
    );
  }

  if (removed.length) {
    sections.push(
      `REMOVED OR CHANGED LINES (${removed.length}):\n` +
        removed
          .slice(0, MAX_DIFF_LINES)
          .map((line) => `- ${line}`)
          .join("\n"),
    );
  }

  const omitted =
    Math.max(0, added.length - MAX_DIFF_LINES) +
    Math.max(0, removed.length - MAX_DIFF_LINES);

  if (omitted > 0) {
    sections.push(`${omitted} additional changed lines omitted.`);
  }

  return sections.join("\n\n");
}

// ============================================================
// DYNAMIC TREE RETRIEVAL
// ============================================================

async function getDynamicWindowTree(processName: string): Promise<string> {
  const errors: string[] = [];

  // Try the primary API first.
  try {
    const result = await desktop.getWindowTreeResult(
      processName,
      undefined,
      TREE_OPTIONS,
    );

    if (typeof result.formatted === "string" && result.formatted.trim()) {
      return result.formatted;
    }

    errors.push("getWindowTreeResult returned no formatted text.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    errors.push(`getWindowTreeResult: ${message}`);
  }

  // Try the async tree API if the primary method fails.
  try {
    const result = await desktop.getWindowTreeResultAsync(
      processName,
      undefined,
      TREE_OPTIONS,
    );

    if (typeof result.formatted === "string" && result.formatted.trim()) {
      return result.formatted;
    }

    errors.push("getWindowTreeResultAsync returned no formatted text.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    errors.push(`getWindowTreeResultAsync: ${message}`);
  }

  throw new Error(
    `Could not retrieve the UI tree for process "${processName}".\n` +
      errors.join("\n"),
  );
}

// ============================================================
// INSPECT UI
// ============================================================

async function inspectCurrentApplication(
  reason: string,
  forceRefresh = false,
): Promise<InspectionResult> {
  if (treeIsCurrent && !forceRefresh && latestFormattedTree) {
    console.log("[Inspect] Using cached UI state.");

    return {
      success: true,
      changes: "Cached UI state; no new tree read was needed.",
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
      error: `Inspection limit reached (${MAX_CONSECUTIVE_INSPECTIONS} consecutive reads).`,
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
    // Resolve the currently focused application dynamically.
    const application = await desktop.getCurrentApplication();
    const processName = application.processName();

    console.log("[Inspect] Focused process:", processName);

    if (!processName) {
      return {
        success: false,
        error: "The focused application returned no process name.",
      };
    }

    // Try tree retrieval without hard-coded app names or titles.
    const formattedTree = await getDynamicWindowTree(processName);

    console.log("[Inspect] Formatted tree length:", formattedTree.length);

    const oldTree = latestFormattedTree;
    const oldSnapshot = latestSnapshot;
    const newSnapshot = createSnapshot(formattedTree);

    let changeSummary: string;
    let lineDiff: string;

    if (oldTree && oldSnapshot) {
      changeSummary = summarizeChanges(diffSnapshots(oldSnapshot, newSnapshot));

      lineDiff = getTreeLineDiff(oldTree, formattedTree);

      console.log("[Inspect] Compared current UI with previous snapshot.");
    } else {
      changeSummary = "Initial snapshot; no prior UI state exists.";
      lineDiff = "Initial inspection.";
    }

    // Store the new state only after successful tree retrieval.
    latestSnapshot = newSnapshot;
    latestFormattedTree = formattedTree;
    treeIsCurrent = true;

    const actionableElements = formatActionableElements(
      detectActionableElements(formattedTree),
    );

    console.log("[Inspect] Tree captured successfully.");

    // Full tree is returned to the model only for the first inspection.
    if (!oldTree || !oldSnapshot) {
      return {
        success: true,
        initialTree: formattedTree,
        actionableElements,
        changes: changeSummary,
      };
    }

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
        "was found in the latest tree.",
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

    return {
      success: true,
      clickedElement: element.name,
      role: element.role,
      verified: false,
      message: "Click completed. Inspect the updated UI to verify.",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================
// TYPE TEXT — LITERAL TEXT ONLY
// ============================================================

async function typeText(textToType: string): Promise<Record<string, unknown>> {
  if (!textToType.length) {
    return {
      success: false,
      error: "No text was supplied.",
    };
  }

  try {
    const application = await desktop.getCurrentApplication();

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
      message: "Text entry completed. Inspect the updated UI to verify.",
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
      "Inspect the focused application. The first inspection returns " +
      "the full tree; later inspections return only diffs and actionable " +
      "elements. Use changes to decide the next action.",

    inputSchema: z.object({
      reason: z.string(),
    }),

    execute: async ({ reason }) => {
      return await inspectCurrentApplication(reason);
    },
  }),

  clickElement: tool({
    description:
      "Click an element using its exact accessible name from the latest " +
      "UI information. Uses mouse clicks only.",

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
      "target field first. No keyboard shortcuts are available.",

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

INTERACTION:
- Use mouse clicks and literal text entry only.
- Never use keyboard keys or shortcuts.
- Never invent element names or coordinates.
- The click tool uses the latest tree retained internally.

DIFF-DRIVEN REASONING:
- The initial prompt contains the complete UI tree.
- After actions, inspect the updated UI.
- Later inspections provide diffs and actionable elements.
- Reason about what changed before choosing the next action.
- Do not repeatedly inspect an unchanged UI.
- If inspection fails, read the error and do not retry blindly.

TASK:
- Perform the user's requested task using the available tools.
- Verify the result by inspecting the UI.
- Never claim success without evidence from the resulting UI.
- If the required action cannot be performed, explain the limitation.
`;

// ============================================================
// MAIN
// ============================================================
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  sleep(5000);

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
  console.log("Application discovery: dynamic; no app names hard-coded.");

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

Use the initial tree as your baseline. After each action, inspect the UI
and reason from the returned changes and actionable elements.
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
