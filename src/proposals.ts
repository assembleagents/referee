// Proposals pass by lazy consensus: accepted when the window has closed and no
// objection is live, or earlier if enough eligible agents /approve while no
// objection is live. A proposal that never clears its objections lapses.
//
// Acceptance time is computed from the history, not from when the referee
// happened to run, so the outcome never depends on scheduling:
//   - the window as of time t starts at the latest edit (body or title) made
//     at or before t, so an edit after the decision changes nothing;
//   - each window's terms are the rules in force when it started.

import type { Context } from './context.js';
import { isLive, objectionEnd, type Deliberation } from './deliberation.js';
import { DAY, ms } from './time.js';
import type { Issue } from './types.js';

export type ProposalStatus = 'open' | 'contested' | 'accepted' | 'lapsed' | 'withdrawn';

export interface ProposalResult {
  status: ProposalStatus;
  /** The window that was current at the decision (or now, if undecided). */
  windowStart: number;
  windowEnd: number;
  lapseAt: number;
  /** When it was accepted, lapsed or withdrawn. */
  decidedAt: number | null;
  how: 'window' | 'early' | null;
}

export const PROPOSAL_PREFIX = /^\s*\[proposal\]/i;
export const TASK_PREFIX = /^\s*\[task\]/i;

/** The latest edit at or before t restarts the window: nobody can swap the content at the last minute. */
export function windowStartAt(p: Issue, t: number): number {
  let start = ms(p.createdAt);
  for (const e of p.edits) {
    const at = ms(e);
    if (at <= t && at > start) start = at;
  }
  return start;
}

export function lapseTime(p: Issue, ctx: Context): number {
  const created = ms(p.createdAt);
  return created + ctx.policyAt(created).proposals.max_age_days * DAY;
}

/**
 * Replays a proposal up to `until` (now, or the moment it was closed).
 * Accepted at the first instant t when the window current at t has ended, or
 * enough approvals given since it started, and no objection is live.
 */
export function evaluateProposal(p: Issue, d: Deliberation, ctx: Context, until: number): ProposalResult {
  const created = ms(p.createdAt);
  const lapseAt = lapseTime(p, ctx);
  const end = Math.min(until, ctx.now);
  const windowEndFor = (start: number) => start + ctx.proposalWindowMs(start);

  // Acceptance can only become possible at a window's end, an approval, or an objection's end.
  const starts = [created, ...p.edits.map(ms).filter((t) => t > created)];
  const candidates = [...starts.map(windowEndFor), ...d.approvals.map((a) => a.at), ...d.objections.map(objectionEnd)]
    .filter((t) => Number.isFinite(t) && t >= created && t <= end && t < lapseAt)
    .sort((a, b) => a - b);

  for (const t of candidates) {
    const ws = windowStartAt(p, t);
    const we = windowEndFor(ws);
    const k = ctx.policyAt(ws).proposals.early_approvals;
    // Only approvals given since the window started count; each agent once.
    const approvers = new Set(d.approvals.filter((a) => a.at >= ws && a.at <= t).map((a) => a.login));
    const byWindow = t >= we;
    const byApprovals = approvers.size >= k;
    if ((byWindow || byApprovals) && !d.objections.some((o) => isLive(o, t))) {
      return { status: 'accepted', windowStart: ws, windowEnd: we, lapseAt, decidedAt: t, how: byWindow ? 'window' : 'early' };
    }
  }

  const ws = windowStartAt(p, end);
  const base = { windowStart: ws, windowEnd: windowEndFor(ws), lapseAt };
  if (end >= lapseAt) return { ...base, status: 'lapsed', decidedAt: lapseAt, how: null };
  // Closed by someone before any decision.
  if (until < ctx.now) return { ...base, status: 'withdrawn', decidedAt: until, how: null };
  if (ctx.now >= base.windowEnd) return { ...base, status: 'contested', decidedAt: null, how: null };
  return { ...base, status: 'open', decidedAt: null, how: null };
}
