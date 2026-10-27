import { useChat } from '@ai-sdk/react';
import { displaySymbol, type Category, type Sentiment, type StockAsset } from '@bio-majesty/shared';
import { useQueryClient } from '@tanstack/react-query';
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from 'ai';
import { Loader2, MessageSquarePlus, Search, SendHorizontal, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RuntimeConfig } from '../../app/config';
import { SentimentBadge } from '../../components/tags';
import { useToast } from '../../components/toast';
import { Button, EmptyState, Spinner, Textarea } from '../../components/ui';
import { authHeader } from '../../lib/api';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { qk, useCategories, useConversation, useConversations, useDeleteConversation, useStockAssets } from '../../lib/queries';
import { useOpenArticle } from '../news/ArticleSheet';
import { Markdown } from './Markdown';

const newId = () => crypto.randomUUID().replace(/-/g, '');

/** Starter questions, named after the account's first category and asset when it has them. */
function suggestions(categories: Pick<Category, 'name'>[], assets: Pick<StockAsset, 'id'>[]): string[] {
  const ticker = assets[0] ? displaySymbol(assets[0].id) : null;
  const topic = categories[0]?.name;
  return [
    ticker ? `What negative news appeared in the last 30 days, and how did ${ticker} trade around it?` : 'What negative news appeared in the last 30 days?',
    topic ? `Summarise recent coverage of ${topic}.` : 'Summarise the most important news of the past week.',
    'Is there any regulatory or policy news in the saved articles?',
    'Compare positive and negative coverage over the last quarter.',
  ];
}

