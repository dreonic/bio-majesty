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
import { buildChatTools, chatErrorText, chatInstructions, chatProviderOptions } from '../ai/chat-agent';
import { resolveWithFallback } from '../ai/fallback';
import { loadSubjectContext } from '../ai/subject';
import { corsHeaders, getUser, HttpError, parseBody, requireAccess, setRequestOrigin } from '../lib/http';
import { errorMessage, logger } from '../lib/logger';
import { resolveProfile } from '../lib/profile-access';
import { listCategories } from '../repo/categories';
import { getConversation, loadMessages, saveConversation } from '../repo/chats';
import { getSettings } from '../repo/settings';
import { getAssets } from '../repo/stock';
import { fallbackAsset } from '../stock';

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
    requireAccess(event);
    const user = await resolveProfile(event, getUser(event));
    const body = parseBody(event, ChatRequestSchema);
    const [settings, categories, previous, existing] = await Promise.all([
      getSettings(user.profileId),
      listCategories(user.profileId),
      loadMessages(user.profileId, body.id),
      getConversation(user.profileId, body.id),
    ]);
    // The chat sees only this profile's saved news and assets.
    const known = new Map((await getAssets(settings.stock.assets)).map((a) => [a.id, a]));
    const assets = settings.stock.assets.map((id) => known.get(id) ?? fallbackAsset(id));
    const tools = buildChatTools({ profileId: user.profileId, assets });

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
      instructions: chatInstructions(await loadSubjectContext(settings), categories, assets),
      messages: await convertToModelMessages(messages.slice(-MAX_HISTORY_MESSAGES)),
      tools,
      stopWhen: isStepCount(8),
      reasoning: chat.reasoning,
      providerOptions: chatProviderOptions(chat.model, chat.providerOptions) as never,
      maxRetries: 2,
      onStepFinish: ({ providerMetadata }) => {
        const dropped = providerMetadata?.anthropic?.inputTransformations;
        if (Array.isArray(dropped) && dropped.length) {
          logger.warn('Chat history no longer matched earlier reasoning; Claude answered without it', { inputTransformations: dropped });
        }
      },
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
            await saveConversation(user.profileId, conversation, all);
          } catch (err) {
            logger.error('Failed to save conversation', { error: errorMessage(err) });
          }
        },
        // Also the saved text of failed tool calls, replayed to the model later: keep it verbatim.
        onError: chatErrorText,
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
