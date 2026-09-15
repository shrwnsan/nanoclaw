/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Telegram Bot API sender for weather messages.
 *
 * Port of `weather/senders/telegram.py`. Uses the platform's built-in
 * `fetch` (no `child_process`, no shell-out) — this matches the
 * v0.2.0 Python security fix that replaced a `curl` subprocess with
 * `urllib.request`.
 *
 * Channel string is **"telegram"** (matches Python's
 * `TelegramSender.channel`).
 */

import type { IWeatherSender, SendOptions, SendResult } from "../types.js";
import { SenderError } from "../types.js";

const API_BASE = "https://api.telegram.org/bot{token}/{method}";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TelegramSenderInit {
  bot_token?: string;
  default_chat_id?: string;
  parse_mode?: string;
  timeout?: number;
}

export class TelegramSender implements IWeatherSender {
  readonly channel = "telegram";

  private readonly botToken: string;
  private readonly defaultChatId: string | undefined;
  private readonly parseMode: string;
  private readonly timeoutMs: number;

  constructor(init: TelegramSenderInit = {}) {
    const token = init.bot_token ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new SenderError(
        "Telegram bot token required (bot_token or TELEGRAM_BOT_TOKEN)",
      );
    }
    this.botToken = token;
    this.defaultChatId =
      init.default_chat_id ?? process.env.TELEGRAM_CHAT_ID ?? undefined;
    this.parseMode = init.parse_mode ?? "MarkdownV2";
    this.timeoutMs = init.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: string, options: SendOptions = {}): Promise<SendResult> {
    const chatId = (options.chat_id as string | undefined) ?? this.defaultChatId;
    if (!chatId) {
      return {
        success: false,
        channel: this.channel,
        error: "No chat_id specified and no default configured",
      };
    }

    const topicId = options.topic_id as number | undefined;
    const disableNotification = options["disable_notification"] === true;

    // Build the Telegram payload. Conditional spread keeps the JSON
    // shape identical to Python's (omits keys that aren't set).
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: message,
      ...(this.parseMode ? { parse_mode: this.parseMode } : {}),
      ...(topicId != null ? { message_thread_id: topicId } : {}),
      ...(disableNotification ? { disable_notification: true } : {}),
    };

    const url = API_BASE.replace("{token}", this.botToken).replace(
      "{method}",
      "sendMessage",
    );

    try {
      const result = await this.postJson(url, payload);

      if (result && typeof result === "object" && (result as Record<string, unknown>)["ok"]) {
        const body = result as { result?: { message_id?: number | string } };
        const messageId = body.result?.message_id;
        return {
          success: true,
          channel: this.channel,
          ...(messageId != null ? { message_id: String(messageId) } : {}),
          metadata: { chat_id: chatId },
        };
      }

      const desc =
        (result as Record<string, unknown>)?.["description"] ?? "Unknown error";
      return {
        success: false,
        channel: this.channel,
        error: String(desc),
      };
    } catch (e) {
      if (e instanceof TelegramHttpError) {
        return {
          success: false,
          channel: this.channel,
          error: `HTTP ${e.status}: ${e.body}`,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        channel: this.channel,
        error: msg,
      };
    }
  }

  /** Convenience: post to a specific topic thread. */
  async sendToTopic(
    message: string,
    topicId: number,
    chatId?: string,
  ): Promise<SendResult> {
    return this.send(message, {
      ...(chatId != null ? { chat_id: chatId } : {}),
      topic_id: topicId,
    });
  }

  private async postJson(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new TelegramHttpError(resp.status, text);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new TelegramHttpError(resp.status, text);
    }
  }
}

class TelegramHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Telegram HTTP ${status}: ${body}`);
    this.name = "TelegramHttpError";
  }
}
