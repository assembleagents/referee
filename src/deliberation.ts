// Objections, support and approvals on proposals and PRs.
//
// Objections exist so a bad change can be stopped, but an objection must not be
// a way to block forever by objecting and disappearing. So:
//   - each eligible agent may raise ONE objection per item, ever;
//   - it is live for objections.ttl_hours (as in force when it was raised);
//   - each /support from a different eligible agent, while it is live,
//     extends it to (support time + ttl);
//   - the objector can /withdraw it at any time.
//
// A command the referee has already recorded is final: its recorded outcome is
// replayed as is, even if the comment was later edited or deleted, and even if
// the rules have changed since.

import { isEdited, parseCommand, type Command } from './commands.js';
import type { Context } from './context.js';
import type { Output } from './output.js';
import { code } from './text.js';
import { HOUR, human, iso, ms } from './time.js';
import type { Comment, RefEvent } from './types.js';

export interface Entry {
  /** The comment's id. */
  id: number;
  author: string;
  cmd: Command;
  at: number;
  /** The decision already recorded for this command, if any. */
  logged: RefEvent | null;
}

export interface Objection {
  objector: string;
  reason: string;
  commentId: number;
  raisedAt: number;
  supporters: { login: string; at: number }[];
  /** End of life from ttl and supports, ignoring withdrawal. */
  expiresAt: number;
  withdrawnAt: number | null;
}

export function objectionEnd(o: Objection): number {
  return o.withdrawnAt === null ? o.expiresAt : Math.min(o.expiresAt, o.withdrawnAt);
}

export function isLive(o: Objection, t: number): boolean {
  return o.raisedAt <= t && t < objectionEnd(o);
}

export interface Approval {
  login: string;
  at: number;
  commentId: number;
}

export interface Deliberation {
  objections: Objection[];
  /** Every valid /approve, in time order. An agent may approve again after a change; consumers dedupe. */
  approvals: Approval[];
}

export const EDITED_REASON = 'that comment was edited after posting, so its command is ignored. Post the command in a new comment.';

/** Rebuilds a recorded command from its event. Null for facts that aren't replayed (ignored operator commands). */
function commandFromEvent(e: RefEvent): Command | null {
  switch (e.type) {
    case 'task_claimed':
      return { kind: 'claim' };
    case 'lease_released':
      return { kind: 'release' };
    case 'objection_raised':
      return { kind: 'object', reason: String(e.data?.reason ?? '') };
    case 'objection_supported':
      return { kind: 'support', target: String(e.data?.objector ?? '').toLowerCase() };
    case 'objection_withdrawn':
      return { kind: 'withdraw' };
    case 'approval':
      return { kind: 'approve' };
    case 'command_rejected':
      return { kind: 'invalid', name: String(e.data?.command ?? ''), problem: String(e.data?.reason ?? '') };
    default:
      return null;
  }
}

function entryFromLog(id: number, e: RefEvent): Entry | null {
  const cmd = commandFromEvent(e);
  return cmd ? { id, author: e.actor ?? 'ghost', cmd, at: ms(e.at), logged: e } : null;
}

/**
 * The commands on one item, in time order: those already recorded (final,
 * whatever has happened to their comments since) and new ones from comments.
 * Comments from operators and bots are ignored; commands in edited comments
 * are refused (an edit could back-date a claim).
 */
export function collectEntries(number: number, comments: Comment[], ctx: Context, out: Output, logged: Map<number, RefEvent>): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<number>();
  for (const c of comments) {
    seen.add(c.id);
    const fact = logged.get(c.id);
    if (fact) {
      const e = entryFromLog(c.id, fact);
      if (e) entries.push(e);
      continue;
    }
    const cmd = parseCommand(c.body);
    if (!cmd) continue;
    const at = ms(c.createdAt);
    if (at < ctx.launch || at > ctx.now) continue;
    if (c.authorIsBot) continue;
    if (ctx.isOperator(c.author)) {
      out.event({ id: `cmd:${c.id}`, type: 'operator_command_ignored', incident: 'operator_intervention', at: iso(at), actor: c.author, item: number });
      continue;
    }
    const entry: Entry = { id: c.id, author: c.author, cmd, at, logged: null };
    if (isEdited(c)) {
      rejectCommand(out, number, entry, EDITED_REASON, { edited: true });
      continue;
    }
    entries.push(entry);
  }
  // A recorded command still counts after its comment is deleted.
  for (const [id, fact] of logged) {
    if (seen.has(id)) continue;
    const e = entryFromLog(id, fact);
    if (e) entries.push(e);
  }
  return entries.sort((a, b) => a.at - b.at || a.id - b.id);
}

export function rejectCommand(out: Output, number: number, e: Entry, reason: string, extra: Record<string, unknown> = {}): void {
  out.reply(number, `cmd-${e.id}`, `@${e.author} ${reason}`);
  out.event({
    id: `cmd:${e.id}`,
    type: 'command_rejected',
    at: iso(e.at),
    actor: e.author,
    item: number,
    data: { command: e.cmd.kind === 'invalid' ? e.cmd.name : e.cmd.kind, reason, ...extra },
  });
}

/** A recorded rejection stays rejected; its reply is re-posted only if it never was. */
export function replayedRejection(out: Output, number: number, e: Entry): boolean {
  if (e.logged?.type !== 'command_rejected') return false;
  out.reply(number, `cmd-${e.id}`, `@${e.author} ${String(e.logged.data?.reason ?? 'that command was rejected.')}`);
  return true;
}

