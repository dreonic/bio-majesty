import { z } from 'zod';
import { IsoDateTime } from './common';

export const TelegramLinkStartResponseSchema = z.object({
  /** Opens a private chat with the bot; pressing Start links it. */
  deepLink: z.string(),
  /** Sent in a group or in one of its topics (/start@<bot> <code>), links that group or topic. */
  groupCommand: z.string(),
  code: z.string(),
  expiresAt: IsoDateTime,
});
export type TelegramLinkStartResponse = z.infer<typeof TelegramLinkStartResponseSchema>;

export const TelegramLinkVerifyRequestSchema = z.object({ code: z.string().min(8).max(64) });

export const TelegramLinkVerifyResponseSchema = z.object({
  linked: z.boolean(),
  chatTitle: z.string().nullable(),
});
export type TelegramLinkVerifyResponse = z.infer<typeof TelegramLinkVerifyResponseSchema>;
