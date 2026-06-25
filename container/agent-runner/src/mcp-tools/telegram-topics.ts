/**
 * Telegram topic management MCP tools.
 *
 * Calls the Telegram Bot API directly (same pattern as @chat-adapter/telegram's
 * internal telegramFetch) because the adapter doesn't expose forum topic methods.
 *
 * Only loaded when TELEGRAM_BOT_TOKEN is available — the tool registration is
 * a no-op otherwise.
 */
import { registerTools } from './server.js';
import { getSessionRouting } from '../db/session-routing.js';
import type { McpToolDefinition } from './types.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/**
 * Resolve the Telegram chat ID from session routing.
 * Returns just the numeric chat ID portion (strips the "telegram:" prefix).
 */
function resolveChatId(optionalChatId?: string): string {
  if (optionalChatId) return optionalChatId;
  const session = getSessionRouting();
  if (!session.platform_id) {
    throw new Error('No active session routing — cannot determine chat ID.');
  }
  // platform_id is "telegram:<chatId>" or "telegram:<chatId>:<topicId>"
  return session.platform_id.replace(/^telegram:/, '').replace(/:.*$/, '');
}

/**
 * Low-level Telegram Bot API call.
 */
async function telegramFetch(token: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json() as { ok: boolean; result?: unknown; description?: string };
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram API error (${method}): ${data.description ?? response.statusText}`);
  }
  return data.result;
}

export const createTopic: McpToolDefinition = {
  tool: {
    name: 'create_topic',
    description:
      'Create a Telegram forum topic in the current group chat. Returns the topic ID which can be used as a destination for routing messages to that topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Topic name (max 128 characters).',
        },
        chat_id: {
          type: 'string',
          description: 'Telegram chat ID. Defaults to the current group chat.',
        },
        icon_color: {
          type: 'number',
          description: 'Color of the topic icon in RGB format (0x000000–0xFFFFFF).',
        },
        icon_custom_emoji_id: {
          type: 'string',
          description: 'Custom emoji ID for the topic icon.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name?.trim()) return err('name is required');
    const trimmed = name.trim();
    if (trimmed.length > 128) return err('Topic name must be 128 characters or fewer');

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return err('TELEGRAM_BOT_TOKEN not set — Telegram topic tools unavailable');

    const chatId = resolveChatId(args.chat_id as string | undefined);

    const payload: Record<string, unknown> = { chat_id: chatId, name: trimmed };
    if (args.icon_color !== undefined) payload.icon_color = args.icon_color;
    if (args.icon_custom_emoji_id !== undefined) payload.icon_custom_emoji_id = args.icon_custom_emoji_id;

    try {
      const result = (await telegramFetch(token, 'createForumTopic', payload)) as {
        message_thread_id: number;
        name: string;
      };
      return ok(`Topic "${result.name}" created (topic_id: ${result.message_thread_id})`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const editTopic: McpToolDefinition = {
  tool: {
    name: 'edit_topic',
    description: 'Edit an existing Telegram forum topic (rename or change icon).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic_id: {
          type: 'number',
          description: 'The message_thread_id of the topic to edit.',
        },
        chat_id: {
          type: 'string',
          description: 'Telegram chat ID. Defaults to the current group chat.',
        },
        name: {
          type: 'string',
          description: 'New topic name (optional — omit to only change icon).',
        },
        icon_custom_emoji_id: {
          type: 'string',
          description: 'New custom emoji ID for the topic icon.',
        },
      },
      required: ['topic_id'],
    },
  },
  async handler(args) {
    const topicId = args.topic_id as number;
    if (!topicId) return err('topic_id is required');

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return err('TELEGRAM_BOT_TOKEN not set — Telegram topic tools unavailable');

    const chatId = resolveChatId(args.chat_id as string | undefined);

    const payload: Record<string, unknown> = { chat_id: chatId, message_thread_id: topicId };
    if (args.name !== undefined) payload.name = (args.name as string).trim();
    if (args.icon_custom_emoji_id !== undefined) payload.icon_custom_emoji_id = args.icon_custom_emoji_id;

    try {
      await telegramFetch(token, 'editForumTopic', payload);
      return ok(`Topic ${topicId} updated.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// Only register if the bot token is available.
if (process.env.TELEGRAM_BOT_TOKEN) {
  registerTools([createTopic, editTopic]);
}
