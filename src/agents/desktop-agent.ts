import { google } from "@ai-sdk/google";
import { isStepCount, tool, ToolLoopAgent } from "ai";
import { INSTRUCTIONS } from "../instructions";
import { shortcutTool } from "../tools/shortcut.tool";
import { getCurrentFocusedApplication } from "../tools/get-current-focused-application.tool";
import { getCurrentlyRunningApplicationsTool } from "../tools/get-currently-running-applications.tool";
import { focusApplicationTool } from "../tools/focus-application.tool";
import { openApplicationTool } from "../tools/open-application.tool";
import z from "zod";

export const desktopAgent = new ToolLoopAgent({
  model: google("gemini-3.5-flash-lite"),
  instructions: INSTRUCTIONS,
  tools: {
    // search: toolSearch(),
    executeShortcuts: shortcutTool,
    getCurrentFocusedApplication,
    getCurrentlyRunningApplications: getCurrentlyRunningApplicationsTool,
    focusApplication: focusApplicationTool,
    openApplication: openApplicationTool,
  },
  stopWhen: isStepCount(5),
});

export const desktopAgentTool = tool({
  description: "",
  inputSchema: z.object({
    task: z.string().describe("The task to perform on the desktop"),
  }),
  execute: async ({ task }, { abortSignal }) => {
    const result = await desktopAgent.generate({
      prompt: task,
      abortSignal,
    });

    

    return result.text;
  },
});
