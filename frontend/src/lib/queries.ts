import type {
  Article,
  ArticleDetail,
  ArticleStatus,
  BulkReviewRequest,
  CatalogModel,
  Category,
  CategoryInput,
  CategoryUpdate,
  Conversation,
  DeletableStatus,
  DeleteNewsRequest,
  DeleteNewsResponse,
  Digest,
  FeedbackStats,
  NewsListResponse,
  PendingCounts,
  ReviewRequest,
  Run,
  Sentiment,
  SettingsUpdate,
  SettingsView,
  StockAssetsResponse,
  StockExportInterval,
  StockExportResponse,
  StockHistoryResponse,
  StockRange,
  SuggestQueriesResponse,
  TelegramLinkStartResponse,
  TelegramLinkVerifyResponse,
  TestModelResponse,
  VolumeAnomaly,
} from '@bio-majesty/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { api } from './api';

export const qk = {
  news: (filters: NewsFilters) => ['news', filters] as const,
  newsAll: ['news'] as const,
  counts: ['counts'] as const,
  article: (id: string) => ['article', id] as const,
  digest: ['digest'] as const,
  categories: ['categories'] as const,
  settings: ['settings'] as const,
  models: ['models'] as const,
  runs: ['runs'] as const,
  assets: ['assets'] as const,
  stock: (symbol: string, range: StockRange) => ['stock', symbol, range] as const,
  anomalies: (symbol: string, from: string) => ['anomalies', symbol, from] as const,
  feedbackStats: ['feedback-stats'] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
};

export interface NewsFilters {
  status: ArticleStatus;
  from?: string;
  to?: string;
  categories?: string[];
  sentiments?: Sentiment[];
  q?: string;
  limit?: number;
}

export function useNews(filters: NewsFilters) {
  return useInfiniteQuery({
    queryKey: qk.news(filters),
    queryFn: ({ pageParam, signal }) =>
      api<NewsListResponse>('news', { query: { ...filters, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useCounts() {
  return useQuery({ queryKey: qk.counts, queryFn: () => api<PendingCounts>('news/counts'), refetchInterval: 60_000 });
}

export function useArticle(id: string | null) {
  return useQuery({
    queryKey: qk.article(id ?? ''),
    queryFn: () => api<ArticleDetail>(`news/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

/** Remove an article from every cached news list (used for optimistic review). */
function dropFromLists(client: ReturnType<typeof useQueryClient>, id: string) {
  client.setQueriesData<InfiniteData<NewsListResponse>>({ queryKey: qk.newsAll }, (data) =>
    data
      ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((a) => a.id !== id) })) }
      : data,
  );
}

export function useReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ReviewRequest & { id: string }) =>
      api<Article>(`news/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onMutate: async ({ id, action }) => {
      if (action === 'update') return;
      await client.cancelQueries({ queryKey: qk.newsAll });
      dropFromLists(client, id);
    },
    onSuccess: (article) => client.setQueryData(qk.article(article.id), (old: ArticleDetail | undefined) => (old ? { ...old, ...article } : old)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.newsAll });
      void client.invalidateQueries({ queryKey: qk.counts });
      void client.invalidateQueries({ queryKey: qk.feedbackStats });
    },
  });
}

/** The bulk endpoints take at most this many ids per request. */
const BULK_LIMIT = 100;

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/** Save, skip or restore any number of articles (sent in batches the API accepts). */
export function useBulkReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, action }: BulkReviewRequest) => {
      const total = { updated: 0, failed: [] as { id: string; error: string }[] };
      for (const batch of chunks(ids, BULK_LIMIT)) {
        const res = await api<{ updated: number; failed: { id: string; error: string }[] }>('news/bulk', {
          method: 'POST',
          body: { ids: batch, action },
        });
        total.updated += res.updated;
        total.failed.push(...res.failed);
      }
      return total;
    },
    onMutate: async ({ ids }) => {
      await client.cancelQueries({ queryKey: qk.newsAll });
      for (const id of ids) dropFromLists(client, id);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.newsAll });
      void client.invalidateQueries({ queryKey: qk.counts });
    },
  });
}

