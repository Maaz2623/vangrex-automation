import { google } from "@ai-sdk/google";
import { generateText, isStepCount, toolSearch, type ModelMessage } from "ai";
import "dotenv/config";
import { Bot } from "grammy";

import { INSTRUCTIONS } from "./instructions";
// --------------------------------------------------
// Configuration
// --------------------------------------------------

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

const bot = new Bot(botToken);

const conversations = new Map<number, ModelMessage[]>();

// --------------------------------------------------
// Gemini assistant
// --------------------------------------------------

async function runAssistant(messages: ModelMessage[]) {
  return generateText({
    model: google("gemini-flash-lite-latest"),
    instructions: "Use the agents you have to complete user's request.",
    messages,
    tools: {
      // search: toolSearch(),
    },
    stopWhen: isStepCount(5),
  });
}

// --------------------------------------------------
// /start
// --------------------------------------------------

bot.command("start", async (ctx) => {
  try {
    await ctx.reply(
      "Hello! I'm your Desktop Assistant. Send me a message to start chatting.",
    );
  } catch (error) {
    console.error("Start command error:", error);
  }
});

// --------------------------------------------------
// /reset
// --------------------------------------------------

bot.command("reset", async (ctx) => {
  try {
    conversations.delete(ctx.chat.id);

    await ctx.reply("Conversation history cleared. Let's start fresh!");
  } catch (error) {
    console.error("Reset command error:", error);
  }
});

// --------------------------------------------------
// Telegram messages
// --------------------------------------------------

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const userInput = ctx.message.text.trim();

  if (userInput.startsWith("/")) return;

  let messages = conversations.get(chatId);

  if (!messages) {
    messages = [];
    conversations.set(chatId, messages);
  }

  messages.push({
    role: "user",
    content: userInput,
  });

  try {
    await ctx.api.sendChatAction(chatId, "typing");

    const result = await runAssistant(messages);

    console.log(result.usage.inputTokens);

    // Preserve the complete assistant/tool interaction history.
    messages.push(...result.responseMessages);

    const replyText = result.text?.trim();

    if (replyText) {
      await ctx.reply(replyText);
    } else {
      console.log("Gemini returned no text:", result.content);

      await ctx.reply("I couldn't generate a text response. Please try again.");
    }
  } catch (error) {
    // Remove the failed user message to keep history consistent.
    messages.pop();

    console.error("Gemini error:", error);

    try {
      await ctx.reply(
        "Sorry, something went wrong while processing your request.",
      );
    } catch (telegramError) {
      console.error("Telegram reply error:", telegramError);
    }
  }
});

// --------------------------------------------------
// Error handling
// --------------------------------------------------

bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

// --------------------------------------------------
// Start bot
// --------------------------------------------------

bot.start({
  drop_pending_updates: true,
});

console.log("Telegram Gemini bot is running...");