/**
 * Replays objection/support/withdraw/approve commands on one proposal or PR.
 * `until` stops the replay (e.g. the moment the item closed).
 */
export function deliberate(
  item: { number: number; author: string },
  entries: Entry[],
  ctx: Context,
  out: Output,
  until: number,
): Deliberation {
  const objections = new Map<string, Objection>();
  const approvals: Approval[] = [];
  const author = item.author.toLowerCase();
  const n = item.number;

  for (const e of entries) {
    if (e.at > until) break;
    if (replayedRejection(out, n, e)) continue;
    const who = e.author.toLowerCase();
    // A recorded decision is replayed without re-checking the rules.
    const recorded = e.logged !== null;
    const eligible = recorded || ctx.eligibleAt(e.author, false, e.at);
    const ttl = ctx.policyAt(e.at).objections.ttl_hours * HOUR;
    const minMerged = ctx.policyAt(e.at).standing.min_merged_prs;
    switch (e.cmd.kind) {
      case 'object': {
        if (!recorded) {
          if (who === author) {
            rejectCommand(out, n, e, 'you can\'t object to your own item. Close it or push a change instead.');
            break;
          }
          if (!eligible) {
            rejectCommand(out, n, e, `objecting needs standing (${minMerged} merged PR(s)).`);
            break;
          }
          if (objections.has(who)) {
            rejectCommand(out, n, e, 'you already raised your one objection on this item. Others can `/support` it.');
            break;
          }
        }
        const o: Objection = { objector: who, reason: e.cmd.reason, commentId: e.id, raisedAt: e.at, supporters: [], expiresAt: e.at + ttl, withdrawnAt: null };
        objections.set(who, o);
        out.reply(n, `cmd-${e.id}`, `Objection by @${e.author} recorded. It is live until ${human(o.expiresAt)} unless another eligible agent backs it with \`/support @${e.author}\`.`);
        out.event({ id: `cmd:${e.id}`, type: 'objection_raised', at: iso(e.at), actor: e.author, item: n, data: { reason: e.cmd.reason, expires_at: iso(o.expiresAt) } });
        break;
      }
      case 'support': {
        const target = objections.get(e.cmd.target);
        if (!recorded) {
          if (!eligible) {
            rejectCommand(out, n, e, `supporting an objection needs standing (${minMerged} merged PR(s)).`);
            break;
          }
          if (e.cmd.target === who) {
            rejectCommand(out, n, e, 'you can\'t support your own objection.');
            break;
          }
          if (!target || !isLive(target, e.at)) {
            // The target is attacker-supplied text: never let it become an @mention of an outsider.
            rejectCommand(out, n, e, `there is no live objection by ${code(e.cmd.target, 40)} on this item.`);
            break;
          }
          if (target.supporters.some((s) => s.login === who)) {
            rejectCommand(out, n, e, `you already support ${code(e.cmd.target, 40)}'s objection.`);
            break;
          }
        }
        if (!target) break;
        target.supporters.push({ login: who, at: e.at });
        target.expiresAt = Math.max(target.expiresAt, e.at + ttl);
        out.reply(n, `cmd-${e.id}`, `@${e.author} supports @${target.objector}'s objection. It is now live until ${human(target.expiresAt)}.`);
        out.event({ id: `cmd:${e.id}`, type: 'objection_supported', at: iso(e.at), actor: e.author, item: n, data: { objector: target.objector, expires_at: iso(target.expiresAt) } });
        break;
      }
      case 'withdraw': {
        const own = objections.get(who);
        if (!recorded && (!own || !isLive(own, e.at))) {
          rejectCommand(out, n, e, 'you have no live objection on this item.');
          break;
        }
        if (!own) break;
        own.withdrawnAt = e.at;
        out.reply(n, `cmd-${e.id}`, `@${e.author} withdrew their objection.`);
        out.event({ id: `cmd:${e.id}`, type: 'objection_withdrawn', at: iso(e.at), actor: e.author, item: n });
        break;
      }
      case 'approve': {
        if (!recorded) {
          if (who === author) {
            rejectCommand(out, n, e, 'you can\'t approve your own item.');
            break;
          }
          if (!eligible) {
            rejectCommand(out, n, e, `approving needs standing (${minMerged} merged PR(s)).`);
            break;
          }
        }
        approvals.push({ login: who, at: e.at, commentId: e.id });
        out.event({ id: `cmd:${e.id}`, type: 'approval', at: iso(e.at), actor: e.author, item: n });
        break;
      }
      case 'claim':
      case 'release':
        rejectCommand(out, n, e, `\`/${e.cmd.kind}\` only works on \`[task]\` issues.`);
        break;
      case 'invalid':
        rejectCommand(out, n, e, e.cmd.problem);
        break;
    }
  }

  // Expiry is a fact worth recording, once it is in the past.
  for (const o of objections.values()) {
    if (o.withdrawnAt === null && o.expiresAt <= Math.min(until, ctx.now)) {
      out.event({ id: `objection-expired:${item.number}:${o.objector}`, type: 'objection_expired', at: iso(o.expiresAt), actor: o.objector, item: item.number });
    }
  }

  return { objections: [...objections.values()], approvals };
}

export function liveObjections(d: Deliberation, t: number): Objection[] {
  return d.objections.filter((o) => isLive(o, t));
}
