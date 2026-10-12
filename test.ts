import "dotenv/config";

import { google } from "@ai-sdk/google";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import Terminator, { desktop } from "./src/desktop";
import {
  createSnapshot,
  diffSnapshots,
  summarizeChanges,
} from "./tree-tracker";
import {
  detectActionableElements,
  formatActionableElements,
} from "./actionable-elements";

const MODEL = "gemini-3.5-flash-lite";
const PROCESS_NAME = "notepad";
const MAIN_WINDOW_TITLE = "*Vangrex AI Desktop Automation.txt - Notepad";

const actionOptions = {
  clearBeforeTyping: true,
  includeWindowScreenshot: false,
};

type UIInspection = Awaited<ReturnType<typeof inspectWindow>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectWindow(windowTitle: string) {
  const result = await desktop.getWindowTreeResult(PROCESS_NAME, windowTitle, {
    formatOutput: true,
    propertyMode: Terminator.PropertyLoadingMode.Complete,
    treeOutputFormat: Terminator.TreeOutputFormat.CompactYaml,
  });

  const tree = result.formatted;

  if (!tree?.trim()) {
    throw new Error(`The UI tree was empty for "${windowTitle}".`);
  }

  const snapshot = createSnapshot(tree);
  const actionableElements = detectActionableElements(tree);

  return {
    tree,
    snapshot,
    actionableElements,
    actionableSummary: formatActionableElements(actionableElements),
    nodeLineCount: tree.split("\n").filter(Boolean).length,
    editorFound: tree.includes("[Document]"),
  };
}

function compactInspection(ui: UIInspection) {
  return {
    controls: ui.actionableSummary,
    editorFound: ui.editorFound,
    nodeLineCount: ui.nodeLineCount,
  };
}

const inspectUITool = tool({
  description: `
Inspect the current Notepad window and its accessible controls.
Use the exact accessible role and name returned here.
After a Save As dialog opens, inspect using windowTitle "Save As".
Never assume a dialog or menu opened without inspecting it.
`,
  inputSchema: z.object({
    windowTitle: z.string().optional(),
  }),
  execute: async ({ windowTitle }) => {
    try {
      const ui = await inspectWindow(windowTitle ?? MAIN_WINDOW_TITLE);

      return {
        success: true,
        windowTitle: windowTitle ?? MAIN_WINDOW_TITLE,
        ...compactInspection(ui),
      };
    } catch (error) {
      return {
        success: false,
        error: errorMessage(error),
      };
    }
  },
});

const clickElementTool = tool({
  description: `
Click one exact accessible control in Notepad.
Always inspect before clicking and inspect again after clicking.
Return the before/after UI diff.
For the Save As dialog, pass windowTitle "Save As".
After clicking Save in that dialog, inspect the main Notepad window.
Never click a disabled control or blindly repeat a failed action.
`,
  inputSchema: z.object({
    role: z.string().min(1),
    name: z.string().min(1),
    windowTitle: z.string().optional(),
  }),
  execute: async ({ role, name, windowTitle }) => {
    const currentTitle = windowTitle ?? MAIN_WINDOW_TITLE;

    try {
      const before = await inspectWindow(currentTitle);

      const match = before.actionableElements.find(
        (element) => element.role === role && element.name === name,
      );

      if (!match) {
        return {
          success: false,
          message: `Control not found: [${role}] ${name}`,
          availableControls: before.actionableSummary,
        };
      }

      if (match.enabled === false) {
        return {
          success: false,
          message: `Control is disabled: [${role}] ${name}`,
        };
      }

      const selector = `process:${PROCESS_NAME} >> (role:${role} && name:${name})`;

      const element = await desktop.locator(selector).first(5000);

      await element.click(actionOptions);
      await desktop.delay(400);

      // Switch inspection targets when the Save As dialog opens/closes.
      const lowerName = name.toLowerCase();

      const nextTitle =
        lowerName === "save as"
          ? "Save As"
          : currentTitle === "Save As" && lowerName === "save"
            ? MAIN_WINDOW_TITLE
            : currentTitle;

      const after = await inspectWindow(nextTitle);
      const diff = diffSnapshots(before.snapshot, after.snapshot);

      return {
        success: true,
        action: "click",
        clicked: { role, name },
        inspectedWindowAfterAction: nextTitle,
        changes: summarizeChanges(diff),
        after: compactInspection(after),
        nextStep: "Review the new UI state before taking another action.",
      };
    } catch (error) {
      return {
        success: false,
        message: `Click failed: [${role}] ${name}`,
        error: errorMessage(error),
      };
    }
  },
});

