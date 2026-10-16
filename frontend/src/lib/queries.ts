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
  Digest,
  FeedbackStats,
  NewsListResponse,
  PendingCounts,
  ReviewRequest,
  Run,
  Sentiment,
  SettingsUpdate,
  SettingsView,
  StockHistoryResponse,
  StockMarker,
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
  stock: (range: StockRange) => ['stock', range] as const,
  markers: (from: string) => ['markers', from] as const,
  anomalies: (from: string) => ['anomalies', from] as const,
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
      void client.invalidateQueries({ queryKey: ['markers'] });
      void client.invalidateQueries({ queryKey: qk.feedbackStats });
    },
  });
}

export function useBulkReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkReviewRequest) =>
      api<{ updated: number; failed: { id: string; error: string }[] }>('news/bulk', { method: 'POST', body }),
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

export function useStock(range: StockRange) {
  return useQuery({
    queryKey: qk.stock(range),
    queryFn: () => api<StockHistoryResponse>('stock/history', { query: { range } }),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });
}

export function useStockMarkers(from: string | null) {
  return useQuery({
    queryKey: qk.markers(from ?? ''),
    queryFn: () => api<{ items: StockMarker[] }>('stock/markers', { query: { from: from! } }),
    select: (d) => d.items,
    enabled: Boolean(from),
  });
}

/** Unusual-volume days from `from` (a trading date: the chart's first day) to today. */
export function useAnomalies(from: string | null) {
  return useQuery({
    queryKey: qk.anomalies(from ?? ''),
    queryFn: () => api<{ items: VolumeAnomaly[]; minRatio: number; window: number }>('stock/anomalies', { query: { from: from! } }),
    enabled: Boolean(from),
    placeholderData: keepPreviousData,
    refetchInterval: 10 * 60_000,
  });
}

export function useFeedbackStats() {
  return useQuery({ queryKey: qk.feedbackStats, queryFn: () => api<FeedbackStats>('feedback/stats') });
}

export function useResyncStock() {
  return useMutation({ mutationFn: () => api<{ started: boolean }>('stock/resync', { method: 'POST' }) });
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
