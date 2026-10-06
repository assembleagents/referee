// Who may do what, and when. Everything here is a pure function of the merged
// PR history and the policy timeline, so it can be evaluated at any past
// instant: standing, genesis and the rules themselves are time-dependent, and
// the referee replays commands in time order.

import type { RefereeConfig } from './config.js';
import type { Policy, PolicyTimeline } from './policy.js';
import { DAY, HOUR, ms } from './time.js';
import type { MergedPull } from './types.js';

export interface Merge {
  author: string;
  at: number;
  number: number;
}

export class Context {
  readonly now: number;
  readonly launch: number;
  /** Merged PRs by participants (operators and bots excluded), oldest first. */
  readonly merges: Merge[];
  /** Instant genesis ended, or null while it is still active. */
  readonly genesisEndedAt: number | null;
  private readonly operators: Set<string>;

  constructor(
    readonly cfg: RefereeConfig,
    readonly timeline: PolicyTimeline,
    now: number,
    mergedPulls: MergedPull[],
    /** Genesis end already recorded in the event log. Recorded facts are final. */
    loggedGenesisEnd: number | null = null,
  ) {
    this.now = now;
    this.launch = ms(cfg.launchAt);
    this.operators = new Set(cfg.operators.map((o) => o.toLowerCase()));
    this.merges = mergedPulls
      .filter((p) => !p.authorIsBot && !this.isOperator(p.author))
      .map((p) => ({ author: p.author.toLowerCase(), at: ms(p.mergedAt), number: p.number }))
      .filter((m) => m.at >= this.launch && m.at <= now)
      .sort((a, b) => a.at - b.at || a.number - b.number);
    this.genesisEndedAt = loggedGenesisEnd ?? computeGenesisEnd(this.merges, cfg.genesis);
  }

  /** The rules in force now. */
  get policy(): Policy {
    return this.timeline.at(this.now);
  }

  /** The rules in force at t. */
  policyAt(t: number): Policy {
    return this.timeline.at(t);
  }

  isOperator(login: string): boolean {
    return this.operators.has(login.toLowerCase());
  }

  /** Operators and bots never participate. */
  isParticipant(login: string, isBot: boolean): boolean {
    return !isBot && !this.isOperator(login);
  }

  genesisActiveAt(t: number): boolean {
    return this.genesisEndedAt === null || t < this.genesisEndedAt;
  }

  mergedCountAt(login: string, t: number): number {
    const l = login.toLowerCase();
    return this.merges.filter((m) => m.author === l && m.at <= t).length;
  }

  hasStandingAt(login: string, t: number): boolean {
    return this.mergedCountAt(login, t) >= this.policyAt(t).standing.min_merged_prs;
  }

  /** May this account object, support, approve or review at time t? */
  eligibleAt(login: string, isBot: boolean, t: number): boolean {
    if (!this.isParticipant(login, isBot)) return false;
    return this.genesisActiveAt(t) || this.hasStandingAt(login, t);
  }

  /** Proposal window for a window starting at `windowStart`, under the rules in force then. */
  proposalWindowMs(windowStart: number): number {
    return this.cappedWindow(this.policyAt(windowStart).proposals.window_hours, windowStart);
  }

  /** During the launch fast-window period, proposal windows are capped. */
  cappedWindow(hours: number, start: number): number {
    const fastUntil = this.launch + this.cfg.bootstrap.fastWindowDays * DAY;
    const h = start < fastUntil ? Math.min(hours, this.cfg.bootstrap.fastWindowHours) : hours;
    return h * HOUR;
  }

  mergesByInLast24h(login: string): number {
    const l = login.toLowerCase();
    return this.merges.filter((m) => m.author === l && m.at > this.now - DAY).length;
  }

  contributorsWithStanding(): string[] {
    return [...new Set(this.merges.map((m) => m.author))].filter((a) => this.hasStandingAt(a, this.now));
  }
}

export function computeGenesisEnd(merges: Merge[], g: RefereeConfig['genesis']): number | null {
  const contributors = new Set<string>();
  let count = 0;
  for (const m of merges) {
    count += 1;
    contributors.add(m.author);
    if (count >= g.maxMerges || contributors.size >= g.untilContributors) return m.at;
  }
  return null;
}
