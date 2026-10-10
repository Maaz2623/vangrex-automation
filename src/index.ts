import { google } from "@ai-sdk/google";
import { streamText, type ModelMessage } from "ai";
import "dotenv/config";
import { Bot } from "grammy";

const botToken = process.env.TELEGRAM_BOT_TOKEN!;

if (!botToken) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

const bot = new Bot(botToken);

const conversations = new Map<number, ModelMessage[]>();

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Hello! I'm your Desktop Assistant. Send me a message to start chatting.",
  );
});

bot.command("reset", async (ctx) => {
  conversations.delete(ctx.chat.id);
  await ctx.reply("Conversation history cleared. Let's start fresh!");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const userInput = ctx.message.text;

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

  // Show a typing indicator while Gemini generates a response.
  await ctx.api.sendChatAction(chatId, "typing");

  try {
    const result = streamText({
      model: google("gemini-3.5-flash-lite"),

      messages,
    });

    let fullResponse = "";

    for await (const delta of result.textStream) {
      fullResponse += delta;
    }

    if (!fullResponse.trim()) {
      await ctx.reply("I couldn't generate a response. Please try again.");
      return;
    }

    messages.push({
      role: "assistant",
      content: fullResponse,
    });

    // Telegram messages have a 4096-character limit.
    const chunks = fullResponse.match(/[\s\S]{1,4000}/g) ?? [];

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    // Remove the failed user message so history stays consistent.
    messages.pop();

    console.error("Gemini error:", error);

    await ctx.reply(
      "Sorry, something went wrong while generating the response.",
    );
  }
});

bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

bot.start();
console.log("Telegram Gemini bot is running...");
