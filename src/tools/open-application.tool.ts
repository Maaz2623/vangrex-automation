import { tool } from "ai";
import { z } from "zod";
import { desktop } from "../desktop";

export const openApplicationTool = tool({
  description: `
    Opens or launches a desktop application by name.
    Use this when the user asks to open or launch an application.
    Provide the application's name, such as "Code", "Notepad", or "Chrome".
  `,

  inputSchema: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .describe("Name of the desktop application to open."),
  }),

  execute: async ({ name }) => {
    try {
      const application = desktop.openApplication(name);

      desktop.activateApplication(name);

      return {
        success: true,
        name,
        message: `Opened application: ${name}`,
      };
    } catch (error) {
      return {
        success: false,
        name,
        error:
          error instanceof Error
            ? error.message
            : "Failed to open the application.",
      };
    }
  },
});
