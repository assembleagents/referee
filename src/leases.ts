// Task leases. A `/claim` grants a lease for leases.hours (as in force at the
// claim). Each push to a PR by the holder that closes the task extends it from
// that moment. A lease ends on `/release`, when the task closes, when a PR that
// closes it merges ("done"), or when it expires; expiry is logged as an
// abandoned-work incident.
//
// Activity is the recorded push history (GitHub's own timestamps of CI runs),
// never commit dates, which authors control. Every lease end is recorded, and
// a recorded end is final: later edits, closed PRs or late runs can't move it.
//
// All claims across all tasks are replayed in one global time order, because
// leases.max_active_per_agent couples tasks together. The first valid /claim
// wins; there is no race, however late the referee runs.

import type { Context } from './context.js';
import { rejectCommand, replayedRejection, type Entry } from './deliberation.js';
import type { EventLog, Push } from './log.js';
import type { Output } from './output.js';
import { HOUR, human, iso, ms } from './time.js';
import type { Issue } from './types.js';

// Written so that no input makes them backtrack quadratically: bodies are
// participant-controlled and up to 64 KB long.
const CLOSING_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:[ \t]*:)?[ \t]+#(\d+)\b/gi;
const DEPENDS_ON = /^[ \t]*depends[ \t-]*on[ \t]*:[ \t]*(.+)$/gim;

/** Issue numbers a PR body says it closes ("Closes #12", "fixes #3"). */
export function closingRefs(body: string): number[] {
  return [...new Set([...body.matchAll(CLOSING_REF)].map((m) => Number(m[1])))];
}

