import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { convertToModelMessages, isStepCount, streamText, tool, toUIMessageStream, type UIMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatErrorText, chatProviderOptions } from '../src/ai/chat-agent';
import { ModelConfigError } from '../src/ai/registry';
import { errorMessage } from '../src/lib/logger';

type Part = LanguageModelV4StreamPart;
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const start: Part = { type: 'stream-start', warnings: [] };
const finish = (unified: 'stop' | 'tool-calls'): Part => ({ type: 'finish', finishReason: { unified, raw: unified }, usage });
const thinking = (id: string, signature: string): Part[] => [
  { type: 'reasoning-start', id },
  { type: 'reasoning-delta', id, delta: 'Let me search the saved news.' },
  { type: 'reasoning-end', id, providerMetadata: { anthropic: { signature } } },
];
const answer = (text: string): Part[] => [
  { type: 'text-start', id: 'text' },
  { type: 'text-delta', id: 'text', delta: text },
  { type: 'text-end', id: 'text' },
];

const userMessage = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Runs a chat turn whose tool fails, saves the history the way the chat Lambda does
 * (UI message stream with `onError`, stored as JSON in S3), then sends a follow-up.
 * Returns what the model saw in turn 1 and the same stretch of history as replayed.
 */
async function replay(onError: (error: unknown) => string) {
  const model = new MockLanguageModelV4({
    doStream: [
      // Turn 1: think, call a tool that fails, think again, answer.
      { stream: convertArrayToReadableStream([start, ...thinking('r1', 'sig-1'), { type: 'tool-call', toolCallId: 'call-1', toolName: 'searchNews', input: '{"query":"Acme"}' }, finish('tool-calls')]) },
      { stream: convertArrayToReadableStream([start, ...thinking('r2', 'sig-2'), ...answer('Search is unavailable.'), finish('stop')]) },
      // Turn 2: the follow-up.
      { stream: convertArrayToReadableStream([start, ...answer('Follow-up answer.'), finish('stop')]) },
    ],
  });
  const tools = {
    searchNews: tool({
      inputSchema: z.object({ query: z.string() }),
      execute: async (): Promise<string> => {
        throw new ModelConfigError('No API key configured for google. Add GOOGLE_GENERATIVE_AI_API_KEY to the secret.');
      },
    }),
  };

  const first = [userMessage('u1', 'Any news on Acme?')];
  let saved: UIMessage[] = [];
  const turn1 = streamText({ model, tools, stopWhen: isStepCount(8), messages: await convertToModelMessages(first) });
  const ui = toUIMessageStream({ stream: turn1.stream, originalMessages: first, onError, onEnd: ({ messages }) => void (saved = json(messages)) });
  for await (const _ of ui);

  const turn2 = streamText({
    model,
    tools,
    stopWhen: isStepCount(8),
    messages: await convertToModelMessages([...saved, userMessage('u2', 'And the share price?')]),
  });
  await turn2.consumeStream();

  const seen = model.doStreamCalls[1]!.prompt; // turn 1, second step: after the failed tool call
  return { seen: json(seen), replayed: json(model.doStreamCalls[2]!.prompt.slice(0, seen.length)) };
}

describe('chat history replay', () => {
  it('replays a failed tool call exactly as the model saw it, so earlier thinking stays valid', async () => {
    const { seen, replayed } = await replay(chatErrorText);
    expect(JSON.stringify(seen)).toContain('No API key configured for google');
    expect(replayed).toEqual(seen);
  });

  it('broke with the old error text, which caused "thinking block is bound to a different conversation"', async () => {
    const { seen, replayed } = await replay((error) => `The assistant hit an error: ${errorMessage(error)}`);
    expect(replayed).not.toEqual(seen);
  });
});

describe('chatProviderOptions', () => {
  it('lets Claude drop stale reasoning instead of failing, keeping the thinking the reasoning level gives', () => {
    expect(chatProviderOptions('anthropic:claude-haiku-5-5', null)).toEqual({
      anthropic: { thinking: { blockBinding: { prefixMismatchBehavior: 'drop_block' }, type: 'adaptive', display: 'summarized' } },
    });
    expect(chatProviderOptions('anthropic:claude-opus-5-5', { anthropic: { thinking: { type: 'adaptive', display: 'updates' } } })).toEqual({
      anthropic: {
        fallbacks: 'default',
        thinking: { blockBinding: { prefixMismatchBehavior: 'drop_block' }, type: 'adaptive', display: 'updates' },
      },
    });
    expect(chatProviderOptions('google:gemini-3-flash', null)).toBeUndefined();
  });

  it('sends block_binding with its beta header and the effort from the reasoning level', async () => {
    let request: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const anthropic = createAnthropic({
      apiKey: 'test',
      fetch: async (_url, init) => {
        request = { headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
        throw new Error('not sent');
      },
    });
    const result = streamText({
      model: anthropic('claude-haiku-5-5'),
      prompt: 'Hi',
      reasoning: 'medium',
      providerOptions: chatProviderOptions('anthropic:claude-haiku-5-5', null) as never,
      maxRetries: 0,
      onError: () => {},
    });
    await result.consumeStream();
    expect(request?.body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(request?.body.output_config).toEqual({ effort: 'medium' });
    expect(request?.headers['anthropic-beta']).toContain('thinking-binding-controls-2026-08-01');
  });
});
