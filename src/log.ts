// The event log as the engine reads it. GitHub's state is mutable: comments
// can be edited or deleted, bodies rewritten, issues reopened, PRs closed. So
// a fact the referee has already recorded is final, and the engine looks here
// first before deciding anything again.

import { ms } from './time.js';
import type { RefEvent } from './types.js';

/** A push to an open PR (or its opening), with the tasks its body said it closes at the time. */
export interface Push {
  pull: number;
  at: number;
  actor: string;
  sha: string | null;
  suite: number | null;
  closes: number[];
}

const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x)) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function pushFromEvent(e: RefEvent): Push | null {
  if ((e.type !== 'pr_pushed' && e.type !== 'pr_opened') || e.item === null) return null;
  return {
    pull: e.item,
    at: ms(e.at),
    actor: (e.actor ?? '').toLowerCase(),
    sha: str(e.data?.sha),
    suite: num(e.data?.suite),
    closes: numbers(e.data?.closes),
  };
}

export class EventLog {
  readonly ids = new Set<string>();
  /** Every event type recorded so far. */
  readonly types = new Set<string>();
  private readonly byId = new Map<string, RefEvent>();
  private readonly commandsByItem = new Map<number, RefEvent[]>();
  private readonly closesByMergedPull = new Map<number, number[]>();
  private readonly mergeFailureCount = new Map<string, number>();
  /** Pushes and PR openings already recorded. */
  readonly pushes: Push[] = [];
  /** Shas on main the referee has already classified (merged, intervention, launch anchor). */
  readonly mainShas = new Set<string>();
  /** The newest recorded `pr_pushed`, so only CI runs after it need fetching. */
  readonly latestPushAt: number | null = null;

  constructor(events: RefEvent[]) {
    let latest: number | null = null;
    for (const e of events) {
      if (this.ids.has(e.id)) continue;
      this.ids.add(e.id);
      this.types.add(e.type);
      this.byId.set(e.id, e);
      if (e.id.startsWith('cmd:') && e.item !== null) {
        const list = this.commandsByItem.get(e.item) ?? [];
        list.push(e);
        this.commandsByItem.set(e.item, list);
      }
      const push = pushFromEvent(e);
      if (push) {
        this.pushes.push(push);
        if (e.type === 'pr_pushed' && push.at > (latest ?? -Infinity)) latest = push.at;
      }
      if (e.type === 'pr_merged' && e.item !== null && Array.isArray(e.data?.closes)) this.closesByMergedPull.set(e.item, numbers(e.data?.closes));
      if (e.type === 'merge_failed' && e.item !== null) {
        const key = `${e.item}:${String(e.data?.head)}`;
        this.mergeFailureCount.set(key, (this.mergeFailureCount.get(key) ?? 0) + 1);
      }
      const main = /^(?:merge|intervention|main-anchor):([A-Za-z0-9]+)$/.exec(e.id);
      if (main?.[1]) this.mainShas.add(main[1]);
    }
    this.latestPushAt = latest;
  }

  get(id: string): RefEvent | undefined {
    return this.byId.get(id);
  }

  /** Command facts recorded for an item, keyed by comment id. */
  commands(item: number): Map<number, RefEvent> {
    const out = new Map<number, RefEvent>();
    for (const e of this.commandsByItem.get(item) ?? []) out.set(Number(e.id.slice('cmd:'.length)), e);
    return out;
  }

  /** What an issue was first recorded as. Retitling it later doesn't change what it is. */
  kind(item: number): 'proposal' | 'task' | null {
    if (this.byId.has(`proposal-opened:${item}`)) return 'proposal';
    if (this.byId.has(`task-opened:${item}`)) return 'task';
    return null;
  }

  /** A proposal's recorded outcome, if any. */
  proposalDecision(item: number): RefEvent | undefined {
    return this.byId.get(`proposal-accepted:${item}`) ?? this.byId.get(`proposal-lapsed:${item}`) ?? this.byId.get(`proposal-withdrawn:${item}`);
  }

  /** How a lease ended, if that is recorded. */
  leaseEnd(task: number, claimCommentId: number): { at: number; reason: 'expired' | 'closed' | 'done' } | null {
    const expired = this.byId.get(`lease-expired:${task}:${claimCommentId}`);
    if (expired) return { at: ms(expired.at), reason: 'expired' };
    const ended = this.byId.get(`lease-ended:${task}:${claimCommentId}`);
    if (ended) return { at: ms(ended.at), reason: ended.data?.reason === 'done' ? 'done' : 'closed' };
    return null;
  }

  genesisEnd(): number | null {
    const e = this.byId.get('genesis-ended');
    return e ? ms(e.at) : null;
  }

  /** The tasks a merged PR said it closed, as recorded when the referee merged it. */
  mergedCloses(pull: number): number[] | null {
    return this.closesByMergedPull.get(pull) ?? null;
  }

  /** Failed merge attempts recorded for a PR at a given head. */
  mergeFailures(pull: number, head: string): number {
    return this.mergeFailureCount.get(`${pull}:${head}`) ?? 0;
  }
}
