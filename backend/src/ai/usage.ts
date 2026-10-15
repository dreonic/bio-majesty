import type { AiTask, UsageEntry } from '@bio-majesty/shared';
import type { LanguageModelUsage } from 'ai';

/** Accumulates token usage per task + model during a pipeline step. */
export class UsageCollector {
  private readonly entries = new Map<string, UsageEntry>();

  add(task: AiTask | 'embedding', model: string, usage: Partial<LanguageModelUsage> | undefined): void {
    const key = `${task}|${model}`;
    const entry = this.entries.get(key) ?? { task, model, calls: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls += 1;
    entry.inputTokens += usage?.inputTokens ?? 0;
    entry.outputTokens += usage?.outputTokens ?? 0;
    this.entries.set(key, entry);
  }

  toEntries(): UsageEntry[] {
    return [...this.entries.values()];
  }
}
