import { ChatRequestSchema, type Conversation } from '@bio-majesty/shared';
import {
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type UIMessage,
} from 'ai';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { buildChatTools, chatInstructions } from '../ai/chat-agent';
import { resolveWithFallback } from '../ai/fallback';
import { mergeProviderOptions } from '../ai/run-task';
import { corsHeaders, getUser, HttpError, parseBody, setRequestOrigin } from '../lib/http';
import { errorMessage, logger } from '../lib/logger';
import { listCategories } from '../repo/categories';
import { getConversation, loadMessages, saveConversation } from '../repo/chats';
import { getSettings } from '../repo/settings';

const MAX_HISTORY_MESSAGES = 40;

function titleFrom(message: UIMessage): string {
  const text = message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text || 'New conversation';
}

/**
 * POST /chat — streams an AI SDK UI message stream (SSE) through API Gateway
 * REST response streaming. The client sends only the new message; history is
 * loaded from S3 and saved again when the stream ends.
 */
export const handler = awslambda.streamifyResponse(async (event: APIGatewayProxyEvent, responseStream) => {
  setRequestOrigin(event);
  try {
    const user = getUser(event);
    const body = parseBody(event, ChatRequestSchema);
    const [settings, categories, previous, existing] = await Promise.all([
      getSettings(),
      listCategories(),
      loadMessages(user.sub, body.id),
      getConversation(user.sub, body.id),
    ]);
    const tools = buildChatTools(settings.stock.symbol);

    let messages: UIMessage[];
    try {
      messages = await validateUIMessages({ messages: [...previous, body.message], tools });
    } catch (err) {
      throw new HttpError(400, 'bad_request', `Invalid chat message: ${errorMessage(err)}`);
    }
    const latest = messages[messages.length - 1]!;
    const now = new Date().toISOString();
    const conversation: Conversation = existing
      ? { ...existing, updatedAt: now }
      : { id: body.id, title: titleFrom(latest), createdAt: now, updatedAt: now };

    const chat = settings.models.chat;
    const result = streamText({
      model: await resolveWithFallback(chat.model, chat.fallbackModel),
      instructions: chatInstructions(categories, settings.stock.symbol),
      messages: await convertToModelMessages(messages.slice(-MAX_HISTORY_MESSAGES)),
      tools,
      stopWhen: isStepCount(8),
      reasoning: chat.reasoning,
      providerOptions: mergeProviderOptions(chat.model, chat.providerOptions) as never,
      maxRetries: 2,
      onError: ({ error }) => logger.error('Chat stream error', { error: errorMessage(error) }),
    });
    // Keep generating (and persist the answer) even if the browser disconnects.
    void result.consumeStream();

    const response = createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: messages,
        generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
        onEnd: async ({ messages: all }) => {
          try {
            await saveConversation(user.sub, conversation, all);
          } catch (err) {
            logger.error('Failed to save conversation', { error: errorMessage(err) });
          }
        },
        onError: (error) => `The assistant hit an error: ${errorMessage(error).slice(0, 300)}`,
      }),
    });

    const http = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: response.status,
      headers: { ...Object.fromEntries(response.headers.entries()), ...corsHeaders() },
    });
    if (!response.body) {
      http.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), http);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) logger.error('Chat request failed', { error: errorMessage(err) });
    const http = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
    http.write(
      JSON.stringify({
        error: err instanceof HttpError ? err.code : 'internal_error',
        message: err instanceof HttpError ? err.message : 'Chat failed. Check the logs for details.',
      }),
    );
    http.end();
  }
});
