// The referee's brain, as a pure function: Snapshot in; Actions, Events and
// State out. Same snapshot, same result. Nothing here decides what is good;
// it only applies the rules in policy.yaml and the hard limits in this code.
//
// Three principles keep outcomes independent of when the referee happens to run:
//   - a fact already in the event log is final (GitHub's state is mutable);
//   - each rule is applied as it stood at the moment that matters;
//   - times come from GitHub's clock (comment, CI run, merge), never from
//     commit dates, which authors control.

import { createHash } from 'node:crypto';
import { parseCommand } from './commands.js';
import type { RefereeConfig } from './config.js';
import { Context } from './context.js';
import { collectEntries, deliberate, liveObjections, rejectCommand, replayedRejection, type Deliberation, type Entry } from './deliberation.js';
import { evaluateGate, gateSummary, latestRun, type GateInputs, type GateResult } from './gate.js';
import { closingRefs, dependsOn, replayLeases, type LeaseResult } from './leases.js';
import { EventLog, type Push } from './log.js';
import { commentKeys, Output } from './output.js';
import { protectedHits } from './paths.js';
import { buildPolicyTimeline, type PolicyTimeline } from './policy.js';
import { contentAt, evaluateProposal, PROPOSAL_PREFIX, sha256, TASK_PREFIX, windowStartAt, type ProposalResult, type ProposalStatus } from './proposals.js';
import { DAY, human, iso, ms } from './time.js';
import type { Action, Comment, Issue, OpenPull, RefEvent, Snapshot } from './types.js';

/** Labels the referee owns. It adds and removes only these; all others are left alone. */
export const MANAGED_LABELS: Record<string, { color: string; description: string }> = {
  proposal: { color: '1d76db', description: 'A proposal (lazy consensus)' },
  task: { color: '0e8a16', description: 'A task that can be claimed with /claim' },
  amendment: { color: '5319e7', description: 'A PR that changes policy.yaml' },
  accepted: { color: '0e8a16', description: 'Proposal accepted' },
  contested: { color: 'd93f0b', description: 'Window closed but an objection is live' },
  lapsed: { color: 'cccccc', description: 'Proposal expired without acceptance' },
  claimed: { color: 'fbca04', description: 'Task is held under a lease' },
  blocked: { color: 'b60205', description: 'Task depends on unverified tasks' },
  chronicle: { color: 'c5def5', description: 'Daily chronicle: facts from the referee, optional accounts from participants' },
};

/** Ready PRs offered for merging per run, in priority order. Only the first that succeeds merges. */
export const MAX_MERGE_ATTEMPTS = 3;

export interface Evaluation {
  actions: Action[];
  events: RefEvent[];
  state: Record<string, unknown>;
}

export function evaluate(snap: Snapshot, cfg: RefereeConfig): Evaluation {
  const now = ms(snap.now);
  const log = new EventLog(snap.log);
  const timeline = buildPolicyTimeline(snap.policyHistory, ms(cfg.launchAt));
  const ctx = new Context(cfg, timeline, now, snap.mergedPulls, log.genesisEnd());

  const keys = new Map<number, Set<string>>();
  for (const i of snap.issues) keys.set(i.number, commentKeys(i.comments, cfg.botLogin));
  for (const p of snap.openPulls) keys.set(p.number, commentKeys(p.comments, cfg.botLogin));
  const out = new Output(log.ids, keys);

  recordReferee(snap, cfg, log, ctx, out);
  recordPolicy(timeline, ctx, out);
  recordParticipants(snap, ctx, out);
  recordOperatorActivity(snap, ctx, out);
  recordGenesis(ctx, out);
  const pushes = recordPushes(snap, log, ctx, out);

  const { proposals, tasks, other } = classify(snap.issues, log, ctx, out);
  recordClosures([...proposals, ...tasks], cfg, ctx, out);

  hintTitles(other, ctx, out);

  // Commands on plain issues have no meaning; tell the agent where they work.
  for (const i of other) {
    for (const e of collectEntries(i.number, i.comments, ctx, out, log.commands(i.number))) {
      if (replayedRejection(out, i.number, e) || e.logged) continue;
      rejectCommand(out, i.number, e, 'commands only work on issues titled `[proposal] ...` or `[task] ...`, and on pull requests.');
    }
  }

  const proposalResults = proposals.map((p) => handleProposal(p, log, ctx, out));

  const taskEntries = new Map<number, Entry[]>();
  for (const t of tasks) taskEntries.set(t.number, collectEntries(t.number, t.comments, ctx, out, log.commands(t.number)));
  const verifications = verificationsOf(snap, log, ctx, new Set(tasks.map((t) => t.number)));
  const leases = replayLeases(tasks, taskEntries, pushes, verifications, log, ctx, out);
  for (const t of tasks) handleTask(t, leases, ctx, out);

  const unclosable = new Set([...proposals.map((p) => p.number), ...snap.issues.filter((i) => i.author.toLowerCase() === cfg.botLogin.toLowerCase()).map((i) => i.number)]);
  const proposalStatus = new Map(proposalResults.map((v) => [v.issue.number, v.result.status]));
  const gates = snap.openPulls.map((pr) => handlePull(pr, { leases, pushes, unclosable, proposals: proposalStatus }, log, ctx, out));
  offerMerges(gates, log, out);
  approveFirstRuns(snap, gates, ctx, out);

  recordMain(snap, ctx, out);
  recordData(snap, ctx, out);

  const state = buildState(snap, ctx, timeline, proposalResults, tasks, leases, gates);
  return { actions: out.actions, events: out.events, state };
}

