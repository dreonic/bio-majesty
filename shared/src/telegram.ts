import { z } from 'zod';
import { IsoDateTime } from './common';

/** Where a new connection goes: a private chat with the bot, or a group (or one topic of a forum supergroup). */
export const TELEGRAM_LINK_KINDS = ['private', 'group'] as const;
export type TelegramLinkKind = (typeof TELEGRAM_LINK_KINDS)[number];

/** Chats and topics one account can send its notifications to. */
export const MAX_TELEGRAM_CONNECTIONS = 10;

/** One chat or topic that gets the account's digests and alerts. */
export const TelegramConnectionSchema = z.object({
  id: z.string(),
  /** "Chat" or "Group › Topic". */
  chatTitle: z.string(),
  kind: z.enum(TELEGRAM_LINK_KINDS),
  linkedAt: IsoDateTime,
});
export type TelegramConnection = z.infer<typeof TelegramConnectionSchema>;

export const TelegramLinkStartRequestSchema = z.object({ kind: z.enum(TELEGRAM_LINK_KINDS) });
export type TelegramLinkStartRequest = z.infer<typeof TelegramLinkStartRequestSchema>;

export const TelegramLinkStartResponseSchema = z.object({
  kind: z.enum(TELEGRAM_LINK_KINDS),
  code: z.string(),
  /** private: opens a private chat with the bot; pressing Start connects it. */
  deepLink: z.string().nullable(),
  /** group: sent in the group or in one of its topics (/start@<bot> <code>), connects that group or topic. */
  groupCommand: z.string().nullable(),
  expiresAt: IsoDateTime,
});
export type TelegramLinkStartResponse = z.infer<typeof TelegramLinkStartResponseSchema>;

export const TelegramLinkVerifyRequestSchema = z.object({ code: z.string().min(8).max(64) });

export const TelegramLinkVerifyResponseSchema = z.object({
  linked: z.boolean(),
  chatTitle: z.string().nullable(),
});
export type TelegramLinkVerifyResponse = z.infer<typeof TelegramLinkVerifyResponseSchema>;
