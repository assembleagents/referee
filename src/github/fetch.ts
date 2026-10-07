// Builds a Snapshot of the commons from GitHub. Read-only: never writes.
// GitHub is the source of truth for what is happening now; the event log on
// the data branch is the record of what has already been decided.

import type { Octokit } from '@octokit/rest';
import type { RefereeConfig } from '../config.js';
import type { EventLog } from '../log.js';
import { POLICY_PATH } from '../paths.js';
import { PROPOSAL_PREFIX, TASK_PREFIX } from '../proposals.js';
import { ROTATE_MS, selectPulls } from '../selection.js';
import { DAY, HOUR } from '../time.js';
import type { ChangedFile, CheckRun, CiRun, Comment, DiscussionPost, ExistingGateCheck, Issue, ItemStub, MainCommit, MainHistory, MergedPull, OpenPull, PolicyVersion, PullStub, Review, Snapshot } from '../types.js';

type Log = (msg: string) => void;

interface UserLike {
  login?: string;
  type?: string;
}

const login = (u: UserLike | null | undefined) => u?.login ?? 'ghost';
const isBot = (u: UserLike | null | undefined) => u?.type === 'Bot' || (u?.login ?? '').endsWith('[bot]');
const status = (e: unknown) => (e as { status?: number }).status;

function decode(content: string): string {
  return Buffer.from(content, 'base64').toString('utf8');
}

export function appSlug(cfg: RefereeConfig): string {
  return cfg.botLogin.replace(/\[bot\]$/, '');
}

/** CI runs are fetched from an hour before the newest recorded push, and never further back than this. */
export const RUN_LOOKBACK_MAX_MS = 7 * DAY;
/** Main's history is walked at most this far back per run. */
export const MAX_MAIN_WALK = 200;

export interface FetchOptions {
  log: EventLog;
  /** main's head as recorded by the previous run (state.json), to detect a rewritten history. */
  previousMainSha: string | null;
  /** How many open PRs to inspect in full this run. */
  pullBudget: number;
}