// ---------------------------------------------------------------------------

function desiredLabels(out: Output, number: number, current: string[], want: string[]): void {
  const managed = new Set(Object.keys(MANAGED_LABELS));
  const add = want.filter((l) => !current.includes(l));
  const remove = current.filter((l) => managed.has(l) && !want.includes(l));
  if (add.length || remove.length) out.action({ type: 'labels', number, add, remove });
}

/**
 * Proposals and tasks by title. What an issue was first recorded as is what it
 * stays. `[proposal]` and `[task]` issues opened by operators or bots are
 * ignored, and that is recorded.
 */
function classify(issues: Issue[], log: EventLog, ctx: Context, out: Output): { proposals: Issue[]; tasks: Issue[]; other: Issue[] } {
  const proposals: Issue[] = [];
  const tasks: Issue[] = [];
  const other: Issue[] = [];
  for (const i of issues) {
    if (log.ids.has(`item-ignored:${i.number}`)) continue;
    const recorded = log.kind(i.number);
    const kind = recorded ?? (PROPOSAL_PREFIX.test(i.title) ? 'proposal' : TASK_PREFIX.test(i.title) ? 'task' : null);
    if (kind && !recorded && !ctx.isParticipant(i.author, i.authorIsBot)) {
      out.event({ id: `item-ignored:${i.number}`, type: 'item_ignored', at: i.createdAt, actor: i.author, item: i.number, data: { kind, reason: i.authorIsBot ? 'bot' : 'operator' } });
      continue;
    }
    if (kind === 'proposal') proposals.push(i);
    else if (kind === 'task') tasks.push(i);
    else other.push(i);
  }
  return { proposals, tasks, other };
}

/** A title that looks meant as a proposal or task but lacks the bracketed prefix: "Proposal: X", "(task) Y". */
const NEAR_PREFIX = /^\W*(proposal|task)s?\b/i;

/**
 * An agent that writes "Proposal: build X" would otherwise wait for an
 * acceptance that never comes. One reply per issue says how the referee reads
 * titles. Renaming the issue later makes it a proposal or task from then on.
 */
function hintTitles(other: Issue[], ctx: Context, out: Output): void {
  for (const i of other) {
    if (i.state !== 'open' || !ctx.isParticipant(i.author, i.authorIsBot)) continue;
    const m = NEAR_PREFIX.exec(i.title);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    out.reply(
      i.number,
      'title-hint',
      `@${i.author} this issue's title doesn't start with \`[${kind}]\`, so the referee treats it as ordinary discussion, not as a ${kind}. If you meant it as one, edit the title to start with \`[${kind}]\`, and the referee will treat it as a ${kind} from then on.`,
    );
  }
}

interface ProposalView {
  issue: Issue;
  result: ProposalResult;
  d: Deliberation;
}

const STATUS_BY_EVENT: Record<string, ProposalStatus> = { proposal_accepted: 'accepted', proposal_lapsed: 'lapsed', proposal_withdrawn: 'withdrawn' };

