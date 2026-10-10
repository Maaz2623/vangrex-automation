import { tool } from "ai";
import { z } from "zod";
import { desktop } from "../desktop";

export const getCurrentFocusedApplication = tool({
  description: `
    Gets information about the currently focused desktop application.
    Use this tool before performing UI automation when you need to know
    which application the user is currently interacting with.
    Returns the application's process name.
  `,

  inputSchema: z.object({}),

  execute: async () => {
    try {
      const application = await desktop.getCurrentApplication();
      const processName = application.processName();

      if (!processName) {
        return {
          success: false,
          error: "Could not determine the focused application's process name.",
        };
      }

      return {
        success: true,
        processName,
        message: `Currently focused application: ${processName}`,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get the currently focused application.",
      };
    }
  },
});
