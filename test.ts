import "dotenv/config";

import { google } from "@ai-sdk/google";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import Terminator, { desktop } from "./src/desktop";

const MODEL = "gemini-3.5-flash-lite";
const PROCESS_NAME = "ApplicationFrameHost";
const WINDOW_TITLE = "Calculator";

const actionOptions = {
  includeWindowScreenshot: false,
};

async function inspectCalculator(): Promise<string> {
  const result = await desktop.getWindowTreeResult(PROCESS_NAME, WINDOW_TITLE, {
    formatOutput: true,
    propertyMode: Terminator.PropertyLoadingMode.Complete,
    treeOutputFormat: Terminator.TreeOutputFormat.CompactYaml,
  });

  return result.formatted || "The Calculator UI tree was empty.";
}

const inspectUITool = tool({
  description:
    "Inspect Calculator and return its current accessibility tree. Inspect before clicking buttons.",
  inputSchema: z.object({}),
  execute: async () => ({
    tree: await inspectCalculator(),
  }),
});

const clickButtonTool = tool({
  description:
    "Click a visible Calculator button by its exact accessible name. Inspect the tree first. Never use keyboard shortcuts.",
  inputSchema: z.object({
    name: z.string().min(1),
  }),
  execute: async ({ name }) => {
    const tree = await inspectCalculator();

    const matchingLine = tree.split("\n").find((line) => {
      const match = line.match(/\[Button\]\s+(.*?)(?:\s+\(bounds:|$)/);

      return match?.[1]?.trim() === name;
    });

    if (!matchingLine) {
      return {
        success: false,
        message: `Button "${name}" was not found in the current tree.`,
        tree,
      };
    }

    try {
      const selector =
        `process:${PROCESS_NAME} >> ` + `(role:Button && name:${name})`;

      const button = await desktop.locator(selector).first(5000);

      await button.click(actionOptions);
      await desktop.delay(250);

      return {
        success: true,
        clicked: name,
        refreshedTree: await inspectCalculator(),
      };
    } catch (error) {
      return {
        success: false,
        message: `Could not click Calculator button "${name}".`,
        error: error instanceof Error ? error.message : String(error),
        tree: await inspectCalculator(),
      };
    }
  },
});

const verifyDisplayTool = tool({
  description:
    "Inspect Calculator and verify that its visible accessibility tree contains the expected result.",
  inputSchema: z.object({
    expected: z.string(),
  }),
  execute: async ({ expected }) => {
    const tree = await inspectCalculator();

    const verified = tree.includes(expected);

    return {
      expected,
      verified,
      tree,
      message: verified
        ? `The accessibility tree contains "${expected}".`
        : `Could not verify "${expected}" in the accessibility tree. Inspect the tree to identify the displayed result.`,
    };
  },
});

async function main() {
  console.log("Launching Calculator...");

  await desktop.openApplication("calc.exe");
  await desktop.delay(1500);

  console.log("Calculator launched. Starting AI agent...");

  const result = await generateText({
    model: google(MODEL),

    system: `
You are a Windows Calculator automation agent using Terminator.

Rules:
1. Inspect Calculator before acting.
2. Use only the provided tools.
3. Do not use keyboard shortcuts or type numbers directly.
4. Click visible Calculator buttons using their exact accessible names.
5. Check each tool result before deciding the next action.
6. If a tool returns success: false, do not repeat the same failed action.
7. Perform the calculation 12 + 34 = 46.
8. Click buttons in this order: 1, 2, Plus, 3, 4, Equals.
9. Inspect the UI after the calculation.
10. Verify the result 46 using the verification tool.
11. If the displayed result is not exposed in the tree, report that limitation honestly.
12. Never claim success without verification.
`,

    prompt: `
Calculate 12 + 34 using Calculator's visible buttons.

First inspect the UI. Confirm the button names in the tree before clicking.
Click 1, 2, Plus, 3, 4, and Equals, one at a time.
Inspect the UI and verify that the final result is 46.
`,

    tools: {
      inspectUI: inspectUITool,
      clickButton: clickButtonTool,
      verifyDisplay: verifyDisplayTool,
    },

    stopWhen: stepCountIs(12),
  });

  console.log("\n========== AGENT RESPONSE ==========\n");
  console.log(result.text);

  console.log("\n========== TOOL CALLS ==========\n");
  console.dir(result.steps, { depth: 5 });
}

main().catch((error: unknown) => {
  console.error("Agent failed:", error);
  process.exitCode = 1;
});