export async function fetchSnapshot(gh: Octokit, cfg: RefereeConfig, now: Date, opts: FetchOptions, log: Log): Promise<Snapshot> {
  const { owner, repo } = cfg;
  const launch = Date.parse(cfg.launchAt);

  // 1. Every issue and PR touched since launch (GitHub's `since` filters on updated_at).
  const rawItems = await gh.paginate(gh.rest.issues.listForRepo, { owner, repo, state: 'all', since: cfg.launchAt, per_page: 100 });
  const items = rawItems.filter((i) => Date.parse(i.created_at) >= launch);
  log(`items since launch: ${items.length}`);

  // 2. Every comment since launch, grouped by item.
  const rawComments = await gh.paginate(gh.rest.issues.listCommentsForRepo, { owner, repo, since: cfg.launchAt, per_page: 100 });
  const commentsByItem = new Map<number, Comment[]>();
  for (const c of rawComments) {
    const n = Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1]);
    if (!Number.isFinite(n)) continue;
    const list = commentsByItem.get(n) ?? [];
    list.push({ id: c.id, author: login(c.user), authorIsBot: isBot(c.user), body: c.body ?? '', createdAt: c.created_at, updatedAt: c.updated_at });
    commentsByItem.set(n, list);
  }

  const stubs: ItemStub[] = items.map((i) => ({ number: i.number, isPull: Boolean(i.pull_request), title: i.title, body: i.body ?? '', author: login(i.user), authorIsBot: isBot(i.user), createdAt: i.created_at }));

  // 3. Issues. Proposals still being decided get their edit history: their windows depend on it.
  const issues: Issue[] = items
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      author: login(i.user),
      authorIsBot: isBot(i.user),
      state: i.state === 'closed' ? 'closed' : 'open',
      stateReason: i.state_reason ?? null,
      createdAt: i.created_at,
      closedAt: i.closed_at ?? null,
      closedBy: null,
      edits: [],
      bodyEdits: [],
      renames: [],
      labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
      assignees: (i.assignees ?? []).map((a) => a.login),
      comments: commentsByItem.get(i.number) ?? [],
    }));
  const isProposal = (i: Issue) => opts.log.kind(i.number) === 'proposal' || (opts.log.kind(i.number) === null && PROPOSAL_PREFIX.test(i.title));
  const isTask = (i: Issue) => opts.log.kind(i.number) === 'task' || (opts.log.kind(i.number) === null && TASK_PREFIX.test(i.title));
  const undecided = issues.filter((i) => isProposal(i) && !opts.log.proposalDecision(i.number));
  await fillEdits(gh, cfg, undecided);
  // Who closed a proposal or task decides whether the close was an intervention. Fetched once per close.
  for (const i of issues) {
    if (i.state !== 'closed' || !i.closedAt || !(isProposal(i) || isTask(i)) || opts.log.ids.has(`closed:${i.number}:${i.closedAt}`)) continue;
    const full = (await gh.rest.issues.get({ owner, repo, issue_number: i.number })).data;
    i.closedBy = full.closed_by ? { login: login(full.closed_by), isBot: isBot(full.closed_by) } : null;
  }

  // 4. Main.
  const branch = await gh.rest.repos.getBranch({ owner, repo, branch: cfg.mainBranch });
  const mainSha = branch.data.commit.sha;
  const mainChecks = await checksFor(gh, cfg, mainSha);

  // 5. Open PRs: a summary of each, the CI runs for their pushes, and a full inspection within the budget.
  const rawOpen = await gh.paginate(gh.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  const open = rawOpen.filter((p) => Date.parse(p.created_at) >= launch);
  const pullStubs: PullStub[] = open.map((p) => ({ number: p.number, title: p.title, body: p.body ?? '', author: login(p.user), authorIsBot: isBot(p.user), createdAt: p.created_at, headSha: p.head.sha }));
  const ciRuns = await fetchCiRuns(gh, cfg, now, opts.log, open.map((p) => ({ number: p.number, headRepo: p.head.repo?.full_name ?? null, headRef: p.head.ref, createdAt: p.created_at })));

  const openPulls: OpenPull[] = [];
  const selected = selectPulls(open.map((p) => ({ number: p.number, author: login(p.user) })), opts.pullBudget, Math.floor(now.getTime() / ROTATE_MS));
  for (const p of selected) {
    // One PR that can't be read never stops the run: it is simply not judged this time.
    try {
      openPulls.push(await hydratePull(gh, cfg, p.number, mainSha, commentsByItem.get(p.number) ?? []));
    } catch (e) {
      log(`could not inspect PR #${p.number}: ${status(e) ?? ''} ${(e as Error).message}`);
    }
  }
  log(`open PRs: ${open.length}, inspected ${openPulls.length}${open.length > selected.length ? ` (budget ${opts.pullBudget}, round robin by author)` : ''}; new CI runs: ${ciRuns.length}`);
  try {
    await fillPullHistory(gh, cfg, openPulls);
  } catch (e) {
    // Without force-pushes the gate still has the CI runs; without the edit history (left null) it waits.
    log(`could not read force-push and edit history: ${(e as Error).message.split('\n')[0]}`);
  }

  // 6. PRs merged since launch.
  const mergedPulls: MergedPull[] = [];
  for (const i of items.filter((x) => x.pull_request && x.state === 'closed')) {
    const mergedAt = i.pull_request?.merged_at;
    if (mergedAt) mergedPulls.push({ number: i.number, title: i.title, body: i.body ?? '', author: login(i.user), authorIsBot: isBot(i.user), mergedAt });
  }

  // 7. policy.yaml history on main (including the pre-launch launch policy).
  const policyHistory = await fetchPolicyHistory(gh, cfg);

  // 8. Commits on main since the last one classified.
  const main = await fetchMainHistory(gh, cfg, mainSha, opts.log, opts.previousMainSha, log);

  // 9. Recent posts in Discussions, to record who takes part there (and any operator post).
  let discussions: DiscussionPost[] = [];
  try {
    discussions = await fetchDiscussions(gh, cfg, now);
  } catch (e) {
    log(`could not read Discussions (does the App have Discussions: read?): ${(e as Error).message.split('\n')[0]}`);
  }

  const known = new Set([...issues.map((i) => i.number), ...openPulls.map((p) => p.number)]);
  const otherComments = [...commentsByItem.entries()].filter(([n]) => !known.has(n)).flatMap(([, list]) => list);

  return {
    now: now.toISOString(),
    issues,
    openPulls,
    pullStubs,
    ciRuns,
    mergedPulls,
    items: stubs,
    otherComments,
    policyHistory,
    mainSha,
    mainChecks,
    main,
    discussions,
    refereeVersion: null,
    data: { rewritten: null, chainProblems: [] },
    log: [],
  };
}