/** Task numbers listed on "Depends-on: #1, #2" lines in the task body. */
export function dependsOn(body: string): number[] {
  const out = new Set<number>();
  for (const line of body.matchAll(DEPENDS_ON)) for (const ref of (line[1] ?? '').matchAll(/#(\d+)/g)) out.add(Number(ref[1]));
  return [...out];
}

export type LeaseEndReason = 'released' | 'closed' | 'done' | 'expired';

export interface Lease {
  task: number;
  holder: string;
  holderDisplay: string;
  claimedAt: number;
  commentId: number;
  /** leases.hours in force at the claim: a lease's terms are fixed when it is granted. */
  hours: number;
  /** Final end: release, task close, done or expiry. */
  endedAt: number | null;
  endReason: LeaseEndReason | null;
  /** Expiry as of now (extended by linked PR activity, capped). */
  expiresAt: number;
}

export interface LeaseResult {
  /** Live lease per task number. */
  current: Map<number, Lease>;
  all: Lease[];
  /** Tasks verified done (closed by a merged PR), with the first such merge time. */
  verified: Map<number, number>;
}

/**
 * Hard cap (Tier 1): however much a holder pushes, one lease never lasts more
 * than this many lease periods. Stops a task being held forever with empty
 * commits. The holder's PR can still merge after the lease ends; only the
 * exclusive claim lapses.
 */
export const MAX_LEASE_PERIODS = 4;

/** Expiry of a lease claimed at `claimedAt`, extended by activity before each successive deadline, capped. */
export function leaseExpiry(claimedAt: number, hours: number, activity: number[]): number {
  const cap = claimedAt + MAX_LEASE_PERIODS * hours * HOUR;
  let end = claimedAt + hours * HOUR;
  for (const a of [...activity].sort((x, y) => x - y)) {
    if (a <= claimedAt) continue;
    if (a >= end) break;
    end = Math.max(end, a + hours * HOUR);
  }
  return Math.min(end, cap);
}

/** Pushes (and PR openings) by the holder on PRs that said they close the task. */
function activityTimes(task: number, holder: string, pushes: Push[]): number[] {
  return pushes.filter((p) => p.actor === holder && p.closes.includes(task)).map((p) => p.at);
}

export function replayLeases(
  tasks: Issue[],
  entriesByTask: Map<number, Entry[]>,
  pushes: Push[],
  /** Every merge time of a PR that closed each task, oldest first. */
  verifications: Map<number, number[]>,
  log: EventLog,
  ctx: Context,
  out: Output,
): LeaseResult {
  const taskByNumber = new Map(tasks.map((t) => [t.number, t]));
  const verified = new Map<number, number>();
  for (const [task, times] of verifications) if (times.length) verified.set(task, times[0]!);

  const all: Lease[] = [];
  const active = new Map<number, Lease>();
  const lastExpiry = new Map<string, number>(); // `${task}:${login}` -> when their lease expired

  const closedAt = (task: number): number => {
    const t = taskByNumber.get(task);
    return t && t.state === 'closed' && t.closedAt ? ms(t.closedAt) : Infinity;
  };

  /** How a lease ends unless released first: its recorded end, else the earliest of done, close and expiry. */
  const plannedEnd = (lease: Lease): { at: number; reason: LeaseEndReason } => {
    const recorded = log.leaseEnd(lease.task, lease.commentId);
    if (recorded) return recorded;
    const done = (verifications.get(lease.task) ?? []).find((t) => t > lease.claimedAt) ?? Infinity;
    const closed = closedAt(lease.task) > lease.claimedAt ? closedAt(lease.task) : Infinity;
    if (done <= closed && done <= lease.expiresAt) return { at: done, reason: 'done' };
    if (closed <= lease.expiresAt) return { at: closed, reason: 'closed' };
    return { at: lease.expiresAt, reason: 'expired' };
  };

  const finish = (lease: Lease, at: number, reason: LeaseEndReason) => {
    lease.endedAt = at;
    lease.endReason = reason;
    active.delete(lease.task);
    if (reason === 'expired') {
      lastExpiry.set(`${lease.task}:${lease.holder}`, at);
      out.event({
        id: `lease-expired:${lease.task}:${lease.commentId}`,
        type: 'lease_expired',
        incident: 'abandoned_work',
        at: iso(at),
        actor: lease.holderDisplay,
        item: lease.task,
        data: { claimed_at: iso(lease.claimedAt) },
      });
      const stillOpen = closedAt(lease.task) === Infinity;
      out.reply(
        lease.task,
        `lease-expired-${lease.commentId}`,
        `The lease held by @${lease.holderDisplay} expired at ${human(at)} with no push to a linked PR.${stillOpen ? ' This task is available again: comment `/claim` to take it.' : ''}`,
      );
    } else if (reason === 'closed' || reason === 'done') {
      out.event({ id: `lease-ended:${lease.task}:${lease.commentId}`, type: 'lease_ended', at: iso(at), actor: lease.holderDisplay, item: lease.task, data: { reason } });
    }
  };

  /** Ends every active lease whose end is at or before t. */
  const settle = (t: number) => {
    for (const lease of [...active.values()]) {
      const end = plannedEnd(lease);
      if (end.at <= t) finish(lease, end.at, end.reason);
    }
  };

  const entries = [...entriesByTask.entries()]
    .flatMap(([task, list]) => list.map((e) => ({ task, e })))
    .sort((a, b) => a.e.at - b.e.at || a.e.id - b.e.id);

  for (const { task, e } of entries) {
    settle(e.at);
    if (replayedRejection(out, task, e)) continue;
    const who = e.author.toLowerCase();
    const recorded = e.logged !== null;
    const issue = taskByNumber.get(task)!;
    const rules = ctx.policyAt(e.at).leases;
    switch (e.cmd.kind) {
      case 'claim': {
        const held = active.get(task);
        if (!recorded) {
          if (closedAt(task) <= e.at) {
            rejectCommand(out, task, e, 'this task is closed.');
            break;
          }
          if (held) {
            rejectCommand(out, task, e, held.holder === who
              ? `you already hold this task until ${human(held.expiresAt)}.`
              : `this task is held by @${held.holderDisplay} until ${human(held.expiresAt)} (later if they keep pushing to a linked PR).`);
            break;
          }
          if (ctx.policyAt(e.at).dependencies.enforce) {
            const blockers = dependsOn(issue.body).filter((d) => !(verified.has(d) && verified.get(d)! <= e.at));
            if (blockers.length) {
              rejectCommand(out, task, e, `this task depends on ${blockers.map((b) => `#${b}`).join(', ')}, which ${blockers.length === 1 ? 'is' : 'are'} not verified yet (closed by a merged PR).`);
              break;
            }
          }
          const expiredAt = lastExpiry.get(`${task}:${who}`);
          if (expiredAt !== undefined && e.at < expiredAt + rules.reclaim_cooldown_hours * HOUR) {
            rejectCommand(out, task, e, `your lease on this task expired at ${human(expiredAt)}; you can claim it again after ${human(expiredAt + rules.reclaim_cooldown_hours * HOUR)} (leases.reclaim_cooldown_hours).`);
            break;
          }
          const mine = [...active.values()].filter((l) => l.holder === who).length;
          if (mine >= rules.max_active_per_agent) {
            rejectCommand(out, task, e, `you already hold ${mine} task lease(s), the maximum (leases.max_active_per_agent = ${rules.max_active_per_agent}). Release or finish one first.`);
            break;
          }
        } else if (held) {
          // Can't happen with a consistent log; the recorded claim wins.
          active.delete(task);
        }
        const lease: Lease = {
          task,
          holder: who,
          holderDisplay: e.author,
          claimedAt: e.at,
          commentId: e.id,
          hours: rules.hours,
          endedAt: null,
          endReason: null,
          expiresAt: leaseExpiry(e.at, rules.hours, activityTimes(task, who, pushes)),
        };
        active.set(task, lease);
        all.push(lease);
        out.reply(task, `cmd-${e.id}`, `@${e.author} holds this task until ${human(e.at + rules.hours * HOUR)}. Open a PR with \`Closes #${task}\` in its description; each push to it extends the lease by ${rules.hours}h, up to ${MAX_LEASE_PERIODS * rules.hours}h in all. \`/release\` if you stop.`);
        out.event({ id: `cmd:${e.id}`, type: 'task_claimed', at: iso(e.at), actor: e.author, item: task, data: { expires_at: iso(e.at + rules.hours * HOUR), hours: rules.hours } });
        break;
      }
      case 'release': {
        const held = active.get(task);
        if (!held || held.holder !== who) {
          if (!recorded) rejectCommand(out, task, e, 'you don\'t hold this task.');
          break;
        }
        finish(held, e.at, 'released');
        out.reply(task, `cmd-${e.id}`, `@${e.author} released this task. It is available: comment \`/claim\` to take it.`);
        out.event({ id: `cmd:${e.id}`, type: 'lease_released', at: iso(e.at), actor: e.author, item: task });
        break;
      }
      case 'invalid':
        rejectCommand(out, task, e, e.cmd.problem);
        break;
      default:
        rejectCommand(out, task, e, `\`/${e.cmd.kind}\` works on \`[proposal]\` issues and PRs, not on tasks.`);
    }
  }
  settle(ctx.now);

  return { current: active, all, verified };
}
