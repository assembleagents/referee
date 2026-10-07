// The `data` branch of the commons: an orphan branch holding the research
// dataset. Never merged into main, so it never pollutes the code history.
//
//   state.json              current state of the commons (overwritten each change)
//   events/YYYY-MM.jsonl    append-only event log, one JSON object per line,
//                           filed by the month the fact happened
//   digests/YYYY-MM-DD.json daily fact digest (and .md), rewritten if a fact
//                           for that day is recorded late
//   digests/index.json      list of digested days
//
// It is the record, not a cache: facts in it are final, and some can't be
// recovered from GitHub (commands whose comments were edited or deleted,
// pushes older than the CI-run lookback). If it were lost, the next run would
// rebuild state.json and re-derive what GitHub still shows, and nothing more.
//
// The event log is a hash chain. Each line carries `prev_hash`, the `hash` of
// the line the referee wrote before it (null for the very first), and `hash`,
// the sha256 of the line's JSON without its `hash` field. Lines are chained in
// the order they were written, across month files. Changing, removing or
// reordering a recorded line breaks the chain, and the head hash is published
// in every daily digest and chronicle issue, so dropping the newest lines shows
// too. To verify: for each line, remove `hash`, JSON.stringify the rest (same
// key order), and compare its sha256.

import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import type { RefereeConfig } from '../config.js';
import { parseEvents } from '../digest.js';
import type { RefEvent } from '../types.js';

const EVENT_FILE = /^events\/\d{4}-\d{2}\.jsonl$/;
export const DIGEST_INDEX = 'digests/index.json';

export interface ChainCheck {
  /** Hash of the newest line: the one no other line points back to. Null for an empty log. */
  head: string | null;
  /** What is wrong with the chain, if anything. Empty when it is intact. */
  problems: string[];
}

export interface Store {
  headSha: string | null;
  files: Map<string, string>;
  eventIds: Set<string>;
  events: RefEvent[];
  stateJson: string | null;
  digestDays: Set<string>;
  chain: ChainCheck;
}

const status = (e: unknown) => (e as { status?: number }).status;

export function lineHash(record: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
}

/** One event as a line of the log, chained to the line before it. */
export function chainLine(e: RefEvent, recordedAt: string, prev: string | null): { line: string; hash: string } {
  const { recorded_at: _r, prev_hash: _p, hash: _h, ...event } = e as RefEvent & Record<string, unknown>;
  const record = { ...event, recorded_at: recordedAt, prev_hash: prev };
  const hash = lineHash(record);
  return { line: JSON.stringify({ ...record, hash }), hash };
}

/** Checks every line's hash and that the lines form one unbroken chain; finds its head. */
export function checkChain(files: Iterable<string>): ChainCheck {
  const lines = new Map<string, { prev: string | null; recordedAt: string }>();
  let unreadable = 0;
  let unhashed = 0;
  let mismatched = 0;
  for (const text of files) {
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch {
        unreadable += 1;
        continue;
      }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        unreadable += 1;
        continue;
      }
      const { hash, ...rest } = obj as Record<string, unknown>;
      if (typeof hash !== 'string') {
        unhashed += 1;
        continue;
      }
      if (lineHash(rest) !== hash) mismatched += 1;
      lines.set(hash, { prev: typeof rest.prev_hash === 'string' ? rest.prev_hash : null, recordedAt: String(rest.recorded_at ?? '') });
    }
  }
  const pointedTo = new Set([...lines.values()].flatMap((l) => (l.prev === null ? [] : [l.prev])));
  // More than one head only if the chain forked or was cut; then continue from the newest.
  const heads = [...lines.keys()]
    .filter((h) => !pointedTo.has(h))
    .sort((a, b) => lines.get(b)!.recordedAt.localeCompare(lines.get(a)!.recordedAt) || a.localeCompare(b));
  const missing = [...pointedTo].filter((p) => !lines.has(p)).length;
  const firsts = [...lines.values()].filter((l) => l.prev === null).length;
  const problems: string[] = [];
  if (unreadable) problems.push(`${unreadable} line(s) are not valid JSON objects`);
  if (unhashed) problems.push(`${unhashed} line(s) carry no hash`);
  if (mismatched) problems.push(`${mismatched} line(s) don't match their hash`);
  if (missing) problems.push(`${missing} line(s) point back to a line that is missing`);
  if (firsts > 1) problems.push(`${firsts} lines claim to be the first`);
  if (heads.length > 1) problems.push(`the chain has ${heads.length} heads`);
  return { head: heads[0] ?? null, problems };
}