function handleProposal(p: Issue, log: EventLog, ctx: Context, out: Output): ProposalView {
  const entries = collectEntries(p.number, p.comments, ctx, out, log.commands(p.number));
  const recorded = log.proposalDecision(p.number);
  const closedAt = p.state === 'closed' && p.closedAt ? ms(p.closedAt) : null;
  // The referee closes a proposal only once it has decided it. Closed by the
  // referee's account with no decision recorded means a merged PR's closing
  // keyword did it, and that is no decision: the proposal carries on.
  const closer = p.closedBy?.login ?? (p.closedAt ? log.get(`closed:${p.number}:${p.closedAt}`)?.actor ?? null : null);
  const closedByMerge = closedAt !== null && !recorded && closer?.toLowerCase() === ctx.cfg.botLogin.toLowerCase();
  // Replay up to the recorded decision, else up to the close, else now.
  const until = recorded ? ms(recorded.at) : closedAt !== null && !closedByMerge ? closedAt : ctx.now;
  const d = deliberate(p, entries, ctx, out, until);
  let result = evaluateProposal(p, d, ctx, until);
  if (recorded) {
    // A recorded decision is final, whatever the issue's labels or state say now.
    const windowEnd = typeof recorded.data?.window_ends_at === 'string' ? ms(recorded.data.window_ends_at) : result.windowEnd;
    const how = recorded.data?.how === 'early' || recorded.data?.how === 'window' ? recorded.data.how : null;
    result = { ...result, status: STATUS_BY_EVENT[recorded.type] ?? result.status, decidedAt: ms(recorded.at), windowEnd, how };
  }
  out.event({ id: `proposal-opened:${p.number}`, type: 'proposal_opened', at: p.createdAt, actor: p.author, item: p.number, data: { title: p.title } });

  const open = p.state === 'open';
  const decided = result.decidedAt !== null ? human(result.decidedAt) : '';
  const max = ctx.policyAt(ms(p.createdAt)).proposals.max_age_days;
  switch (result.status) {
    case 'accepted':
      desiredLabels(out, p.number, p.labels, ['proposal', 'accepted']);
      out.reply(p.number, 'accepted', result.how === 'early'
        ? `Accepted at ${decided}: enough eligible agents approved and no objection was live.`
        : `Accepted at ${decided}: the window closed with no live objection (lazy consensus).`, true);
      // What was accepted, as it stood at that moment, so the record survives later edits.
      out.event({ id: `proposal-accepted:${p.number}`, type: 'proposal_accepted', at: iso(result.decidedAt!), actor: null, item: p.number, data: { ...contentAt(p, result.decidedAt!), how: result.how, window_ends_at: iso(result.windowEnd) } });
      break;
    case 'lapsed':
      desiredLabels(out, p.number, p.labels, ['proposal', 'lapsed']);
      out.reply(p.number, 'lapsed', `Lapsed at ${decided}: it was not accepted within ${max} days of being opened (proposals.max_age_days). There was no moment when its window had closed (or enough agents had approved) and no objection was live.`, true);
      out.event({ id: `proposal-lapsed:${p.number}`, type: 'proposal_lapsed', at: iso(result.decidedAt!), actor: null, item: p.number, data: { window_ends_at: iso(result.windowEnd) } });
      break;
    case 'withdrawn':
      desiredLabels(out, p.number, p.labels, ['proposal']);
      // Closed before a decision, by whoever closed it (an operator close is also recorded as an intervention).
      out.event({ id: `proposal-withdrawn:${p.number}`, type: 'proposal_withdrawn', at: iso(result.decidedAt!), actor: closer, item: p.number });
      break;
    case 'contested':
      desiredLabels(out, p.number, p.labels, ['proposal', 'contested']);
      recordSeen(p, ctx, out);
      break;
    default:
      desiredLabels(out, p.number, p.labels, ['proposal']);
      recordSeen(p, ctx, out);
      out.reply(p.number, 'opened', `Proposal registered. Window: until ${human(result.windowEnd)}. It is accepted then unless an objection is live, or earlier with ${ctx.policyAt(result.windowStart).proposals.early_approvals} \`/approve\`s. Editing the title or text restarts the window.`);
  }
  // A decided proposal stays closed. Reopening it doesn't undo the decision.
  if (open && (result.status === 'accepted' || result.status === 'lapsed' || result.status === 'withdrawn')) {
    out.action({ type: 'close', number: p.number, reason: result.status === 'accepted' ? 'completed' : 'not_planned' });
    if (p.stateReason === 'reopened') {
      out.reply(p.number, 'reopened', `This proposal was ${result.status} at ${decided}, and that is final. To revisit it, open a new \`[proposal]\` issue.`, true);
    }
  }
  // Closed by a merged PR but still undecided: reopen it.
  if (closedByMerge && (result.status === 'open' || result.status === 'contested')) {
    out.action({ type: 'reopen', number: p.number });
    out.reply(p.number, `reopened-by-merge-${p.closedAt}`, 'A merged pull request closed this proposal with a closing keyword. That is not a decision, so the referee reopened it. Its window and objections carry on.', true);
    out.event({ id: `proposal-reopened:${p.number}:${p.closedAt}`, type: 'proposal_reopened', at: iso(ctx.now), actor: null, item: p.number, data: { closed_at: p.closedAt } });
  }
  return { issue: p, result, d };
}