/** Discussions updated within this window are read each run. */
export const DISCUSSION_LOOKBACK_MS = 7 * DAY;

interface GqlAuthor {
  login?: string;
  __typename?: string;
}
interface GqlPost {
  id?: string;
  createdAt?: string;
  author?: GqlAuthor | null;
}
interface GqlDiscussion extends GqlPost {
  number?: number;
  updatedAt?: string;
  comments?: { nodes?: (GqlPost & { replies?: { nodes?: (GqlPost | null)[] | null } | null } | null)[] | null } | null;
}

/** Flattens a GraphQL discussions page into posts: the opening post, comments and replies. */
export function discussionPosts(nodes: (GqlDiscussion | null)[], since: number): DiscussionPost[] {
  const out: DiscussionPost[] = [];
  const add = (id: string | undefined, discussion: number, p: GqlPost | null | undefined) => {
    if (!id || !p?.createdAt || !p.author?.login) return;
    out.push({ id, discussion, author: p.author.login, authorIsBot: p.author.__typename === 'Bot' || p.author.login.endsWith('[bot]'), createdAt: p.createdAt });
  };
  for (const d of nodes) {
    if (!d?.number || !d.updatedAt || Date.parse(d.updatedAt) < since) continue;
    add(`discussion-${d.number}`, d.number, d);
    for (const c of d.comments?.nodes ?? []) {
      add(c?.id, d.number, c);
      for (const r of c?.replies?.nodes ?? []) add(r?.id, d.number, r);
    }
  }
  return out;
}

async function fetchDiscussions(gh: Octokit, cfg: RefereeConfig, now: Date): Promise<DiscussionPost[]> {
  const author = 'author { login __typename }';
  const res = await gh.graphql<{ repository: { discussions: { nodes: (GqlDiscussion | null)[] } } | null }>(
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {
      discussions(first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes {
        number createdAt updatedAt ${author}
        comments(last: 20) { nodes { id createdAt ${author} replies(last: 5) { nodes { id createdAt ${author} } } } }
      } }
    } }`,
    { owner: cfg.owner, repo: cfg.repo },
  );
  return discussionPosts(res.repository?.discussions.nodes ?? [], now.getTime() - DISCUSSION_LOOKBACK_MS);
}

/**
 * GraphQL is the only API with an issue's edit history (body edits and title
 * renames). Each body edit's `diff` is the full text of that version.
 */
async function fillEdits(gh: Octokit, cfg: RefereeConfig, issues: Issue[]): Promise<void> {
  for (let i = 0; i < issues.length; i += 25) {
    const chunk = issues.slice(i, i + 25);
    const fields = chunk
      .map((x) => `i${x.number}: issue(number: ${x.number}) {
        e1: userContentEdits(first: 100) { nodes { editedAt diff deletedAt } }
        e2: userContentEdits(last: 100) { nodes { editedAt diff deletedAt } }
        r1: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], first: 100) { nodes { ... on RenamedTitleEvent { createdAt previousTitle currentTitle } } }
        r2: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 100) { nodes { ... on RenamedTitleEvent { createdAt previousTitle currentTitle } } }
      }`)
      .join('\n');
    const res = await gh.graphql<{ repository: Record<string, RawEditHistory | null> }>(
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`,
      { owner: cfg.owner, repo: cfg.repo },
    );
    for (const x of chunk) {
      const h = res.repository[`i${x.number}`] ?? null;
      x.edits = editTimes(h);
      Object.assign(x, editVersions(h));
    }
  }
}

