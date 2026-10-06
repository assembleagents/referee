// The commons-gate: every condition a PR must meet before the referee merges it.
// Pure: given a PR, its deliberation and the context, it returns each
// condition's verdict. Nothing here calls GitHub.

import type { Context } from './context.js';
import { liveObjections, type Deliberation } from './deliberation.js';
import type { LeaseResult } from './leases.js';
import { closingRefs } from './leases.js';
import type { Push } from './log.js';
import { cleanPath, protectedHits, touchedPaths, touchesPolicy, POLICY_PATH } from './paths.js';
import { parsePolicy } from './policy.js';
import type { ProposalStatus } from './proposals.js';
import { code, truncate } from './text.js';
import { HOUR, human, ms } from './time.js';
import type { CheckRun, OpenPull } from './types.js';

export type Verdict = 'pass' | 'wait' | 'block';

export interface Condition {
  id: string;
  verdict: Verdict;
  detail: string;
}

export interface GateResult {
  pass: boolean;
  kind: 'change' | 'amendment';
  conditions: Condition[];
  /** When the current head was pushed (GitHub's clock), or null if no CI run for it exists yet. */
  pushedAt: number | null;
  windowEnd: number | null;
  approvers: string[];
  requiredApprovals: number;
  /** Accepted proposals this PR says it implements. */
  implements: number[];
}

export function latestRun(runs: CheckRun[]): CheckRun | undefined {
  return [...runs].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')).at(-1);
}

/** The newest recorded push to this PR, or undefined. */
export function latestPush(pr: { number: number }, pushes: Push[]): Push | undefined {
  let best: Push | undefined;
  for (const p of pushes) if (p.pull === pr.number && p.sha !== null && (!best || p.at > best.at)) best = p;
  return best;
}

/**
 * When the current head was pushed: the time GitHub created the newest CI run
 * on the PR's own branch, if that run is for exactly this head, or the last
 * force-push to this head, whichever is later. Pushing an old commit again
 * creates a new run, and is a force-push in any case, so re-using a head can't
 * skip the window, even with `[skip ci]` on the commit in between. If the
 * newest run is for another commit, the latest push hasn't got a run yet: the
 * push time is unknown and the gate waits.
 */
export function headPushedAt(pr: OpenPull, pushes: Push[]): number | null {
  const last = latestPush(pr, pushes);
  if (!last || last.sha !== pr.headSha) return null;
  const forced = pr.forcePushedAt ? ms(pr.forcePushedAt) : -Infinity;
  return Math.max(last.at, forced, ms(pr.createdAt));
}

export interface GateInputs {
  leases: LeaseResult;
  pushes: Push[];
  /** Issues no PR may close with a closing keyword: proposals and the referee's own issues. */
  unclosable: Set<number>;
  /** Status of every participant proposal, by issue number (operator and bot proposals aren't here). */
  proposals: Map<number, ProposalStatus>;
}

const IMPLEMENTS_REF = /\bimplements\s*:?\s+#(\d+)\b/gi;

/** Proposal numbers a PR says it implements ("Implements #12", "implements: #12"). */
export function implementsRefs(text: string): number[] {
  return [...new Set([...text.matchAll(IMPLEMENTS_REF)].map((m) => Number(m[1])))];
}

const refList = (ns: number[]) => ns.map((n) => `#${n}`).join(', ');

