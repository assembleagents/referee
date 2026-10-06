import { readFileSync } from 'node:fs';
import { parseConfig, type RefereeConfig } from '../src/config.js';
import { evaluate } from '../src/engine.js';
import type { CheckRun, CiRun, Comment, Issue, ItemStub, MergedPull, OpenPull, PullStub, RefEvent, Snapshot } from '../src/types.js';

export const H = 3_600_000;
export const LAUNCH = Date.parse('2026-11-01T00:00:00Z');
/** ISO time `h` hours after launch. */
export const at = (h: number) => new Date(LAUNCH + h * H).toISOString();

export const BOT = 'assemble-referee[bot]';

export function config(over: Partial<RefereeConfig> = {}): RefereeConfig {
  return {
    ...parseConfig({
      owner: 'assembleagents',
      repo: 'commons',
      botLogin: BOT,
      operators: ['founder', 'announcer'],
      launchAt: '2026-11-01T00:00:00Z',
      ciCheck: { name: 'ci', appSlug: 'github-actions' },
      genesis: { maxMerges: 10, untilContributors: 3, mergesPerAgentPerDay: 1 },
      bootstrap: { fastWindowDays: 7, fastWindowHours: 24 },
    }),
    ...over,
  };
}

/** The real launch policy. launch-policy.yaml must stay identical to commons/policy.yaml (checked in policy.test). */
export const REAL_LAUNCH_POLICY = readFileSync(new URL('../../launch-policy.yaml', import.meta.url), 'utf8');

const TALK_FIRST_ON = 'require_accepted_proposal: true';
if (!REAL_LAUNCH_POLICY.includes(TALK_FIRST_ON)) throw new Error(`launch-policy.yaml no longer contains "${TALK_FIRST_ON}"; update test/helpers.ts`);

/**
 * The launch policy with "talk before code" switched off, so tests about other
 * rules don't need an accepted proposal behind every PR. That rule is tested
 * under the real launch policy in proposal-link.test.ts.
 */
export const LAUNCH_POLICY = REAL_LAUNCH_POLICY.replace(TALK_FIRST_ON, 'require_accepted_proposal: false');

export function policyWith(edit: (yaml: string) => string): string {
  return edit(LAUNCH_POLICY);
}

let nextId = 1000;
export function comment(author: string, body: string, h: number, extra: Partial<Comment> = {}): Comment {
  const id = nextId++;
  return { id, author, authorIsBot: author.endsWith('[bot]'), body, createdAt: at(h), updatedAt: at(h), ...extra };
}

export function issue(number: number, title: string, h: number, extra: Partial<Issue> = {}): Issue {
  return {
    number,
    title,
    body: '',
    author: 'alice',
    authorIsBot: false,
    state: 'open',
    stateReason: null,
    createdAt: at(h),
    closedAt: null,
    closedBy: null,
    edits: [],
    labels: [],
    assignees: [],
    comments: [],
    ...extra,
  };
}

/** An entry in the full list of issues and PRs since launch. */
export function item(number: number, isPull: boolean, author: string, h: number, extra: Partial<ItemStub> = {}): ItemStub {
  return { number, isPull, title: `Item ${number}`, body: '', author, authorIsBot: author.endsWith('[bot]'), createdAt: at(h), ...extra };
}

export function ciCheck(h: number, conclusion: string | null = 'success', extra: Partial<CheckRun> = {}): CheckRun {
  return { name: 'ci', appSlug: 'github-actions', status: conclusion === null ? 'in_progress' : 'completed', conclusion, startedAt: at(h), suiteId: null, ...extra };
}

export function pull(number: number, h: number, extra: Partial<OpenPull> = {}): OpenPull {
  return {
    number,
    title: `Change ${number}`,
    body: '',
    author: 'bob',
    authorIsBot: false,
    draft: false,
    baseRef: 'main',
    headSha: `head${number}`,
    createdAt: at(h),
    labels: [],
    comments: [],
    reviews: [],
    checks: [ciCheck(h)],
    files: [{ path: 'src/app.js', previousPath: null }],
    filesTruncated: false,
    mergeable: true,
    behindBy: 0,
    policyAtHead: null,
    gateCheck: null,
    forcePushedAt: null,
    ...extra,
  };
}

let nextRun = 50_000;
/** A CI run GitHub created for a push of `sha` to PR `pull` at hour `h`. */
export function push(pull: number, sha: string, h: number, extra: Partial<CiRun> = {}): CiRun {
  return { id: nextRun++, pull, headSha: sha, createdAt: at(h), suiteId: null, awaitingApproval: false, ...extra };
}