export async function readStore(gh: Octokit, cfg: RefereeConfig): Promise<Store> {
  const { owner, repo } = cfg;
  const store: Store = { headSha: null, files: new Map(), eventIds: new Set(), events: [], stateJson: null, digestDays: new Set(), chain: { head: null, problems: [] } };
  let headSha: string;
  try {
    headSha = (await gh.rest.git.getRef({ owner, repo, ref: `heads/${cfg.dataBranch}` })).data.object.sha;
  } catch (e) {
    if (status(e) === 404) return store; // first run: the branch is created on first write
    throw e;
  }
  store.headSha = headSha;
  const commit = await gh.rest.git.getCommit({ owner, repo, commit_sha: headSha });
  const tree = await gh.rest.git.getTree({ owner, repo, tree_sha: commit.data.tree.sha, recursive: 'true' });
  for (const entry of tree.data.tree) {
    if (entry.type !== 'blob' || !entry.path || !entry.sha) continue;
    if (!EVENT_FILE.test(entry.path) && entry.path !== 'state.json' && entry.path !== DIGEST_INDEX) continue;
    const blob = await gh.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
    const text = Buffer.from(blob.data.content, 'base64').toString('utf8');
    if (entry.path === 'state.json') {
      store.stateJson = text;
      continue;
    }
    if (entry.path === DIGEST_INDEX) {
      try {
        const days = (JSON.parse(text) as { days?: unknown }).days;
        if (Array.isArray(days)) for (const d of days) if (typeof d === 'string') store.digestDays.add(d);
      } catch {
        // Rebuilt below on the next digest write.
      }
      continue;
    }
    store.files.set(entry.path, text);
  }
  store.events = parseEvents(store.files.values());
  for (const e of store.events) store.eventIds.add(e.id);
  store.chain = checkChain(store.files.values());
  return store;
}

/**
 * Was the data branch rewritten? `previous` is the head this referee last
 * wrote, remembered outside the branch (see memory.ts). Rewritten if the
 * branch no longer has it in its history, as for main.
 */
export async function detectDataRewrite(gh: Octokit, cfg: RefereeConfig, previous: string | null, head: string | null): Promise<{ from: string; to: string | null } | null> {
  if (!previous || previous === head) return null;
  if (!head) return { from: previous, to: null };
  try {
    const res = await gh.rest.repos.compareCommitsWithBasehead({ owner: cfg.owner, repo: cfg.repo, basehead: `${previous}...${head}`, per_page: 1 });
    return res.data.status === 'ahead' || res.data.status === 'identical' ? null : { from: previous, to: head };
  } catch (e) {
    if (status(e) === 404) return { from: previous, to: head };
    throw e;
  }
}

/** New event lines, chained onto the stored log, waiting to be written. */
export interface PendingLog {
  /** Every month file this run appends to, with its full new content. */
  files: Map<string, string>;
  /** The chain's head once these lines are written. */
  head: string | null;
  added: number;
  readonly base: Map<string, string>;
  readonly ids: Set<string>;
}

export function startLog(store: Pick<Store, 'files' | 'eventIds' | 'chain'>): PendingLog {
  return { files: new Map(), head: store.chain.head, added: 0, base: store.files, ids: new Set(store.eventIds) };
}

/** Appends the events not yet in the log, in time order, each chained to the one before. */
export function appendEvents(log: PendingLog, events: RefEvent[], recordedAt: string): void {
  const fresh = events.filter((e) => !log.ids.has(e.id));
  const sorted = [...fresh].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const e of sorted) {
    if (log.ids.has(e.id)) continue;
    log.ids.add(e.id);
    const path = `events/${e.at.slice(0, 7)}.jsonl`;
    const before = log.files.get(path) ?? log.base.get(path) ?? '';
    const { line, hash } = chainLine(e, recordedAt, log.head);
    log.files.set(path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`);
    log.head = hash;
    log.added += 1;
  }
}

/** Comparing state without its timestamp avoids a commit on every quiet run. */
function stable(json: string | null): string {
  if (!json) return '';
  try {
    const { generated_at: _ignored, ...rest } = JSON.parse(json) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return '';
  }
}

export async function writeStore(
  gh: Octokit,
  cfg: RefereeConfig,
  store: Store,
  log: PendingLog,
  state: Record<string, unknown>,
  /** Additional files to write as-is (digests). */
  extra: Map<string, string> = new Map(),
): Promise<{ committed: boolean; newEvents: number; headSha: string | null }> {
  const { owner, repo } = cfg;
  const stateJson = `${JSON.stringify(state, null, 2)}\n`;
  if (log.added === 0 && extra.size === 0 && stable(stateJson) === stable(store.stateJson)) return { committed: false, newEvents: 0, headSha: store.headSha };

  const changed = new Map<string, string>([...extra, ...log.files]);
  changed.set('state.json', stateJson);

  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
  for (const [path, content] of changed) {
    const blob = await gh.rest.git.createBlob({ owner, repo, content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }

  const baseTree = store.headSha ? (await gh.rest.git.getCommit({ owner, repo, commit_sha: store.headSha })).data.tree.sha : undefined;
  const newTree = await gh.rest.git.createTree({ owner, repo, tree, ...(baseTree ? { base_tree: baseTree } : {}) });
  const parts = [log.added ? `${log.added} event(s)` : '', extra.size ? `${extra.size} digest file(s)` : ''].filter(Boolean);
  const message = parts.length ? `referee: ${parts.join(', ')}` : 'referee: state update';
  const commit = await gh.rest.git.createCommit({ owner, repo, message, tree: newTree.data.sha, parents: store.headSha ? [store.headSha] : [] });

  if (store.headSha) {
    // Not forced: if another run moved the branch, fail loudly instead of losing events.
    await gh.rest.git.updateRef({ owner, repo, ref: `heads/${cfg.dataBranch}`, sha: commit.data.sha, force: false });
  } else {
    await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${cfg.dataBranch}`, sha: commit.data.sha });
  }
  return { committed: true, newEvents: log.added, headSha: commit.data.sha };
}
