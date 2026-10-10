import { tool } from "ai";
import { z } from "zod";
import { desktop } from "../desktop";

export const focusApplicationTool = tool({
  description: `
    Focuses a desktop application by its process name and verifies
    that it became the currently focused application.
  `,
  inputSchema: z.object({
    processName: z
      .string()
      .trim()
      .min(1)
      .describe("The process name of the application to focus."),
  }),
  execute: async ({ processName }) => {
    try {
      await desktop.activateApplication(processName);

      const focusedApplication = await desktop.getCurrentApplication();
      const focusedProcessName = focusedApplication.processName();

      if (focusedProcessName?.toLowerCase() !== processName.toLowerCase()) {
        return {
          success: false,
          processName,
          actualFocusedApplication: focusedProcessName,
          error: `Could not focus "${processName}". Currently focused application: "${focusedProcessName ?? "unknown"}".`,
        };
      }

      return {
        success: true,
        processName: focusedProcessName,
        message: `Successfully focused application: ${focusedProcessName}`,
      };
    } catch (error) {
      return {
        success: false,
        processName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