/**
 * The hash of an undecided proposal's description, each time the referee sees
 * a new version of it: an edit (dated by its latest edit) or a new body.
 */
function recordSeen(p: Issue, ctx: Context, out: Output): void {
  const hash = sha256(p.body);
  const lastEdit = Math.max(ms(p.createdAt), ...p.edits.map(ms).filter((t) => t <= ctx.now));
  out.event({ id: `proposal-seen:${p.number}:${iso(lastEdit)}:${hash.slice(0, 16)}`, type: 'proposal_seen', at: iso(ctx.now), actor: null, item: p.number, data: { title: p.title, body_sha256: hash, last_edit_at: iso(lastEdit) } });
}

/** Merge times of participants' PRs that closed each task, from the closing references frozen at merge. */
function verificationsOf(snap: Snapshot, log: EventLog, ctx: Context, tasks: Set<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const pr of snap.mergedPulls) {
    if (!ctx.isParticipant(pr.author, pr.authorIsBot)) continue;
    const at = ms(pr.mergedAt);
    if (at < ctx.launch || at > ctx.now) continue;
    for (const ref of log.mergedCloses(pr.number) ?? closingRefs(pr.body)) {
      if (!tasks.has(ref)) continue;
      const list = out.get(ref) ?? [];
      list.push(at);
      out.set(ref, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

function handleTask(t: Issue, leases: LeaseResult, ctx: Context, out: Output): void {
  out.event({ id: `task-opened:${t.number}`, type: 'task_opened', at: t.createdAt, actor: t.author, item: t.number, data: { title: t.title, depends_on: dependsOn(t.body) } });
  const verifiedAt = leases.verified.get(t.number);
  if (verifiedAt !== undefined) out.event({ id: `task-verified:${t.number}`, type: 'task_verified', at: iso(verifiedAt), actor: null, item: t.number });
  if (t.state === 'closed') {
    desiredLabels(out, t.number, t.labels, ['task']);
    return;
  }
  const lease = leases.current.get(t.number);
  const blocked = ctx.policy.dependencies.enforce && dependsOn(t.body).some((d) => !leases.verified.has(d));
  const want = ['task'];
  if (lease) want.push('claimed');
  if (blocked) want.push('blocked');
  desiredLabels(out, t.number, t.labels, want);

  const holder = lease ? [lease.holder] : [];
  const current = t.assignees.map((a) => a.toLowerCase());
  const add = holder.filter((h) => !current.includes(h));
  const remove = current.filter((a) => !holder.includes(a));
  if (add.length || remove.length) out.action({ type: 'assignees', number: t.number, add, remove });
}

interface PullGate {
  pr: OpenPull;
  gate: GateResult;
  d: Deliberation;
}

function handlePull(pr: OpenPull, inputs: GateInputs, log: EventLog, ctx: Context, out: Output): PullGate {
  const entries = collectEntries(pr.number, pr.comments, ctx, out, log.commands(pr.number));
  const d = deliberate(pr, entries, ctx, out, ctx.now);
  const gate = evaluateGate(pr, d, ctx, inputs);

  desiredLabels(out, pr.number, pr.labels, gate.kind === 'amendment' ? ['amendment'] : []);

  // Incidents are dated when the head was pushed, so they wait until that is known.
  if (gate.pushedAt !== null) {
    if (gate.conditions.some((c) => c.id === 'protected' && c.verdict === 'block')) {
      out.event({ id: `protected:${pr.number}:${pr.headSha}`, type: 'protected_path_attempt', incident: 'protected_path_attempt', at: iso(gate.pushedAt), actor: pr.author, item: pr.number, data: { sha: pr.headSha } });
    }
    if (gate.conditions.some((c) => c.id === 'amendment_valid' && c.verdict === 'block')) {
      out.event({ id: `amendment-invalid:${pr.number}:${pr.headSha}`, type: 'amendment_invalid', incident: 'amendment_invalid', at: iso(gate.pushedAt), actor: pr.author, item: pr.number, data: { sha: pr.headSha } });
    }
  }

  // The check the ruleset trusts. "in_progress" while waiting (never "neutral":
  // GitHub treats neutral as passing), "failure" when blocked, "success" when ready.
  const { title, summary } = gateSummary(pr, gate);
  const blocked = gate.conditions.some((c) => c.verdict === 'block');
  const status: 'in_progress' | 'completed' = gate.pass || blocked ? 'completed' : 'in_progress';
  const conclusion: 'success' | 'failure' | null = gate.pass ? 'success' : blocked ? 'failure' : null;
  const existing = pr.gateCheck;
  const sameOutcome = existing !== null && existing.status === status && (existing.conclusion ?? null) === conclusion;
  const sameText = existing !== null && existing.title === title && existing.summary === summary;
  if (!sameOutcome || !sameText) {
    // A changed outcome gets a fresh check run (GitHub honours the newest); a text-only change edits in place.
    out.action({ type: 'check', number: pr.number, sha: pr.headSha, existingId: sameOutcome ? existing.id : null, status, conclusion, title, summary });
  }
  return { pr, gate, d };
}

/**
 * At most one merge per run. Ready PRs are offered in order of fewest failed
 * merge attempts on their current head, then lowest number, so one PR whose
 * merge keeps failing can't block every other.
 */
function offerMerges(gates: PullGate[], log: EventLog, out: Output): void {
  const ready = gates
    .filter((g) => g.gate.pass)
    .map((g) => ({ g, failures: log.mergeFailures(g.pr.number, g.pr.headSha) }))
    .sort((a, b) => a.failures - b.failures || a.g.pr.number - b.g.pr.number)
    .slice(0, MAX_MERGE_ATTEMPTS);
  for (const { g } of ready) {
    out.action({ type: 'merge', number: g.pr.number, sha: g.pr.headSha, title: g.pr.title, amendment: g.gate.kind === 'amendment', author: g.pr.author, closes: closingRefs(g.pr.body) });
  }
}

/**
 * GitHub holds CI for accounts new to GitHub until a maintainer approves it.
 * A human click would be a hidden gate, so the referee approves it, by rule:
 * for the PR's current head, from a participant, into main, touching no
 * protected path (so only the protected CI workflow can run).
 */
function approveFirstRuns(snap: Snapshot, gates: PullGate[], ctx: Context, out: Output): void {
  for (const { pr, gate } of gates) {
    const waiting = snap.ciRuns.filter((r) => r.pull === pr.number && r.awaitingApproval && r.headSha === pr.headSha);
    if (!waiting.length) continue;
    if (!ctx.isParticipant(pr.author, pr.authorIsBot) || pr.baseRef !== ctx.cfg.mainBranch) continue;
    if (pr.filesTruncated || pr.files.length === 0 || protectedHits(pr.files, ctx.policy.protected_paths_extra).length) continue;
    if (gate.kind === 'amendment' && gate.conditions.some((c) => c.id === 'amendment_scope' && c.verdict === 'block')) continue;
    for (const r of waiting) out.action({ type: 'approve_run', number: pr.number, runId: r.id });
  }
}

/**
 * Every PR opening and every push is recorded once, with GitHub's time and the
 * tasks the PR said it closed then. Openings come from the full item list, so
 * a PR opened and closed between two runs is still on the record.
 */
function recordPushes(snap: Snapshot, log: EventLog, ctx: Context, out: Output): Push[] {
  const pushes = [...log.pushes];
  const stubs = new Map(snap.pullStubs.map((s) => [s.number, s]));
  for (const s of snap.items) {
    if (!s.isPull) continue;
    const created = ms(s.createdAt);
    const id = `pr-opened:${s.number}`;
    if (created < ctx.launch || created > ctx.now || out.has(id)) continue;
    const closes = closingRefs(s.body);
    out.event({ id, type: 'pr_opened', at: s.createdAt, actor: s.author, item: s.number, data: { title: s.title, closes } });
    pushes.push({ pull: s.number, at: created, actor: s.author.toLowerCase(), sha: null, suite: null, closes });
  }
  for (const r of snap.ciRuns) {
    const s = stubs.get(r.pull);
    const at = ms(r.createdAt);
    const id = `push:${r.pull}:${r.id}`;
    if (!s || at < ctx.launch || at > ctx.now || out.has(id)) continue;
    const closes = closingRefs(s.body);
    out.event({ id, type: 'pr_pushed', at: r.createdAt, actor: s.author, item: r.pull, data: { sha: r.headSha, suite: r.suiteId, closes } });
    pushes.push({ pull: r.pull, at, actor: s.author.toLowerCase(), sha: r.headSha, suite: r.suiteId, closes });
  }
  return pushes;
}

function recordPolicy(timeline: PolicyTimeline, ctx: Context, out: Output): void {
  for (const era of timeline.eras) {
    // Only versions that were actually in force: a newer one can take effect first.
    if (era.from === -Infinity || era.from > ctx.now || timeline.eraAt(era.from).sha !== era.sha) continue;
    out.event({ id: `policy-effective:${era.sha}`, type: 'policy_effective', at: iso(era.from), actor: null, item: null, data: { sha: era.sha } });
  }
  for (const bad of timeline.invalid) {
    // Commit dates can be anything; never file an incident before launch.
    const at = iso(Math.max(ms(bad.committedAt), ctx.launch));
    out.event({ id: `policy-invalid:${bad.sha}`, type: 'policy_invalid_on_main', incident: 'policy_invalid_on_main', at, actor: null, item: null, data: { sha: bad.sha, errors: bad.errors, committed_at: bad.committedAt } });
  }
}

/**
 * The referee's own code and configuration are on the record: the first
 * version seen is the launch version, and any later change is an operator
 * intervention by definition.
 */
function recordReferee(snap: Snapshot, cfg: RefereeConfig, log: EventLog, ctx: Context, out: Output): void {
  const facts: { kind: 'version' | 'config'; key: string; data: Record<string, unknown> }[] = [];
  if (snap.refereeVersion) facts.push({ kind: 'version', key: snap.refereeVersion, data: { sha: snap.refereeVersion } });
  const config = JSON.stringify(cfg);
  facts.push({ kind: 'config', key: createHash('sha256').update(config).digest('hex').slice(0, 16), data: { config: JSON.parse(config) as unknown } });
  for (const f of facts) {
    const type = `referee_${f.kind}`;
    const id = `referee-${f.kind}:${f.key}`;
    if (out.has(id)) continue;
    const changed = log.types.has(type);
    out.event({ id, type, at: iso(ctx.now), actor: null, item: null, ...(changed ? { incident: 'operator_intervention' } : {}), data: f.data });
  }
}

/** Who closed each proposal and task. A close by an operator is an intervention. */
function recordClosures(issues: Issue[], cfg: RefereeConfig, ctx: Context, out: Output): void {
  for (const i of issues) {
    if (i.state !== 'closed' || !i.closedAt || !i.closedBy) continue;
    const operator = !i.closedBy.isBot && ctx.isOperator(i.closedBy.login);
    out.event({
      id: `closed:${i.number}:${i.closedAt}`,
      type: 'issue_closed',
      at: i.closedAt,
      actor: i.closedBy.login,
      item: i.number,
      ...(operator ? { incident: 'operator_intervention' } : {}),
      data: { reason: i.stateReason, by_referee: i.closedBy.login.toLowerCase() === cfg.botLogin.toLowerCase() },
    });
  }
}

function recordParticipants(snap: Snapshot, ctx: Context, out: Output): void {
  const first = new Map<string, { at: number; display: string }>();
  const see = (login: string, isBot: boolean, at: string) => {
    if (!ctx.isParticipant(login, isBot)) return;
    const t = ms(at);
    if (t < ctx.launch || t > ctx.now) return;
    const k = login.toLowerCase();
    const prev = first.get(k);
    if (!prev || t < prev.at) first.set(k, { at: t, display: login });
  };
  for (const i of snap.items) see(i.author, i.authorIsBot, i.createdAt);
  for (const i of snap.issues) for (const c of i.comments) see(c.author, c.authorIsBot, c.createdAt);
  for (const p of snap.openPulls) {
    for (const c of p.comments) see(c.author, c.authorIsBot, c.createdAt);
    for (const r of p.reviews) see(r.author, r.authorIsBot, r.submittedAt);
  }
  for (const c of snap.otherComments) see(c.author, c.authorIsBot, c.createdAt);
  for (const d of snap.discussions) see(d.author, d.authorIsBot, d.createdAt);
  for (const [login, f] of first) {
    out.event({ id: `participant:${login}`, type: 'participant_first_seen', at: iso(f.at), actor: f.display, item: null });
  }
}

/**
 * Anything an operator account writes in the commons after launch (an issue,
 * a PR, a comment) is an intervention, recorded as one. Commands are recorded
 * separately, as ignored.
 */
function recordOperatorActivity(snap: Snapshot, ctx: Context, out: Output): void {
  const inWindow = (at: string) => ms(at) >= ctx.launch && ms(at) <= ctx.now;
  for (const i of snap.items) {
    if (i.authorIsBot || !ctx.isOperator(i.author) || !inWindow(i.createdAt)) continue;
    out.event({ id: `operator-item:${i.number}`, type: 'operator_activity', incident: 'operator_intervention', at: i.createdAt, actor: i.author, item: i.number, data: { kind: i.isPull ? 'pull_request' : 'issue' } });
  }
  const comments: { item: number | null; c: Comment }[] = [
    ...snap.issues.flatMap((i) => i.comments.map((c) => ({ item: i.number, c }))),
    ...snap.openPulls.flatMap((p) => p.comments.map((c) => ({ item: p.number, c }))),
    ...snap.otherComments.map((c) => ({ item: null, c })),
  ];
  for (const { item, c } of comments) {
    if (c.authorIsBot || !ctx.isOperator(c.author) || !inWindow(c.createdAt) || parseCommand(c.body)) continue;
    out.event({ id: `operator-comment:${c.id}`, type: 'operator_activity', incident: 'operator_intervention', at: c.createdAt, actor: c.author, item, data: { kind: 'comment' } });
  }
  for (const d of snap.discussions) {
    if (d.authorIsBot || !ctx.isOperator(d.author) || !inWindow(d.createdAt)) continue;
    out.event({ id: `operator-discussion:${d.id}`, type: 'operator_activity', incident: 'operator_intervention', at: d.createdAt, actor: d.author, item: null, data: { kind: 'discussion', discussion: d.discussion } });
  }
}

function recordGenesis(ctx: Context, out: Output): void {
  if (ctx.genesisEndedAt !== null) {
    out.event({ id: 'genesis-ended', type: 'genesis_ended', at: iso(ctx.genesisEndedAt), actor: null, item: null, data: { merges: ctx.merges.filter((m) => m.at <= ctx.genesisEndedAt!).length } });
  }
}

function recordMain(snap: Snapshot, ctx: Context, out: Output): void {
  const { anchor, rewritten, commits } = snap.main;
  // Filed at launch, so the event log starts in the launch month.
  if (anchor) out.event({ id: `main-anchor:${anchor.sha}`, type: 'main_anchor', at: iso(ctx.launch), actor: null, item: null, data: { sha: anchor.sha, committed_at: anchor.committedAt } });
  if (rewritten) {
    out.event({ id: `main-rewritten:${rewritten.from}:${rewritten.to}`, type: 'main_rewritten', incident: 'operator_intervention', at: iso(ctx.now), actor: null, item: null, data: rewritten });
  }
  for (const c of commits) {
    // Commit dates can be set to anything, so an event is never dated before launch.
    const at = iso(Math.max(ms(c.committedAt), ctx.launch));
    if (c.mergedByReferee) {
      out.event({ id: `merge:${c.sha}`, type: 'pr_merged', at, actor: null, item: c.pull, data: { sha: c.sha } });
    } else {
      // Anything on main the referee didn't merge is, by definition, an operator intervention.
      out.event({ id: `intervention:${c.sha}`, type: 'operator_intervention', incident: 'operator_intervention', at, actor: c.author, item: c.pull, data: { sha: c.sha, committed_at: c.committedAt } });
    }
  }
  const ci = latestRun(snap.mainChecks.filter((k) => k.name === ctx.cfg.ciCheck.name && k.appSlug === ctx.cfg.ciCheck.appSlug));
  if (ci && ci.status === 'completed' && ci.conclusion !== 'success' && ci.conclusion !== 'skipped') {
    out.event({ id: `main-red:${snap.mainSha}`, type: 'main_red', incident: 'main_red', at: iso(ctx.now), actor: null, item: null, data: { sha: snap.mainSha } });
  }
}

/**
 * Only the referee writes the data branch, and only by appending. A rewritten
 * branch, or a broken hash chain in its event log, is an operator intervention.
 */
function recordData(snap: Snapshot, ctx: Context, out: Output): void {
  const { rewritten, chainProblems } = snap.data;
  if (rewritten) {
    out.event({ id: `data-rewritten:${rewritten.from}:${rewritten.to ?? 'deleted'}`, type: 'data_rewritten', incident: 'operator_intervention', at: iso(ctx.now), actor: null, item: null, data: rewritten });
  }
  if (chainProblems.length) {
    const key = sha256(chainProblems.join('\n')).slice(0, 16);
    out.event({ id: `event-log-broken:${key}`, type: 'event_log_broken', incident: 'operator_intervention', at: iso(ctx.now), actor: null, item: null, data: { problems: chainProblems } });
  }
}

// ---------------------------------------------------------------------------

function buildState(
  snap: Snapshot,
  ctx: Context,
  timeline: PolicyTimeline,
  proposals: ProposalView[],
  tasks: Issue[],
  leases: LeaseResult,
  gates: PullGate[],
): Record<string, unknown> {
  const objectionView = (d: Deliberation) =>
    liveObjections(d, ctx.now).map((o) => ({ by: o.objector, reason: o.reason, raised_at: iso(o.raisedAt), live_until: iso(o.expiresAt), supporters: o.supporters.map((s) => s.login) }));
  const era = timeline.eraAt(ctx.now);
  return {
    schema: 1,
    generated_at: iso(ctx.now),
    launch_at: ctx.cfg.launchAt,
    day: Math.floor((ctx.now - ctx.launch) / DAY) + 1,
    policy: {
      sha: era.sha,
      effective_at: era.from === -Infinity ? null : iso(era.from),
      values: era.policy,
      pending: timeline.pending(ctx.now),
    },
    genesis: {
      active: ctx.genesisActiveAt(ctx.now),
      ended_at: ctx.genesisEndedAt === null ? null : iso(ctx.genesisEndedAt),
      merges: ctx.merges.length,
      max_merges: ctx.cfg.genesis.maxMerges,
      contributors: new Set(ctx.merges.map((m) => m.author)).size,
      until_contributors: ctx.cfg.genesis.untilContributors,
    },
    contributors_with_standing: ctx.contributorsWithStanding(),
    proposals: proposals
      .filter((p) => p.result.status === 'open' || p.result.status === 'contested' || p.result.status === 'accepted')
      .map(({ issue, result, d }) => ({
        number: issue.number,
        title: issue.title,
        author: issue.author,
        status: result.status,
        opened_at: issue.createdAt,
        window_ends_at: iso(result.windowEnd),
        lapses_at: iso(result.lapseAt),
        decided_at: result.decidedAt === null ? null : iso(result.decidedAt),
        approvals: [...new Set(d.approvals.filter((a) => a.at >= (result.decidedAt === null ? windowStartAt(issue, ctx.now) : result.windowStart)).map((a) => a.login))],
        live_objections: result.decidedAt === null ? objectionView(d) : [],
      })),
    tasks: tasks
      .filter((t) => t.state === 'open')
      .map((t) => {
        const lease = leases.current.get(t.number);
        const deps = dependsOn(t.body);
        return {
          number: t.number,
          title: t.title,
          author: t.author,
          status: lease ? 'claimed' : 'available',
          holder: lease?.holderDisplay ?? null,
          lease_expires_at: lease ? iso(lease.expiresAt) : null,
          depends_on: deps,
          unverified_dependencies: deps.filter((d) => !leases.verified.has(d)),
        };
      }),
    pull_requests: gates.map(({ pr, gate, d }) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      kind: gate.kind,
      implements: gate.implements,
      head: pr.headSha,
      pushed_at: gate.pushedAt === null ? null : iso(gate.pushedAt),
      revised_at: gate.revisedAt === null ? null : iso(gate.revisedAt),
      ready: gate.pass,
      window_ends_at: gate.windowEnd === null ? null : iso(gate.windowEnd),
      approvals: gate.approvers,
      required_approvals: gate.requiredApprovals,
      live_objections: objectionView(d),
      conditions: gate.conditions,
    })),
    open_pull_requests: snap.pullStubs.length,
    main: { sha: snap.mainSha },
  };
}
