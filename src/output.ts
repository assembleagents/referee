// Collects what one referee run wants to do. Deduplicates against what already
// exists, so re-running on the same snapshot produces no new work: events are
// deduplicated by id against the log, replies by a hidden marker in comments.

import type { Action, Comment, RefEvent } from './types.js';

const MARKER = /<!-- referee:([A-Za-z0-9:._#-]+) -->/g;

export function marker(key: string): string {
  return `<!-- referee:${key} -->`;
}

export function commentKeys(comments: Comment[], botLogin: string): Set<string> {
  const keys = new Set<string>();
  const bot = botLogin.toLowerCase();
  for (const c of comments) {
    if (c.author.toLowerCase() !== bot) continue;
    for (const m of c.body.matchAll(MARKER)) if (m[1]) keys.add(m[1]);
  }
  return keys;
}

/**
 * Replies per run. A flood of junk commands can't make the referee spam or
 * hit GitHub's rate limits; the rest are posted on later runs (dedupe makes
 * that safe). Events are never capped, and neither are the replies that
 * announce a decision (accepted, lapsed), so a flood can't hide one.
 */
export const MAX_REPLIES_PER_RUN = 40;

export class Output {
  readonly actions: Action[] = [];
  readonly events: RefEvent[] = [];
  private readonly emitted = new Set<string>();
  private readonly replied = new Set<string>();
  private capped = 0;
  /** Replies held back by the per-run cap. */
  deferredReplies = 0;

  constructor(
    private readonly existingEventIds: Set<string>,
    /** Marker keys already present in the referee's comments, per item number. */
    private readonly existingKeys: Map<number, Set<string>>,
  ) {}

  event(e: RefEvent): void {
    if (this.existingEventIds.has(e.id) || this.emitted.has(e.id)) return;
    this.emitted.add(e.id);
    this.events.push(e);
  }

  /** Post a comment once per (item, key), ever. `essential` replies announce decisions and are never held back. */
  reply(number: number, key: string, text: string, essential = false): void {
    const k = `${number}/${key}`;
    if (this.replied.has(k) || this.existingKeys.get(number)?.has(key)) return;
    if (!essential && this.capped >= MAX_REPLIES_PER_RUN) {
      this.deferredReplies += 1;
      return;
    }
    this.replied.add(k);
    if (!essential) this.capped += 1;
    this.actions.push({ type: 'comment', number, key, body: `${text}\n\n${marker(key)}` });
  }

  /** True if this event is already in the log or was emitted this run. */
  has(id: string): boolean {
    return this.existingEventIds.has(id) || this.emitted.has(id);
  }

  action(a: Action): void {
    this.actions.push(a);
  }
}
