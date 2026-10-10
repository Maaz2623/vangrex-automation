import { tool } from "ai";
import z from "zod";
import { desktop } from "../desktop";
import { pressShortcut } from "../utils/keyboard";

export const shortcutTool = tool({
  description: `
    Press a keyboard shortcut in the currently focused desktop application.
    Use standard shortcut notation such as Ctrl+C, Ctrl+Shift+M, Alt+Tab,
    Enter, Escape, or F5.
  `,

  inputSchema: z.object({
    shortcut: z
      .string()
      .min(1)
      .describe('Keyboard shortcut to press, e.g. "Ctrl+Shift+M" or "Enter"'),

    process: z
      .string()
      .optional()
      .describe("Defaults to the currently focused application."),
  }),

  execute: async ({ shortcut, process }) => {
    try {
      const targetProcess =
        process ?? (await desktop.getCurrentApplication()).processName();

      await pressShortcut(shortcut, targetProcess);

      return {
        success: true,
        shortcut,
        process: targetProcess,
        message: `Successfully pressed ${shortcut}`,
      };
    } catch (error) {
      return {
        success: false,
        shortcut,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