const typeTextTool = tool({
  description: `
Type text into a specific accessible element.
Inspect before typing and after typing, then return the UI diff.
Use the exact role and name from inspectUI.
For the Save As filename field, use its inspected role/name and
windowTitle "Save As".
clearBeforeTyping is enabled, so existing text in the target field
will be replaced. Do not target the document unless intended.
`,
  inputSchema: z.object({
    text: z.string().min(1),
    role: z.string().min(1),
    name: z.string().min(1),
    windowTitle: z.string().optional(),
  }),
  execute: async ({ text, role, name, windowTitle }) => {
    const currentTitle = windowTitle ?? MAIN_WINDOW_TITLE;

    try {
      const before = await inspectWindow(currentTitle);

      const match = before.actionableElements.find(
        (element) => element.role === role && element.name === name,
      );

      if (!match) {
        return {
          success: false,
          message: `Typing target not found: [${role}] ${name}`,
          availableControls: before.actionableSummary,
        };
      }

      if (match.enabled === false) {
        return {
          success: false,
          message: `Typing target is disabled: ${name}`,
        };
      }

      const selector = `process:${PROCESS_NAME} >> (role:${role} && name:${name})`;

      const element = await desktop.locator(selector).first(5000);

      await element.click(actionOptions);
      await element.typeText(text, actionOptions);
      await desktop.delay(300);

      const after = await inspectWindow(currentTitle);
      const diff = diffSnapshots(before.snapshot, after.snapshot);

      return {
        success: true,
        action: "typeText",
        target: { role, name },
        charactersRequested: text.length,
        changes: summarizeChanges(diff),
        after: compactInspection(after),
        note: "Typing was accepted by the action API; the UI diff may not expose field contents.",
      };
    } catch (error) {
      return {
        success: false,
        message: `Typing failed in [${role}] ${name}`,
        error: errorMessage(error),
      };
    }
  },
});

async function main() {
  console.log("Launching Notepad...");

  await desktop.openApplication("notepad.exe");
  await desktop.delay(1500);

  console.log("Starting desktop agent...");

  const result = await generateText({
    model: google(MODEL),

    system: `
You are a Windows desktop automation agent using Terminator.

CORE RULE:
Every UI action must follow this cycle:
1. Inspect the relevant window.
2. Identify the exact accessible control.
3. Perform exactly one action.
4. Inspect the resulting UI.
5. Review the returned diff and controls.
6. Decide the next action based on the new state.

Never perform a sequence of clicks based on assumptions.
The clickElement and typeText tools already inspect before and after
their actions. Read their results before choosing the next action.

SAVE WORKFLOW:
1. Inspect the main Notepad window.
2. Click File using its exact accessible role and name.
3. Review the returned diff and inspect the menu.
4. Click Save As using the exact role and name found in the menu.
5. Review the returned diff.
6. Inspect the Save As dialog using windowTitle "Save As".
7. Find the filename field from that inspection.
8. Use typeText on that exact field to enter:
   Vangrex-AI-Agent-Output.txt
9. Review the returned diff and inspect the dialog again.
10. Click the inspected Save button.
11. Inspect the resulting main window.
12. If an overwrite confirmation appears, inspect it first.
    Do not overwrite an existing file without explicit authorization.
13. If any step fails, stop and report the actual result.
14. Always use the UI to perform actions.

Do not claim a file was saved merely because the Save button was clicked.
Report only what the tool results establish.
Do not repeatedly click a control if the UI did not change.
`,

    prompt: `
Inspect Notepad and save the current document as
Vangrex-AI-Agent-Output-{any_id}.txt.

Inspect and review the diff after every action.
Do not type new document content.
Do not overwrite an existing file.
Report whether the save was confirmed by the resulting UI.
`,

    tools: {
      inspectUI: inspectUITool,
      clickElement: clickElementTool,
      typeText: typeTextTool,
    },

    stopWhen: stepCountIs(15),
  });

  console.log("\n========== AGENT RESPONSE ==========\n");
  console.log(result.text);

  // console.log("\n========== TOOL CALLS ==========\n");
  // console.dir(result.steps, { depth: 4 });
}

main().catch((error: unknown) => {
  console.error("Agent failed:", error);
  process.exitCode = 1;
});
