import { z } from 'zod';
import { IsoDateTime, SentimentSchema } from './common';

export const ConversationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  title: z.string(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * Body sent by the chat UI: only the newest message plus the conversation id
 * (history is loaded server-side). `message` is an AI SDK UIMessage and is
 * validated on the server with `validateUIMessages`.
 */
export const ChatRequestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  message: z.unknown(),
});

/** Shape returned by the chat tools so the UI can render source cards. */
export const ChatSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  sourceName: z.string().nullable(),
  publishedAt: z.string(),
  sentiment: SentimentSchema,
  summary: z.string(),
});
export type ChatSource = z.infer<typeof ChatSourceSchema>;