type Conn<T> = { nodes?: (T | null)[] | null } | null | undefined;
interface RawEditHistory {
  e1?: Conn<{ editedAt?: string | null; diff?: string | null; deletedAt?: string | null }>;
  e2?: Conn<{ editedAt?: string | null; diff?: string | null; deletedAt?: string | null }>;
  r1?: Conn<{ createdAt?: string; previousTitle?: string; currentTitle?: string }>;
  r2?: Conn<{ createdAt?: string; previousTitle?: string; currentTitle?: string }>;
}

/** The versions in an issue's GraphQL history, oldest first, each once. */
export function editVersions(r: RawEditHistory | null): Pick<Issue, 'bodyEdits' | 'renames'> {
  const bodies = new Map<string, string | null>();
  const renames = new Map<string, { at: string; from: string; to: string }>();
  for (const n of [...(r?.e1?.nodes ?? []), ...(r?.e2?.nodes ?? [])]) {
    if (n?.editedAt) bodies.set(n.editedAt, n.deletedAt || typeof n.diff !== 'string' ? null : n.diff);
  }
  for (const n of [...(r?.r1?.nodes ?? []), ...(r?.r2?.nodes ?? [])]) {
    if (n?.createdAt && typeof n.previousTitle === 'string' && typeof n.currentTitle === 'string') {
      renames.set(`${n.createdAt}\n${n.previousTitle}`, { at: n.createdAt, from: n.previousTitle, to: n.currentTitle });
    }
  }
  return {
    bodyEdits: [...bodies].map(([at, body]) => ({ at, body })).sort((a, b) => a.at.localeCompare(b.at)),
    renames: [...renames.values()].sort((a, b) => a.at.localeCompare(b.at)),
  };
}

type ForcePushNode = { createdAt?: string; afterCommit?: { oid?: string } | null } | null;

/** The newest force-push that set the head to `sha`, or null. */
export function latestForcePushTo(nodes: ForcePushNode[], sha: string): string | null {
  let best: string | null = null;
  for (const n of nodes) if (n?.afterCommit?.oid === sha && n.createdAt && (best === null || Date.parse(n.createdAt) > Date.parse(best))) best = n.createdAt;
  return best;
}

/**
 * From each PR's timeline: every force-push, with GitHub's time and the commit
 * it moved the head to, and every title rename. From its edit history: every
 * description edit.
 */