/**
 * Delete skipped or filtered articles for good: chosen ids, or every article with a
 * status (repeated while the API reports more, e.g. a very full recycle bin).
 */
export function useDeleteNews() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (target: { ids: string[] } | { status: DeletableStatus }) => {
      const total: DeleteNewsResponse = { deleted: 0, failed: [], more: false };
      const send = async (body: DeleteNewsRequest) => {
        const res = await api<DeleteNewsResponse>('news/delete', { method: 'POST', body });
        total.deleted += res.deleted;
        total.failed.push(...res.failed);
        return res;
      };
      if ('ids' in target) {
        for (const ids of chunks(target.ids, BULK_LIMIT)) await send({ ids });
      } else {
        let res: DeleteNewsResponse;
        do res = await send({ status: target.status });
        while (res.more && res.deleted > 0);
      }
      return total;
    },
    onMutate: async (target) => {
      await client.cancelQueries({ queryKey: qk.newsAll });
      if ('ids' in target) {
        for (const id of target.ids) dropFromLists(client, id);
      } else {
        client.setQueriesData<InfiniteData<NewsListResponse>>(
          { queryKey: qk.newsAll, predicate: (q) => (q.queryKey[1] as NewsFilters | undefined)?.status === target.status },
          (data) => (data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: [] })) } : data),
        );
      }
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.newsAll });
      void client.invalidateQueries({ queryKey: qk.counts });
    },
  });
}

export function useDigest() {
  return useQuery({ queryKey: qk.digest, queryFn: () => api<{ digest: Digest | null }>('digest/latest'), refetchInterval: 5 * 60_000 });
}

export function useCategories() {
  return useQuery({
    queryKey: qk.categories,
    queryFn: () => api<{ items: Category[] }>('categories'),
    select: (d) => d.items,
    // Poll while a backfill is in progress so its status updates.
    refetchInterval: (query) =>
      query.state.data?.items.some((c) => c.backfill.status === 'running' || c.backfill.status === 'pending') ? 15_000 : false,
  });
}

export function useCreateCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CategoryInput) => api<Category>('categories', { method: 'POST', body }),
    onSettled: () => client.invalidateQueries({ queryKey: qk.categories }),
  });
}

export function useUpdateCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: CategoryUpdate & { id: string }) =>
      api<Category>(`categories/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSettled: () => client.invalidateQueries({ queryKey: qk.categories }),
  });
}

export function useDeleteCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`categories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: qk.categories }),
  });
}

export function useBackfill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, months }: { id: string; months: number }) =>
      api<Category>(`categories/${encodeURIComponent(id)}/backfill`, { method: 'POST', body: { months } }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.categories });
      void client.invalidateQueries({ queryKey: qk.runs });
    },
  });
}

export function useSuggestQueries() {
  return useMutation({
    mutationFn: (body: { name: string; description: string }) =>
      api<SuggestQueriesResponse>('categories/suggest-queries', { method: 'POST', body }),
  });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => api<SettingsView>('settings') });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdate) => api<SettingsView>('settings', { method: 'PUT', body }),
    onSuccess: (data) => client.setQueryData(qk.settings, data),
  });
}

export function useModels() {
  return useQuery({
    queryKey: qk.models,
    queryFn: () => api<{ configuredProviders: string[]; models: (CatalogModel & { available: boolean })[] }>('settings/models'),
  });
}

export function useTestModel() {
  return useMutation({
    mutationFn: (model: string) => api<TestModelResponse>('settings/test-model', { method: 'POST', body: { model } }),
  });
}

export function useRuns() {
  return useQuery({
    queryKey: qk.runs,
    queryFn: () => api<{ items: Run[] }>('runs'),
    select: (d) => d.items,
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === 'running') ? 10_000 : 60_000),
  });
}

export function useRunDaily() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ executionArn: string }>('runs/daily', { method: 'POST' }),
    onSettled: () => setTimeout(() => void client.invalidateQueries({ queryKey: qk.runs }), 2_000),
  });
}