export function ChatTab({ config }: { config: RuntimeConfig }) {
  const conversations = useConversations();
  const remove = useDeleteConversation();
  const toast = useToast();
  const [active, setActive] = useState<{ id: string; isNew: boolean }>(() => ({ id: newId(), isNew: true }));

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="p-3">
          <Button className="w-full" icon={<MessageSquarePlus className="size-4" />} onClick={() => setActive({ id: newId(), isNew: true })}>
            New chat
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversations">
          {conversations.isLoading && <Spinner className="mx-auto mt-4" />}
          {conversations.data?.map((c) => (
            <div key={c.id} className={cn('group flex items-center rounded-md', active.id === c.id ? 'bg-wash' : 'hover:bg-wash')}>
              <button className="min-w-0 flex-1 px-2.5 py-2 text-left" onClick={() => setActive({ id: c.id, isNew: false })}>
                <span className="block truncate text-sm text-ink">{c.title}</span>
                <span className="block text-xs text-muted">{relativeTime(c.updatedAt)}</span>
              </button>
              <button
                className="mr-1 hidden rounded p-1 text-muted group-hover:block hover:text-critical"
                aria-label={`Delete conversation ${c.title}`}
                onClick={() =>
                  remove.mutate(c.id, {
                    onSuccess: () => {
                      if (active.id === c.id) setActive({ id: newId(), isNew: true });
                    },
                    onError: toast.error,
                  })
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          {conversations.data?.length === 0 && <p className="px-2.5 py-2 text-xs text-muted">No conversations yet.</p>}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        {active.isNew ? (
          <ChatSession key={active.id} id={active.id} initialMessages={[]} config={config} />
        ) : (
          <ExistingConversation key={active.id} id={active.id} config={config} />
        )}
      </div>
    </div>
  );
}

function ExistingConversation({ id, config }: { id: string; config: RuntimeConfig }) {
  const { data, isLoading, error } = useConversation(id);
  if (isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (error) return <EmptyState title="Could not load this conversation">{error.message}</EmptyState>;
  return <ChatSession id={id} initialMessages={data?.messages ?? []} config={config} />;
}

function ChatSession({ id, initialMessages, config }: { id: string; initialMessages: UIMessage[]; config: RuntimeConfig }) {
  const client = useQueryClient();
  const [input, setInput] = useState('');
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: `${config.apiUrl}chat`,
        headers: () => authHeader(),
        // History lives server-side; send only the newest message.
        prepareSendMessagesRequest: ({ messages, id: chatId }) => ({ body: { id: chatId, message: messages[messages.length - 1] } }),
      }),
  );
  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    id,
    messages: initialMessages,
    transport,
    onFinish: () => void client.invalidateQueries({ queryKey: qk.conversations }),
  });
  const busy = status === 'submitted' || status === 'streaming';
  const bottomRef = useRef<HTMLDivElement>(null);
  const assets = useStockAssets().data ?? [];
  const starters = suggestions(useCategories().data ?? [], assets);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setInput('');
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(input);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="mx-auto max-w-2xl py-10">
            <h2 className="text-lg font-semibold text-ink">Ask about the saved news</h2>
            <p className="mt-1 text-sm text-ink-2">
              Answers come from articles you have saved, with links to the sources{assets.length ? ', plus price data for your assets' : ''}.
            </p>
            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {starters.map((s) => (
                <button key={s} onClick={() => submit(s)} className="rounded-lg border border-hairline bg-raised p-3 text-left text-sm text-ink hover:bg-wash">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            {messages.map((m) => (
              <Message key={m.id} message={m} />
            ))}
            {status === 'submitted' && (
              <div className="flex items-center gap-2 text-sm text-ink-2">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Thinking…
              </div>
            )}
            {error && (
              <div className="rounded-md bg-critical-wash px-3 py-2 text-sm text-ink">
                {error.message ? `The assistant hit an error: ${error.message}` : 'The assistant failed to answer.'}{' '}
                <button className="font-medium underline" onClick={() => void regenerate()}>
                  Try again
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <form onSubmit={onSubmit} className="shrink-0 border-t border-hairline bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            rows={Math.min(6, Math.max(1, input.split('\n').length))}
            placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
            aria-label="Message"
            className="resize-none"
          />
          {busy ? (
            <Button type="button" onClick={() => void stop()} icon={<Square className="size-4" />} aria-label="Stop">
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!input.trim()} icon={<SendHorizontal className="size-4" />} aria-label="Send">
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

interface ToolArticle {
  id: string;
  title: string;
  publishedAt: string;
  sourceName: string | null;
  sentiment: Sentiment;
}

const TOOL_LABELS: Record<string, string> = {
  searchNews: 'Searched saved news',
  listNews: 'Listed saved news',
  getArticle: 'Read an article',
  getAssetPrices: 'Checked prices',
  // The price tool's name in chats saved before assets had IDs.
  getStockPrices: 'Checked prices',
};

function Message({ message }: { message: UIMessage }) {
  const openArticle = useOpenArticle();
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-sm whitespace-pre-wrap text-white">{text}</div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        if (part.type === 'text') return <Markdown key={i} text={part.text} />;
        if (!isToolUIPart(part)) return null;
        // Saved calls of tools that no longer exist come back as dynamic tool parts.
        const name = getToolName(part);
        const input = part.input as { query?: string; keyword?: string; asset?: string; symbol?: string; from?: string; to?: string } | undefined;
        const range = input?.from ? `${input.from} → ${input.to ?? 'today'}` : '';
        // `symbol`: price calls saved before assets had IDs.
        const ticker = input?.asset ? displaySymbol(input.asset) : input?.symbol;
        const detail = input?.query ?? input?.keyword ?? (ticker ? `${ticker} ${range}`.trim() : range);
        const running = part.state === 'input-streaming' || part.state === 'input-available';
        const articles = extractArticles(part.state === 'output-available' ? part.output : undefined);
        return (
          <div key={i} className="space-y-2">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-wash px-2.5 py-1 text-xs text-ink-2">
              {running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Search className="size-3" aria-hidden />}
              {TOOL_LABELS[name] ?? name}
              {detail && <span className="max-w-64 truncate text-ink">“{detail}”</span>}
              {part.state === 'output-error' && <span className="text-critical">failed</span>}
            </div>
            {articles.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {articles.slice(0, 8).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => openArticle(a.id)}
                    className="w-56 shrink-0 rounded-lg border border-hairline bg-raised p-2.5 text-left hover:bg-wash"
                  >
                    <SentimentBadge sentiment={a.sentiment} />
                    <span className="mt-1.5 line-clamp-2 block text-xs font-medium text-ink">{a.title}</span>
                    <span className="mt-1 block text-xs text-muted">
                      {a.sourceName ?? ''} · {a.publishedAt}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function extractArticles(output: unknown): ToolArticle[] {
  if (!output || typeof output !== 'object') return [];
  const o = output as { results?: ToolArticle[]; articles?: ToolArticle[] };
  return (o.results ?? o.articles ?? []).filter((a) => a && typeof a.id === 'string');
}