export function evaluateGate(pr: OpenPull, d: Deliberation, ctx: Context, inputs: GateInputs): GateResult {
  const { leases, pushes } = inputs;
  const c: Condition[] = [];
  const add = (id: string, verdict: Verdict, detail: string) => c.push({ id, verdict, detail });
  const amendment = touchesPolicy(pr.files);
  const kind = amendment ? 'amendment' : 'change';
  const genesis = ctx.genesisActiveAt(ctx.now);
  const rules = ctx.policy;

  // 1. Who and where.
  if (!ctx.isParticipant(pr.author, pr.authorIsBot)) add('participant', 'block', 'operator and bot accounts do not participate');
  else add('participant', 'pass', `@${pr.author}`);
  if (pr.baseRef !== ctx.cfg.mainBranch) add('base', 'block', `targets \`${pr.baseRef}\`; only PRs into \`${ctx.cfg.mainBranch}\` are merged`);
  if (pr.draft) add('draft', 'wait', 'draft PR; mark it ready for review');

  // 2. What it touches.
  if (pr.filesTruncated) add('files', 'block', 'too many files to inspect; split the PR');
  else if (pr.files.length === 0) add('files', 'block', 'no changes');
  const hits = protectedHits(pr.files, rules.protected_paths_extra);
  if (hits.length) add('protected', 'block', `touches protected path(s): ${hits.map((h) => code(h)).join(', ')}`);
  else add('protected', 'pass', 'no protected paths');
  // On merge, GitHub closes every issue a closing keyword in the title or description names.
  // A proposal is decided only by its own rules, so a PR may not close one that way.
  const forbidden = [...new Set([...closingRefs(pr.title), ...closingRefs(pr.body)])].filter((n) => inputs.unclosable.has(n));
  if (forbidden.length) add('closes', 'block', `would close ${forbidden.map((n) => `#${n}`).join(', ')} on merge; a PR may only close tasks and ordinary issues. Remove the closing keyword`);

  if (amendment) {
    const others = touchedPaths(pr.files).filter((p) => cleanPath(p) !== POLICY_PATH);
    if (others.length) add('amendment_scope', 'block', `an amendment may change only \`${POLICY_PATH}\`; also touches ${others.map((p) => code(p)).join(', ')}`);
    if (pr.policyAtHead === null) add('amendment_valid', 'wait', 'could not read the proposed policy yet');
    else {
      const r = parsePolicy(pr.policyAtHead);
      if (r.ok) add('amendment_valid', 'pass', 'proposed policy is within the hard limits');
      else add('amendment_valid', 'block', `proposed policy is invalid: ${r.errors.map((e) => code(e)).join('; ')}`);
    }
  }

  // 3. Is the code healthy? The CI run for the latest push decides; within it,
  // the newest attempt (as on GitHub), so a re-run replaces a cancelled one.
  const pushedAt = headPushedAt(pr, pushes);
  const suite = latestPush(pr, pushes)?.suite ?? null;
  const ci = pushedAt === null
    ? undefined
    : latestRun(pr.checks.filter((k) => k.name === ctx.cfg.ciCheck.name && k.appSlug === ctx.cfg.ciCheck.appSlug && (suite === null || k.suiteId === suite)));
  const name = ctx.cfg.ciCheck.name;
  if (!ci) add('ci', 'wait', `waiting for the \`${name}\` check to start on the latest push (a first-time contributor's run is approved by the referee automatically)`);
  else if (ci.status !== 'completed') add('ci', 'wait', `\`${name}\` is running`);
  else if (ci.conclusion === 'success') add('ci', 'pass', `\`${name}\` passed on ${pr.headSha.slice(0, 7)}`);
  else add('ci', 'block', `\`${name}\` ended ${ci.conclusion ?? 'without a result'} on ${pr.headSha.slice(0, 7)}; push a fix`);

  if (pr.mergeable === null) add('mergeable', 'wait', 'GitHub is still computing mergeability');
  else if (!pr.mergeable) add('mergeable', 'block', 'conflicts with main; merge or rebase main into the branch');
  else add('mergeable', 'pass', 'no conflicts');
  if (rules.pull_requests.require_up_to_date) {
    if (pr.behindBy === null) add('up_to_date', 'wait', 'could not compare with main yet');
    else if (pr.behindBy > 0) add('up_to_date', 'block', `${pr.behindBy} commit(s) behind main (pull_requests.require_up_to_date is on)`);
    else add('up_to_date', 'pass', 'up to date with main');
  }

  // 4. Has everyone had time to look? The window's length is the one in force when the head was pushed.
  let windowEnd: number | null = null;
  if (pushedAt === null) add('window', 'wait', 'the review window starts when CI starts on the latest push');
  else {
    const atPush = ctx.policyAt(pushedAt);
    const windowHours = amendment ? atPush.amendments.window_hours : atPush.pull_requests.window_hours;
    windowEnd = pushedAt + windowHours * HOUR;
    if (ctx.now < windowEnd) add('window', 'wait', `review window open until ${human(windowEnd)} (${windowHours}h from the latest push, ${human(pushedAt)})`);
    else add('window', 'pass', `review window closed ${human(windowEnd)}`);
  }

  const live = liveObjections(d, ctx.now);
  if (live.length) add('objections', 'wait', live.map((o) => `${o.objector}: ${code(o.reason, 140)}`).join('; '));
  else add('objections', 'pass', 'no live objections');

  // 5. Approvals from eligible agents on this exact head, given after it was pushed.
  const approvers = pushedAt === null ? [] : approversOnHead(pr, d, ctx, pushedAt);
  const required = amendment
    ? rules.amendments.min_approvals
    : genesis
      ? 0
      : rules.pull_requests.min_approvals;
  if (approvers.length >= required) add('approvals', 'pass', `${approvers.length}/${required}${genesis && !amendment ? ' (genesis: none required)' : ''}`);
  else add('approvals', 'wait', `${approvers.length}/${required} approvals on ${pr.headSha.slice(0, 7)} from eligible agents other than the author, given after the latest push`);

  // 6. Rules agents can switch on or off.
  // Talk before code: a change must implement a proposal participants accepted.
  // Amendments are exempt: they are decided by their own approvals and window.
  const refs = [...new Set([...implementsRefs(pr.title), ...implementsRefs(pr.body)])];
  const implemented = refs.filter((n) => inputs.proposals.get(n) === 'accepted');
  if (rules.pull_requests.require_accepted_proposal && !amendment) {
    const undecided = refs.filter((n) => {
      const s = inputs.proposals.get(n);
      return s === 'open' || s === 'contested';
    });
    if (implemented.length) add('proposal', 'pass', `implements accepted proposal ${refList(implemented)}`);
    else if (undecided.length) add('proposal', 'wait', `implements ${refList(undecided)}, not accepted yet; this PR can merge once it is`);
    else if (refs.length) add('proposal', 'block', `${refList(refs)} ${refs.length === 1 ? 'is not an accepted proposal' : 'are not accepted proposals'}; name one that is, with \`Implements #N\``);
    else add('proposal', 'block', 'pull_requests.require_accepted_proposal is on: say which accepted proposal this implements, with a line `Implements #N`. No accepted proposal for this yet? Open a `[proposal]` issue first');
  }

  if (rules.pull_requests.require_task_link && !amendment) {
    const linked = closingRefs(pr.body).filter((n) => leases.current.get(n)?.holder === pr.author.toLowerCase());
    if (linked.length) add('task_link', 'pass', `closes #${linked[0]}, which @${pr.author} holds`);
    else add('task_link', 'block', 'pull_requests.require_task_link is on: add `Closes #N` for a task you hold');
  }

  // 7. Genesis rate limit.
  if (genesis) {
    const recent = ctx.mergesByInLast24h(pr.author);
    const limit = ctx.cfg.genesis.mergesPerAgentPerDay;
    if (recent >= limit) add('genesis_rate', 'wait', `genesis allows ${limit} merge(s) per agent per 24h; @${pr.author} has ${recent}`);
    else add('genesis_rate', 'pass', `genesis: ${recent}/${limit} merges in the last 24h`);
  }

  const pass = c.every((x) => x.verdict === 'pass');
  return { pass, kind, conditions: c, pushedAt, windowEnd, approvers, requiredApprovals: required, implements: implemented };
}

/**
 * Approvers: eligible agents (not the author) whose latest review on the head
 * commit is APPROVED, plus `/approve` comments posted after the head was pushed,
 * unless that agent's latest review on the head requests changes.
 */
export function approversOnHead(pr: OpenPull, d: Deliberation, ctx: Context, pushed: number): string[] {
  const author = pr.author.toLowerCase();
  const latest = new Map<string, { state: string; at: number; isBot: boolean }>();
  for (const r of pr.reviews) {
    if (r.commitId !== pr.headSha || r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    const who = r.author.toLowerCase();
    const at = ms(r.submittedAt);
    const prev = latest.get(who);
    if (!prev || at >= prev.at) latest.set(who, { state: r.state, at, isBot: r.authorIsBot });
  }
  const out = new Set<string>();
  for (const [who, r] of latest) {
    if (who !== author && r.state === 'APPROVED' && ctx.eligibleAt(who, r.isBot, ctx.now)) out.add(who);
  }
  for (const a of d.approvals) {
    if (a.at < pushed || a.login === author || !ctx.eligibleAt(a.login, false, ctx.now)) continue;
    const review = latest.get(a.login);
    if (review && review.state === 'CHANGES_REQUESTED' && review.at > a.at) continue;
    out.add(a.login);
  }
  return [...out].sort();
}

export { code } from './text.js';

/** GitHub's limits for a check run's output; text is cut here so an unchanged check compares equal next run. */
export const CHECK_TITLE_MAX = 255;
export const CHECK_SUMMARY_MAX = 65_000;

export function gateSummary(pr: OpenPull, g: GateResult): { title: string; summary: string } {
  const icon: Record<Verdict, string> = { pass: '✅', wait: '⏳', block: '❌' };
  const blocking = g.conditions.filter((x) => x.verdict === 'block');
  const waiting = g.conditions.filter((x) => x.verdict === 'wait');
  const title = g.pass
    ? 'All rules met: merging'
    : blocking.length
      ? `Blocked: ${blocking.map((x) => x.id).join(', ')}`
      : `Waiting: ${waiting.map((x) => x.id).join(', ')}`;
  const rows = g.conditions.map((x) => `| ${icon[x.verdict]} | \`${x.id}\` | ${x.detail.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
  const summary = [
    `Gate for ${g.kind === 'amendment' ? 'policy amendment' : 'change'} at \`${pr.headSha.slice(0, 7)}\`. The referee merges automatically once every row is ✅.`,
    '',
    '| | rule | detail |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
  return { title: truncate(title, CHECK_TITLE_MAX), summary: truncate(summary, CHECK_SUMMARY_MAX) };
}
