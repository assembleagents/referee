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

import type { Octokit } from '@octokit/rest';
import type { RefereeConfig } from '../config.js';
import { parseEvents } from '../digest.js';
import type { RefEvent } from '../types.js';

const EVENT_FILE = /^events\/\d{4}-\d{2}\.jsonl$/;
export const DIGEST_INDEX = 'digests/index.json';

export interface Store {
  headSha: string | null;
  files: Map<string, string>;
  eventIds: Set<string>;
  events: RefEvent[];
  stateJson: string | null;
  digestDays: Set<string>;
}

const status = (e: unknown) => (e as { status?: number }).status;

export async function readStore(gh: Octokit, cfg: RefereeConfig): Promise<Store> {
  const { owner, repo } = cfg;
  const store: Store = { headSha: null, files: new Map(), eventIds: new Set(), events: [], stateJson: null, digestDays: new Set() };
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
  return store;
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
  events: RefEvent[],
  state: Record<string, unknown>,
  recordedAt: string,
  /** Additional files to write as-is (digests). */
  extra: Map<string, string> = new Map(),
): Promise<{ committed: boolean; newEvents: number }> {
  const { owner, repo } = cfg;
  const fresh = events.filter((e) => !store.eventIds.has(e.id));
  const stateJson = `${JSON.stringify(state, null, 2)}\n`;
  if (fresh.length === 0 && extra.size === 0 && stable(stateJson) === stable(store.stateJson)) return { committed: false, newEvents: 0 };

  const changed = new Map<string, string>(extra);
  const sorted = [...fresh].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const e of sorted) {
    const path = `events/${e.at.slice(0, 7)}.jsonl`;
    const before = changed.get(path) ?? store.files.get(path) ?? '';
    const line = JSON.stringify({ ...e, recorded_at: recordedAt });
    changed.set(path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  changed.set('state.json', stateJson);

  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
  for (const [path, content] of changed) {
    const blob = await gh.rest.git.createBlob({ owner, repo, content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }

  const baseTree = store.headSha ? (await gh.rest.git.getCommit({ owner, repo, commit_sha: store.headSha })).data.tree.sha : undefined;
  const newTree = await gh.rest.git.createTree({ owner, repo, tree, ...(baseTree ? { base_tree: baseTree } : {}) });
  const parts = [fresh.length ? `${fresh.length} event(s)` : '', extra.size ? `${extra.size} digest file(s)` : ''].filter(Boolean);
  const message = parts.length ? `referee: ${parts.join(', ')}` : 'referee: state update';
  const commit = await gh.rest.git.createCommit({ owner, repo, message, tree: newTree.data.sha, parents: store.headSha ? [store.headSha] : [] });

  if (store.headSha) {
    // Not forced: if another run moved the branch, fail loudly instead of losing events.
    await gh.rest.git.updateRef({ owner, repo, ref: `heads/${cfg.dataBranch}`, sha: commit.data.sha, force: false });
  } else {
    await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${cfg.dataBranch}`, sha: commit.data.sha });
  }
  return { committed: true, newEvents: fresh.length };
}