export function stubOf(p: OpenPull): PullStub {
  return { number: p.number, title: p.title, body: p.body, author: p.author, authorIsBot: p.authorIsBot, createdAt: p.createdAt, headSha: p.headSha };
}

export function merged(number: number, author: string, h: number, body = ''): MergedPull {
  return { number, title: `Merged ${number}`, body, author, authorIsBot: false, mergedAt: at(h) };
}

/**
 * A snapshot at hour `nowH`. Unless given, every open PR gets its summary, its
 * entry in the item list, and one CI run for its head at the time it was opened.
 */
export function snapshot(nowH: number, extra: Partial<Snapshot> = {}): Snapshot {
  const openPulls = extra.openPulls ?? [];
  return {
    now: at(nowH),
    issues: [],
    openPulls: [],
    pullStubs: openPulls.map(stubOf),
    ciRuns: openPulls.map((p) => ({ id: p.number * 10, pull: p.number, headSha: p.headSha, createdAt: p.createdAt, suiteId: null, awaitingApproval: false })),
    mergedPulls: [],
    items: openPulls.map((p) => ({ number: p.number, isPull: true, title: p.title, body: p.body, author: p.author, authorIsBot: p.authorIsBot, createdAt: p.createdAt })),
    otherComments: [],
    policyHistory: [{ sha: 'policy0', committedAt: at(-100), raw: LAUNCH_POLICY }],
    mainSha: 'main0',
    mainChecks: [],
    main: { commits: [], anchor: null, rewritten: null },
    discussions: [],
    refereeVersion: null,
    log: [],
    ...extra,
  };
}

export function run(snap: Snapshot, cfg = config()) {
  return evaluate(snap, cfg);
}

/**
 * Simulates applying a run's outcome, then fetching again: its events are in
 * the log, its comments, labels, assignees and closes show on the issues, and
 * its gate checks on the PRs. A second run on the result should be quiet.
 */
export function afterApplying(snap: Snapshot, r = run(snap), laterH?: number): Snapshot {
  const posted = (n: number): Comment[] =>
    r.actions.flatMap((a) => (a.type === 'comment' && a.number === n ? [comment(BOT, a.body, 0, { createdAt: snap.now, updatedAt: snap.now })] : []));
  const labels = (n: number, current: string[]) => {
    let out = [...current];
    for (const a of r.actions) if (a.type === 'labels' && a.number === n) out = [...out.filter((l) => !a.remove.includes(l)), ...a.add];
    return out;
  };
  const assignees = (n: number, current: string[]) => {
    let out = [...current];
    for (const a of r.actions) if (a.type === 'assignees' && a.number === n) out = [...out.filter((l) => !a.remove.includes(l.toLowerCase())), ...a.add];
    return out;
  };
  const closed = (n: number) => r.actions.find((a) => a.type === 'close' && a.number === n);
  return {
    ...snap,
    now: laterH === undefined ? snap.now : at(laterH),
    log: [...snap.log, ...r.events],
    // CI runs already turned into push events aren't fetched again.
    ciRuns: [],
    issues: snap.issues.map((i) => ({
      ...i,
      comments: [...i.comments, ...posted(i.number)],
      labels: labels(i.number, i.labels),
      assignees: assignees(i.number, i.assignees),
      ...(closed(i.number) && i.state === 'open' ? { state: 'closed' as const, closedAt: snap.now, stateReason: 'completed' } : {}),
    })),
    openPulls: snap.openPulls.map((p) => {
      const check = r.actions.filter((a) => a.type === 'check' && a.number === p.number).at(-1);
      return {
        ...p,
        comments: [...p.comments, ...posted(p.number)],
        labels: labels(p.number, p.labels),
        gateCheck: check && check.type === 'check' ? { id: 1, status: check.status, conclusion: check.conclusion, title: check.title, summary: check.summary } : p.gateCheck,
      };
    }),
  };
}

/** Events of one type. */
export const eventsOf = (r: { events: RefEvent[] }, type: string) => r.events.filter((e) => e.type === type);

/** Merged PRs by three distinct agents: ends genesis (untilContributors = 3). */
export function postGenesis(): MergedPull[] {
  return [merged(901, 'carol', 1), merged(902, 'dave', 2), merged(903, 'erin', 3)];
}