/**
 * Prices change at most every 15 minutes, so stock data stays fresh for 5 and is kept for 30:
 * switching ranges (or assets) back and forth reuses what was loaded instead of asking the API again.
 */
const STOCK_CACHE = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 };

/** The account's assets (symbol list order) with what the market-data source says about them. */
export function useStockAssets() {
  return useQuery({ queryKey: qk.assets, queryFn: () => api<StockAssetsResponse>('stock/assets'), select: (d) => d.items });
}

export function useAddAsset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (symbol: string) => api<StockAssetsResponse>('stock/assets', { method: 'POST', body: { symbol } }),
    onSuccess: (data) => client.setQueryData(qk.assets, data),
    onSettled: () => client.invalidateQueries({ queryKey: qk.settings }),
  });
}

export function useRemoveAsset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (symbol: string) => api<StockAssetsResponse>(`stock/assets/${encodeURIComponent(symbol)}`, { method: 'DELETE' }),
    onSuccess: (data) => client.setQueryData(qk.assets, data),
    onSettled: () => client.invalidateQueries({ queryKey: qk.settings }),
  });
}

export function useStock(symbol: string | null, range: StockRange) {
  return useQuery({
    queryKey: qk.stock(symbol ?? '', range),
    queryFn: () => api<StockHistoryResponse>('stock/history', { query: { symbol: symbol!, range } }),
    enabled: Boolean(symbol),
    ...STOCK_CACHE,
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });
}

/**
 * CSV downloads, independent of the chart's range: every stored daily bar, or the intraday bars
 * the market-data source still has (the API fetches those when asked).
 */
export function useStockExport() {
  return useMutation({
    mutationFn: ({ symbol, interval }: { symbol: string; interval: StockExportInterval }) =>
      api<StockExportResponse>('stock/export', { query: { symbol, interval } }),
  });
}

/** Unusual-volume days of an asset from `from` (a trading date: the chart's first day) to today. */
export function useAnomalies(symbol: string | null, from: string | null) {
  return useQuery({
    queryKey: qk.anomalies(symbol ?? '', from ?? ''),
    queryFn: () => api<{ items: VolumeAnomaly[]; minRatio: number; window: number }>('stock/anomalies', { query: { symbol: symbol!, from: from! } }),
    enabled: Boolean(symbol && from),
    ...STOCK_CACHE,
    placeholderData: keepPreviousData,
    refetchInterval: 10 * 60_000,
  });
}

export function useFeedbackStats() {
  return useQuery({ queryKey: qk.feedbackStats, queryFn: () => api<FeedbackStats>('feedback/stats') });
}

export function useResyncStock() {
  return useMutation({ mutationFn: (symbol: string) => api<{ started: boolean }>('stock/resync', { method: 'POST', body: { symbol } }) });
}

export function useTelegramLink() {
  return useMutation({ mutationFn: () => api<TelegramLinkStartResponse>('telegram/link', { method: 'POST' }) });
}

export function useTelegramVerify() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api<TelegramLinkVerifyResponse>('telegram/link/verify', { method: 'POST', body: { code } }),
    onSuccess: (res) => {
      if (res.linked) void client.invalidateQueries({ queryKey: qk.settings });
    },
  });
}

export function useTelegramUnlink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('telegram/link', { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: qk.settings }),
  });
}

export function useTelegramTest() {
  return useMutation({ mutationFn: () => api<{ sent: boolean }>('telegram/test', { method: 'POST' }) });
}

export function useConversations() {
  return useQuery({
    queryKey: qk.conversations,
    queryFn: () => api<{ items: Conversation[] }>('chat/conversations'),
    select: (d) => d.items,
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: qk.conversation(id ?? ''),
    queryFn: () => api<{ conversation: Conversation; messages: UIMessage[] }>(`chat/conversations/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    retry: false,
    staleTime: Infinity,
  });
}

export function useDeleteConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: qk.conversations }),
  });
}
