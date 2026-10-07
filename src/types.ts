// Domain types shared by the pure engine and the GitHub adapter.
//
// The engine never talks to GitHub. The adapter builds a Snapshot of the
// commons, the engine turns it into Actions + Events + State, and the adapter
// applies them. Every timestamp is an ISO-8601 string.

export type ISODate = string;

export interface Comment {
  id: number;
  author: string;
  authorIsBot: boolean;
  body: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** A plain issue (proposals, tasks and free discussion). Pull requests are separate. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  state: 'open' | 'closed';
  /** GitHub's state_reason: "completed", "not_planned", "reopened" or null. */
  stateReason: string | null;
  createdAt: ISODate;
  closedAt: ISODate | null;
  /** Who closed it, for closed proposals and tasks whose close isn't recorded yet; null otherwise. */
  closedBy: { login: string; isBot: boolean } | null;
  /**
   * Every time the body was edited or the title renamed, from GitHub's edit
   * history (server time). Fetched only for proposals still being decided;
   * empty otherwise.
   */
  edits: ISODate[];
  /**
   * From the same edit history: the description as it stood after each edit
   * (null where GitHub no longer shows that version), and every title rename.
   * Used to record what a proposal said when it was accepted.
   */
  bodyEdits: { at: ISODate; body: string | null }[];
  renames: { at: ISODate; from: string; to: string }[];
  labels: string[];
  assignees: string[];
  comments: Comment[];
}

export interface Review {
  author: string;
  authorIsBot: boolean;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  commitId: string;
  submittedAt: ISODate;
}

export interface CheckRun {
  name: string;
  appSlug: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | skipped | timed_out | action_required | stale | null */
  conclusion: string | null;
  startedAt: ISODate | null;
  /** The check suite the run belongs to. GitHub Actions makes one suite per workflow run. */
  suiteId: number | null;
}

export interface ChangedFile {
  path: string;
  /** Set for renames, so a rename out of a protected path is still caught. */
  previousPath: string | null;
}

/** The referee's own commons-gate check on a PR head, if one exists. */
export interface ExistingGateCheck {
  id: number;
  status: string;
  conclusion: string | null;
  title: string;
  summary: string;
}

/** Summary of an open PR, from the PR list. Every open PR has one, inspected this run or not. */
export interface PullStub {
  number: number;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  createdAt: ISODate;
  headSha: string;
}

export interface OpenPull {
  number: number;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  draft: boolean;
  baseRef: string;
  headSha: string;
  createdAt: ISODate;
  labels: string[];
  comments: Comment[];
  reviews: Review[];
  /** Check runs on headSha. */
  checks: CheckRun[];
  files: ChangedFile[];
  /** True if GitHub's file list was cut off (more than 3000 files): the gate refuses such PRs. */
  filesTruncated: boolean;
  /** null while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  /** How many commits main is ahead of the PR head; null if GitHub couldn't compare. */
  behindBy: number | null;
  /** Raw policy.yaml at the PR head, when the PR touches policy.yaml. */
  policyAtHead: string | null;
  gateCheck: ExistingGateCheck | null;
  /**
   * When the head was last force-pushed to its current commit (GitHub's PR
   * timeline, server time), or null. Going back to an earlier commit is always
   * a force-push, so this dates a re-pushed old head even before its CI run exists.
   */
  forcePushedAt: ISODate | null;
  /**
   * Every time the title was renamed or the description edited (GitHub's edit
   * history, server time), or null if it couldn't be read: the gate then waits.
   */
  edits: ISODate[] | null;
}

/**
 * A CI workflow run GitHub created for a pull request event: one per push to
 * the PR's branch, plus one when it is opened or reopened. `createdAt` is
 * GitHub's own clock, so it is the referee's record of when a head was pushed.
 * Only runs from the PR's own fork and branch are mapped to it.
 */
export interface CiRun {
  id: number;
  pull: number;
  headSha: string;
  createdAt: ISODate;
  suiteId: number | null;
  /** GitHub is holding the run until a maintainer approves it (first-time contributor). */
  awaitingApproval: boolean;
}

export interface MergedPull {
  number: number;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  mergedAt: ISODate;
}

/** One version of policy.yaml on main, in commit order (oldest first). */
export interface PolicyVersion {
  sha: string;
  committedAt: ISODate;
  raw: string;
}