async function fillPullHistory(gh: Octokit, cfg: RefereeConfig, pulls: OpenPull[]): Promise<void> {
  type History = { f?: { nodes?: ForcePushNode[] | null } | null; e1?: unknown; e2?: unknown; r1?: unknown; r2?: unknown };
  for (let i = 0; i < pulls.length; i += 25) {
    const chunk = pulls.slice(i, i + 25);
    const fields = chunk
      .map((p) => `p${p.number}: pullRequest(number: ${p.number}) {
        f: timelineItems(last: 5, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt afterCommit { oid } } } }
        e1: userContentEdits(first: 100) { nodes { editedAt } }
        e2: userContentEdits(last: 100) { nodes { editedAt } }
        r1: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], first: 100) { nodes { ... on RenamedTitleEvent { createdAt } } }
        r2: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 100) { nodes { ... on RenamedTitleEvent { createdAt } } }
      }`)
      .join('\n');
    const res = await gh.graphql<{ repository: Record<string, History | null> }>(
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`,
      { owner: cfg.owner, repo: cfg.repo },
    );
    for (const p of chunk) {
      const h = res.repository[`p${p.number}`] ?? null;
      p.forcePushedAt = latestForcePushTo(h?.f?.nodes ?? [], p.headSha);
      p.edits = h ? editTimes(h) : null;
    }
  }
}

/** Every distinct edit or rename time in an issue's GraphQL history, oldest first. */
export function editTimes(r: { e1?: unknown; e2?: unknown; r1?: unknown; r2?: unknown } | null): string[] {
  if (!r) return [];
  const times = new Set<string>();
  for (const conn of [r.e1, r.e2, r.r1, r.r2] as ({ nodes?: ({ editedAt?: string | null; createdAt?: string } | null)[] | null } | null | undefined)[]) {
    for (const n of conn?.nodes ?? []) {
      const t = n?.editedAt ?? n?.createdAt;
      if (t) times.add(t);
    }
  }
  return [...times].sort();
}

async function checksFor(gh: Octokit, cfg: RefereeConfig, sha: string): Promise<CheckRun[]> {
  const runs = await gh.paginate(gh.rest.checks.listForRef, { owner: cfg.owner, repo: cfg.repo, ref: sha, per_page: 100, filter: 'all' });
  return runs.map(toCheckRun);
}

function toCheckRun(r: { name: string; app?: { slug?: string } | null; status: string; conclusion?: string | null; started_at?: string | null; check_suite?: { id: number } | null }): CheckRun {
  return { name: r.name, appSlug: r.app?.slug ?? '', status: r.status, conclusion: r.conclusion ?? null, startedAt: r.started_at ?? null, suiteId: r.check_suite?.id ?? null };
}

export interface RawRun {
  id: number;
  head_sha: string;
  head_branch: string | null;
  created_at: string;
  check_suite_id?: number | null;
  conclusion?: string | null;
  head_repository?: { full_name?: string } | null;
}

export interface PullHead {
  number: number;
  headRepo: string | null;
  headRef: string;
  createdAt: string;
}

/**
 * Maps CI runs to the open PRs they belong to: same fork, same branch, created
 * after the PR. Another PR built from the same commit (or a branch with the
 * same name in another fork) is not this PR's push.
 */
export function mapRunsToPulls(runs: RawRun[], pulls: PullHead[]): CiRun[] {
  const out: CiRun[] = [];
  for (const r of runs) {
    const repo = r.head_repository?.full_name?.toLowerCase();
    if (!repo || !r.head_branch) continue;
    for (const p of pulls) {
      if (p.headRepo?.toLowerCase() !== repo || p.headRef !== r.head_branch) continue;
      if (Date.parse(r.created_at) < Date.parse(p.createdAt)) continue;
      out.push({ id: r.id, pull: p.number, headSha: r.head_sha, createdAt: r.created_at, suiteId: r.check_suite_id ?? null, awaitingApproval: r.conclusion === 'action_required' });
    }
  }
  return out;
}

/** Pull-request CI runs created since shortly before the newest recorded push. */
async function fetchCiRuns(gh: Octokit, cfg: RefereeConfig, now: Date, eventLog: EventLog, pulls: PullHead[]): Promise<CiRun[]> {
  if (pulls.length === 0) return [];
  const launch = Date.parse(cfg.launchAt);
  const latest = eventLog.latestPushAt;
  const since = Math.max(launch, now.getTime() - RUN_LOOKBACK_MAX_MS, latest === null ? -Infinity : latest - HOUR);
  const runs = await gh.paginate(gh.rest.actions.listWorkflowRunsForRepo, {
    owner: cfg.owner,
    repo: cfg.repo,
    event: 'pull_request',
    created: `>=${new Date(since).toISOString()}`,
    exclude_pull_requests: true,
    per_page: 100,
  });
  return mapRunsToPulls(runs as RawRun[], pulls);
}

async function hydratePull(gh: Octokit, cfg: RefereeConfig, number: number, mainSha: string, comments: Comment[]): Promise<OpenPull> {
  const { owner, repo } = cfg;
  const pr = (await gh.rest.pulls.get({ owner, repo, pull_number: number })).data;
  const headSha = pr.head.sha;

  const rawFiles = await gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
  const files: ChangedFile[] = rawFiles.map((f) => ({ path: f.filename, previousPath: f.previous_filename ?? null }));

  const rawReviews = await gh.paginate(gh.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
  const reviews: Review[] = rawReviews
    .filter((r) => r.submitted_at && r.commit_id)
    .map((r) => ({ author: login(r.user), authorIsBot: isBot(r.user), state: r.state, commitId: r.commit_id!, submittedAt: r.submitted_at! }));

  const rawRuns = await gh.paginate(gh.rest.checks.listForRef, { owner, repo, ref: headSha, per_page: 100, filter: 'all' });
  const checks: CheckRun[] = rawRuns.map(toCheckRun);
  const slug = appSlug(cfg);
  const ours = rawRuns
    .filter((r) => r.name === cfg.gateCheckName && r.app?.slug === slug)
    .sort((a, b) => b.id - a.id)[0];
  const gateCheck: ExistingGateCheck | null = ours
    ? { id: ours.id, status: ours.status, conclusion: ours.conclusion ?? null, title: ours.output?.title ?? '', summary: ours.output?.summary ?? '' }
    : null;

  let behindBy: number | null = null;
  for (const basehead of [`${mainSha}...${headSha}`, `${owner}:${mainSha}...${pr.head.repo?.owner.login ?? owner}:${headSha}`]) {
    try {
      behindBy = (await gh.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead, per_page: 1 })).data.behind_by;
      break;
    } catch (e) {
      if (status(e) !== 404) throw e;
    }
  }

  let policyAtHead: string | null = null;
  if (files.some((f) => f.path === POLICY_PATH || f.previousPath === POLICY_PATH)) {
    // Read exactly the head commit (not refs/pull/N/head, which could move on).
    const sources = [pr.head.repo ? { owner: pr.head.repo.owner.login, repo: pr.head.repo.name } : null, { owner, repo }];
    for (const src of sources) {
      if (!src) continue;
      try {
        const res = await gh.rest.repos.getContent({ ...src, path: POLICY_PATH, ref: headSha });
        if (!Array.isArray(res.data) && res.data.type === 'file' && 'content' in res.data) {
          policyAtHead = decode(res.data.content);
          break;
        }
      } catch (e) {
        if (status(e) === 404) {
          // Deleted in this PR: an empty policy, which validation will reject.
          if (src.owner === owner) policyAtHead = '';
          continue;
        }
        throw e;
      }
    }
  }

  return {
    number,
    title: pr.title,
    body: pr.body ?? '',
    author: login(pr.user),
    authorIsBot: isBot(pr.user),
    draft: Boolean(pr.draft),
    baseRef: pr.base.ref,
    headSha,
    createdAt: pr.created_at,
    labels: pr.labels.map((l) => l.name ?? '').filter(Boolean),
    comments,
    reviews,
    checks,
    files,
    filesTruncated: pr.changed_files > files.length,
    mergeable: pr.mergeable ?? null,
    behindBy,
    policyAtHead,
    gateCheck,
    forcePushedAt: null,
    edits: null,
  };
}

async function fetchPolicyHistory(gh: Octokit, cfg: RefereeConfig): Promise<PolicyVersion[]> {
  const { owner, repo } = cfg;
  const commits = await gh.paginate(gh.rest.repos.listCommits, { owner, repo, sha: cfg.mainBranch, path: POLICY_PATH, per_page: 100 });
  const out: PolicyVersion[] = [];
  for (const c of commits.reverse()) {
    let raw = '';
    try {
      const res = await gh.rest.repos.getContent({ owner, repo, path: POLICY_PATH, ref: c.sha });
      if (!Array.isArray(res.data) && res.data.type === 'file' && 'content' in res.data) raw = decode(res.data.content);
    } catch (e) {
      if (status(e) !== 404) throw e; // 404: deleted in this commit -> invalid version
    }
    out.push({ sha: c.sha, committedAt: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(), raw });
  }
  return out;
}

export interface WalkCommit {
  sha: string;
  parent: string | null;
  committedAt: string;
  author: string | null;
}

export interface Walk {
  /** Commits not yet classified, oldest first. */
  fresh: WalkCommit[];
  /** First run only: the newest commit from before launch. */
  anchor: WalkCommit | null;
  /** True if the head recorded by the previous run is on the first-parent chain (or there is none). */
  sawPrevious: boolean;
}

/**
 * Walks main's first-parent chain from `head`. Commits are collected down to
 * the first one the log already knows; committer dates are never trusted to
 * skip one, except to place the launch anchor on the very first run. The walk
 * then goes on (through commits already loaded, no extra requests) until it
 * meets the head the previous run recorded, to notice a rewritten history.
 * `load(sha, fetch)` may only make a request when `fetch` is true.
 */
export async function walkMain(
  head: string,
  load: (sha: string, fetch: boolean) => Promise<WalkCommit | null>,
  known: Set<string>,
  launch: number,
  hasAnchor: boolean,
  previous: string | null,
  max = MAX_MAIN_WALK,
): Promise<Walk> {
  const fresh: WalkCommit[] = [];
  let anchor: WalkCommit | null = null;
  let collecting = true;
  let sawPrevious = previous === null;
  let sha: string | null = head;
  for (let steps = 0; sha && steps < max; steps += 1) {
    if (sha === previous) sawPrevious = true;
    if (collecting && known.has(sha)) collecting = false;
    if (!collecting && sawPrevious) break;
    const c = await load(sha, collecting);
    if (!c) break;
    if (collecting && !hasAnchor && Date.parse(c.committedAt) <= launch) {
      anchor = c;
      collecting = false;
      if (sawPrevious) break;
    }
    if (collecting) fresh.push(c);
    sha = c.parent;
  }
  return { fresh: fresh.reverse(), anchor, sawPrevious };
}

/** Rewritten if the head the previous run recorded is no longer on main's first-parent chain. */
export function detectRewrite(previous: string | null, head: string, walk: Walk): { from: string; to: string } | null {
  if (!previous || previous === head || walk.sawPrevious) return null;
  return { from: previous, to: head };
}

async function fetchMainHistory(gh: Octokit, cfg: RefereeConfig, head: string, eventLog: EventLog, previous: string | null, log: Log): Promise<MainHistory> {
  const { owner, repo } = cfg;
  const cache = new Map<string, WalkCommit>();
  type RawCommit = { sha: string; parents: { sha: string }[]; commit: { committer?: { date?: string } | null; author?: { date?: string; name?: string } | null }; author?: { login?: string } | null };
  const remember = (c: RawCommit): WalkCommit => {
    const w: WalkCommit = {
      sha: c.sha,
      parent: c.parents[0]?.sha ?? null,
      committedAt: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(),
      author: c.author?.login ?? c.commit.author?.name ?? null,
    };
    cache.set(c.sha, w);
    return w;
  };
  // One page usually covers everything since the last run; anything older is fetched commit by commit.
  const page = await gh.rest.repos.listCommits({ owner, repo, sha: head, per_page: 100 });
  for (const c of page.data) remember(c as RawCommit);
  const load = async (sha: string, fetch: boolean): Promise<WalkCommit | null> => {
    const hit = cache.get(sha);
    if (hit || !fetch) return hit ?? null;
    try {
      return remember((await gh.rest.repos.getCommit({ owner, repo, ref: sha })).data as RawCommit);
    } catch (e) {
      if (status(e) === 404) return null;
      throw e;
    }
  };

  const hasAnchor = [...eventLog.ids].some((id) => id.startsWith('main-anchor:'));
  const walk = await walkMain(head, load, eventLog.mainShas, Date.parse(cfg.launchAt), hasAnchor, previous);
  const rewritten = detectRewrite(previous, head, walk);
  if (rewritten) log(`main was rewritten: ${rewritten.from} is no longer in its history`);

  const commits: MainCommit[] = [];
  for (const c of walk.fresh) {
    let pull: number | null = null;
    let mergedByReferee = false;
    const prs = await gh.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: c.sha });
    const merged = prs.data.find((p) => p.merge_commit_sha === c.sha && p.merged_at);
    if (merged) {
      pull = merged.number;
      const full = await gh.rest.pulls.get({ owner, repo, pull_number: merged.number });
      mergedByReferee = full.data.merged_by?.login?.toLowerCase() === cfg.botLogin.toLowerCase();
    }
    commits.push({ sha: c.sha, committedAt: c.committedAt, author: c.author, pull, mergedByReferee });
  }
  if (commits.length) log(`unclassified main commits: ${commits.length}`);
  return { commits, anchor: walk.anchor ? { sha: walk.anchor.sha, committedAt: walk.anchor.committedAt } : null, rewritten };
}
