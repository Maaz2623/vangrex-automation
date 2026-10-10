import { tool } from "ai";
import { z } from "zod";
import { desktop } from "../desktop";

export const getCurrentlyRunningApplicationsTool = tool({
  description: `
    Retrieves the list of currently running desktop applications.
    Use this when the user asks which applications are running
    or wants to find an application to interact with.
  `,

  inputSchema: z.object({}),

  execute: async () => {
    try {
      const applications = await desktop.applications();

      return {
        success: true,
        count: applications.length,
        applications: applications.map((application) => ({
          processName: application.processName(),
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