/** A commit on main since launch that has not been classified in the event log yet. */
export interface MainCommit {
  sha: string;
  committedAt: ISODate;
  author: string | null;
  /** The PR this commit merged, if any. */
  pull: number | null;
  /** True only when the referee itself merged that PR into exactly this commit. */
  mergedByReferee: boolean;
}

/** What the walk down main's first-parent history found this run. */
export interface MainHistory {
  /** New commits since the last one recorded, oldest first. */
  commits: MainCommit[];
  /** Set on the first run after launch: the newest commit from before launch. */
  anchor: { sha: string; committedAt: ISODate } | null;
  /** Set when the head recorded by the previous run is no longer in main's history (force-push). */
  rewritten: { from: string; to: string } | null;
}

/** Light record of every item (issue or PR) since launch, used for participant tracking. */
export interface ItemStub {
  number: number;
  isPull: boolean;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  createdAt: ISODate;
}

/** A post in GitHub Discussions: the referee doesn't count anything there, but records who takes part. */
export interface DiscussionPost {
  /** GitHub's node id (or `discussion-N` for the opening post). */
  id: string;
  discussion: number;
  author: string;
  authorIsBot: boolean;
  createdAt: ISODate;
}

export interface Snapshot {
  now: ISODate;
  /** All non-PR issues created since launch, open and closed. */
  issues: Issue[];
  /** Open PRs inspected in full this run. */
  openPulls: OpenPull[];
  /** Every open PR, including any not inspected this run. */
  pullStubs: PullStub[];
  /** CI runs for open PRs created since the newest push already in the log (with some overlap). */
  ciRuns: CiRun[];
  /** All PRs merged since launch. */
  mergedPulls: MergedPull[];
  /** Every issue and PR since launch (for participant tracking). */
  items: ItemStub[];
  /** Comments on items that are not in `issues` or `openPulls` (closed PRs), for participant tracking. */
  otherComments: Comment[];
  policyHistory: PolicyVersion[];
  mainSha: string;
  mainChecks: CheckRun[];
  main: MainHistory;
  /** Recent posts in Discussions (best effort: empty if they couldn't be read). */
  discussions: DiscussionPost[];
  /** The referee's own code version (its repo's commit), so a change to it is on the record. */
  refereeVersion: string | null;
  /** The data branch itself, as read this run. */
  data: {
    /** Set when the head the referee last wrote is no longer in the data branch's history. */
    rewritten: { from: string; to: string | null } | null;
    /** What is wrong with the event log's hash chain, if anything. */
    chainProblems: string[];
  };
  /** Every event already in the log. Facts recorded there are final. */
  log: RefEvent[];
}

// ---------------------------------------------------------------------------
// Outputs

export interface RefEvent {
  /** Deterministic id. The same fact always produces the same id, so the log never duplicates. */
  id: string;
  type: string;
  /** When the fact happened (not when the referee noticed it). */
  at: ISODate;
  actor: string | null;
  item: number | null;
  /** Set when this event is also an incident. */
  incident?: string;
  data?: Record<string, unknown>;
}

export interface MergeAction {
  type: 'merge';
  number: number;
  sha: string;
  title: string;
  amendment: boolean;
  author: string;
  /** Tasks the PR says it closes, frozen at merge time (the body can be edited later). */
  closes: number[];
}

export type Action =
  | { type: 'labels'; number: number; add: string[]; remove: string[] }
  | { type: 'assignees'; number: number; add: string[]; remove: string[] }
  | { type: 'comment'; number: number; key: string; body: string }
  | { type: 'close'; number: number; reason: 'completed' | 'not_planned' }
  /** Reopen an undecided proposal that a merged PR's closing keyword closed. */
  | { type: 'reopen'; number: number }
  | {
      type: 'check';
      number: number;
      sha: string;
      /** Update this check run in place (same status and conclusion); otherwise create a new one. */
      existingId: number | null;
      status: 'in_progress' | 'completed';
      conclusion: 'success' | 'failure' | null;
      title: string;
      summary: string;
    }
  /**
   * Merge candidates, in priority order. The adapter tries them in order and
   * stops at the first that succeeds, so at most one PR merges per run.
   */
  | MergeAction
  /** Approve a first-time contributor's CI run (no human approval gate). */
  | { type: 'approve_run'; number: number; runId: number }
  | { type: 'open_issue'; number: 0; title: string; body: string; labels: string[] };
