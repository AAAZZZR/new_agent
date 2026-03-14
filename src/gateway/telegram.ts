import { Bot, Context } from 'grammy';
import type { AppConfig, ToolResult } from '../types/index.js';
import type { LLMRouter } from '../llm/router.js';
import type { MCPManager } from '../mcp/manager.js';
import type { SessionManager } from '../session/manager.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('gateway');

interface GatewayDeps {
  config: AppConfig;
  llm: LLMRouter;
  mcp: MCPManager;
  sessions: SessionManager;
}

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const { config, llm, mcp, sessions } = deps;
  const bot = new Bot(config.telegram.botToken);

  // Handle text messages
  bot.on('message:text', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const senderId = ctx.from?.id;
    const senderName = ctx.from?.first_name;
    const text = ctx.message?.text;

    if (!chatId || !senderId || !text) return;

    log.info(`Message from ${senderName} (${senderId}): ${text.slice(0, 50)}...`);

    // Get or create session
    const session = sessions.getOrCreate(chatId, {
      senderId,
      senderName,
      isOwner: senderId === config.auth.ownerId,
    });

    // Add user message
    sessions.addMessage(chatId, {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });

    // Check permissions
    const isOwner = senderId === config.auth.ownerId;
    const canUseTools = isOwner || config.auth.guestPermissions.canUseTools;

    try {
      // Send typing indicator
      await ctx.replyWithChatAction('typing');

      // Get available tools
      const tools = canUseTools ? mcp.getTools() : [];

      // Call LLM
      let response = await llm.chat({
        model: config.llm.defaultModel,
        messages: sessions.getMessages(chatId),
        tools: tools.length > 0 ? tools : undefined,
      });

      // Tool calling loop
      let iterations = 0;
      const MAX_ITERATIONS = 10;

      while (response.toolCalls && response.toolCalls.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;
        log.info(`Tool calls (iteration ${iterations}): ${response.toolCalls.map(t => t.name).join(', ')}`);

        // Add assistant message with tool calls
        sessions.addMessage(chatId, {
          role: 'assistant',
          content: response.content || '',
          toolCalls: response.toolCalls,
          timestamp: Date.now(),
        });

        // Execute tool calls via MCP
        const results: ToolResult[] = [];
        for (const call of response.toolCalls) {
          await ctx.replyWithChatAction('typing');

          try {
            const result = await mcp.executeTool(call.name, call.arguments);
            results.push({
              toolCallId: call.id,
              content: typeof result === 'string' ? result : JSON.stringify(result),
            });
          } catch (err) {
            results.push({
              toolCallId: call.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            });
          }
        }

        // Add tool results to session
        for (const result of results) {
          sessions.addMessage(chatId, {
            role: 'tool',
            content: result.content,
            toolCallId: result.toolCallId,
            timestamp: Date.now(),
          });
        }

        // Call LLM again with tool results
        response = await llm.chat({
          model: config.llm.defaultModel,
          messages: sessions.getMessages(chatId),
          tools: tools.length > 0 ? tools : undefined,
        });
      }

      // Add final assistant response
      if (response.content) {
        sessions.addMessage(chatId, {
          role: 'assistant',
          content: response.content,
          timestamp: Date.now(),
        });

        // Send reply (split long messages)
        await sendLongMessage(ctx, response.content);
      }

      // Update token count
      sessions.updateTokenCount(chatId, response.usage.totalTokens);

    } catch (err) {
      log.error(`Error handling message:`, err);
      await ctx.reply('⚠️ An error occurred. Please try again.');
    }
  });

  // Handle /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(`Hi! I'm ${config.agent.name}. How can I help you?`);
  });

  // Handle /reset command (clear session)
  bot.command('reset', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId) {
      sessions.clear(chatId);
      await ctx.reply('🔄 Session cleared.');
    }
  });

  return {
    async start() {
      await bot.start({
        onStart: () => log.info('Bot is running (polling mode)'),
      });
    },
    async stop() {
      await bot.stop();
    },
  };
}

/** Split and send messages that exceed Telegram's 4096 char limit */
async function sendLongMessage(ctx: Context, text: string) {
  const MAX_LENGTH = 4000;

  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {
      // Fallback to plain text if Markdown parsing fails
      return ctx.reply(text);
    });
    return;
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (newline or space)
    let splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (splitAt === -1 || splitAt < MAX_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(' ', MAX_LENGTH);
    }
    if (splitAt === -1 || splitAt < MAX_LENGTH / 2) {
      splitAt = MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => {
      return ctx.reply(chunk);
    });
  }
}
