// The GitHub adapter: the pure pieces of fetching, and apply/datastore against a fake Octokit.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Octokit } from '@octokit/rest';
import { applyActions } from '../src/github/apply.js';
import { writeStore, type Store } from '../src/github/datastore.js';
import { detectRewrite, editTimes, latestForcePushTo, mapRunsToPulls, walkMain, type RawRun, type WalkCommit } from '../src/github/fetch.js';
import type { Action, RefEvent } from '../src/types.js';
import { at, config, LAUNCH } from './helpers.js';

// ---------------------------------------------------------------------------
// CI runs -> pushes

const rawRun = (id: number, repo: string, branch: string, sha: string, h: number, conclusion: string | null = 'success'): RawRun => ({
  id, head_repository: { full_name: repo }, head_branch: branch, head_sha: sha, created_at: at(h), check_suite_id: id * 10, conclusion,
});
const prHead = { number: 20, headRepo: 'bob/commons', headRef: 'fix', createdAt: at(100) };

test('CI runs map to a PR only from its own fork and branch, after it was opened', () => {
  const runs = [
    rawRun(1, 'bob/commons', 'fix', 'aaa', 101),
    rawRun(2, 'Bob/Commons', 'fix', 'bbb', 102), // case of the repo name doesn't matter
    rawRun(3, 'mallory/commons', 'fix', 'bbb', 103), // same branch name and commit, another fork
    rawRun(4, 'bob/commons', 'other', 'bbb', 104), // another branch
    rawRun(5, 'bob/commons', 'fix', 'zzz', 99), // before this PR existed (an earlier PR from the same branch)
    { ...rawRun(6, 'x/y', 'fix', 'ccc', 105), head_repository: null }, // deleted fork
  ];
  const mapped = mapRunsToPulls(runs, [prHead]);
  assert.deepEqual(mapped.map((r) => r.id), [1, 2]);
  assert.deepEqual(mapped[0], { id: 1, pull: 20, headSha: 'aaa', createdAt: at(101), suiteId: 10, awaitingApproval: false });
});

test('a run held for a first-time contributor is marked as awaiting approval', () => {
  const [r] = mapRunsToPulls([rawRun(7, 'bob/commons', 'fix', 'aaa', 101, 'action_required')], [prHead]);
  assert.equal(r?.awaitingApproval, true);
});

test('the force-push that matters is the newest one to the current head', () => {
  const nodes = [
    { createdAt: at(10), afterCommit: { oid: 'x' } },
    { createdAt: at(30), afterCommit: { oid: 'x' } },
    { createdAt: at(40), afterCommit: { oid: 'y' } },
    null,
  ];
  assert.equal(latestForcePushTo(nodes, 'x'), at(30));
  assert.equal(latestForcePushTo(nodes, 'z'), null);
});

test('edit history: body edits and title renames, deduplicated and sorted', () => {
  const nodes = (...ts: (string | null)[]) => ({ nodes: ts.map((t) => (t === null ? null : { editedAt: t })) });
  const renames = (...ts: string[]) => ({ nodes: ts.map((t) => ({ createdAt: t })) });
  assert.deepEqual(editTimes({ e1: nodes(at(5), at(3)), e2: nodes(at(5), null), r1: renames(at(4)), r2: { nodes: [{}] } }), [at(3), at(4), at(5)]);
  assert.deepEqual(editTimes(null), []);
});

// ---------------------------------------------------------------------------
// Walking main

/** A chain of commits, oldest first: [sha, hoursAfterLaunch]. */
function chain(...commits: [string, number][]): Map<string, WalkCommit> {
  const m = new Map<string, WalkCommit>();
  commits.forEach(([sha, h], i) => m.set(sha, { sha, parent: i ? commits[i - 1]![0] : null, committedAt: at(h), author: 'x' }));
  return m;
}
const loader = (m: Map<string, WalkCommit>, fetched: string[] = []) => async (sha: string, fetch: boolean) => {
  if (fetch) fetched.push(sha);
  return m.get(sha) ?? null;
};

test('first run: everything after the last pre-launch commit is new, and that commit is the anchor', async () => {
  const m = chain(['p1', -20], ['p2', -1], ['c1', 5], ['c2', 6]);
  const w = await walkMain('c2', loader(m), new Set(), LAUNCH, false, null);
  assert.deepEqual(w.fresh.map((c) => c.sha), ['c1', 'c2']);
  assert.equal(w.anchor?.sha, 'p2');
  assert.equal(detectRewrite(null, 'c2', w), null);
});

test('later runs stop at the first known commit; commit dates are not trusted', async () => {
  // c3 claims to be from before launch, but it was pushed after the anchor: it is new.
  const m = chain(['p2', -1], ['c1', 5], ['c3', -50]);
  const w = await walkMain('c3', loader(m), new Set(['p2', 'c1']), LAUNCH, true, 'c1');
  assert.deepEqual(w.fresh.map((c) => c.sha), ['c3']);
  assert.equal(detectRewrite('c1', 'c3', w), null);
});

test('a merge the referee recorded is known; the walk still confirms the previous head is an ancestor', async () => {
  const m = chain(['a', 1], ['b', 2], ['merged', 3]);
  const fetched: string[] = [];
  const w = await walkMain('merged', loader(m, fetched), new Set(['a', 'b', 'merged']), LAUNCH, true, 'b');
  assert.deepEqual(w.fresh, []);
  assert.equal(detectRewrite('b', 'merged', w), null);
  assert.deepEqual(fetched, []); // known commits are never fetched one by one
});

test('a force-push that drops the previous head is detected', async () => {
  // Main was a-b-c; now it is a-x. c (the previous head) is gone.
  const m = chain(['a', 1], ['x', 2]);
  const w = await walkMain('x', loader(m), new Set(['a', 'b', 'c']), LAUNCH, true, 'c');
  assert.deepEqual(w.fresh.map((c) => c.sha), ['x']);
  assert.deepEqual(detectRewrite('c', 'x', w), { from: 'c', to: 'x' });
});

// ---------------------------------------------------------------------------
// Applying actions

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** A fake Octokit: records every call; `fail` decides which ones throw. */
function fakeGh(fail: (method: string, args: Record<string, unknown>) => boolean = () => false) {
  const calls: Call[] = [];
  const fn = (method: string, result: (args: Record<string, unknown>) => unknown = () => ({})) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    if (fail(method, args)) throw Object.assign(new Error(`${method} failed`), { status: 500 });
    return { data: result(args) };
  };
  const gh = {
    rest: {
      issues: {
        addLabels: fn('addLabels'),
        removeLabel: fn('removeLabel'),
        addAssignees: fn('addAssignees'),
        removeAssignees: fn('removeAssignees'),
        createComment: fn('createComment'),
        update: fn('update'),
        create: fn('create', () => ({ number: 99 })),
      },
      checks: { create: fn('checks.create'), update: fn('checks.update') },
      actions: { approveWorkflowRun: fn('approveWorkflowRun') },
      pulls: { merge: fn('merge', (a) => ({ merged: true, sha: `sq${String(a.pull_number)}`, message: 'ok' })) },
      git: {
        createBlob: fn('createBlob', () => ({ sha: `blob${calls.length}` })),
        getCommit: fn('getCommit', () => ({ tree: { sha: 'tree0' } })),
        createTree: fn('createTree', () => ({ sha: 'tree1' })),
        createCommit: fn('createCommit', () => ({ sha: 'commit1' })),
        updateRef: fn('updateRef'),
        createRef: fn('createRef'),
      },
    },
  };
  return { gh: gh as unknown as Octokit, calls };
}

const NOW = new Date(at(300));
const quiet = () => {};
const merge = (number: number): Action => ({ type: 'merge', number, sha: `head${number}`, title: `PR ${number}`, amendment: false, author: 'bob', closes: [5] });

test('an issue is never closed when its labels could not be set', async () => {
  const { gh, calls } = fakeGh((m, a) => m === 'addLabels' && a.issue_number === 1);
  const actions: Action[] = [
    { type: 'close', number: 1, reason: 'completed' },
    { type: 'labels', number: 1, add: ['accepted'], remove: [] },
    { type: 'labels', number: 2, add: ['lapsed'], remove: [] },
    { type: 'close', number: 2, reason: 'not_planned' },
  ];
  const r = await applyActions(gh, config(), actions, NOW, quiet);
  assert.deepEqual(calls.filter((c) => c.method === 'update').map((c) => c.args.issue_number), [2]);
  assert.deepEqual(r.failed.map((f) => [f.action.type, f.action.number]), [['labels', 1], ['close', 1]]);
});

test('merge candidates are tried in order; the first success is the only merge, and failures are recorded', async () => {
  const { gh, calls } = fakeGh((m, a) => m === 'merge' && a.pull_number === 30);
  const r = await applyActions(gh, config(), [merge(30), merge(31), merge(32)], NOW, quiet);
  assert.deepEqual(calls.filter((c) => c.method === 'merge').map((c) => c.args.pull_number), [30, 31]);
  const types = r.events.map((e) => [e.type, e.item]);
  assert.deepEqual(types, [['merge_failed', 30], ['pr_merged', 31]]);
  const mergedEvent = r.events.find((e) => e.type === 'pr_merged')!;
  assert.deepEqual(mergedEvent.data, { sha: 'sq31', head: 'head31', amendment: false, closes: [5] });
  assert.equal(mergedEvent.actor, 'bob');
});

test('merges come after every other action, and checks before them', async () => {
  const { gh, calls } = fakeGh();
  await applyActions(gh, config(), [
    merge(30),
    { type: 'check', number: 30, sha: 'head30', existingId: null, status: 'completed', conclusion: 'success', title: 't', summary: 's' },
    { type: 'approve_run', number: 31, runId: 77 },
    { type: 'comment', number: 1, key: 'k', body: 'b' },
  ], NOW, quiet);
  assert.deepEqual(calls.map((c) => c.method), ['createComment', 'approveWorkflowRun', 'checks.create', 'merge']);
});

test('an approved CI run becomes an event; a failed approval does not', async () => {
  const ok = await applyActions(fakeGh().gh, config(), [{ type: 'approve_run', number: 20, runId: 77 }], NOW, quiet);
  assert.deepEqual(ok.events.map((e) => e.id), ['ci-approved:77']);
  const bad = await applyActions(fakeGh((m) => m === 'approveWorkflowRun').gh, config(), [{ type: 'approve_run', number: 20, runId: 77 }], NOW, quiet);
  assert.deepEqual(bad.events, []);
  assert.equal(bad.failed.length, 1);
});

// ---------------------------------------------------------------------------
// The data branch

const emptyStore = (over: Partial<Store> = {}): Store => ({ headSha: 'data0', files: new Map(), eventIds: new Set(), events: [], stateJson: null, digestDays: new Set(), ...over });
const ev = (id: string, h: number): RefEvent => ({ id, type: 't', at: at(h), actor: null, item: null });

test('new events are appended to the file of the month they happened in; known ones are skipped', async () => {
  const { gh, calls } = fakeGh();
  const existing = `${JSON.stringify(ev('old', 1))}\n`;
  const store = emptyStore({ files: new Map([['events/2026-11.jsonl', existing]]), eventIds: new Set(['old']) });
  const r = await writeStore(gh, config(), store, [ev('old', 1), ev('b', 2), ev('a', 2), ev('dec', 24 * 31)], { day: 1 }, at(800));
  assert.deepEqual(r, { committed: true, newEvents: 3 });
  const blobs = calls.filter((c) => c.method === 'createBlob').map((c) => Buffer.from(String(c.args.content), 'base64').toString('utf8'));
  const nov = blobs.find((b) => b.startsWith(existing))!;
  assert.deepEqual(nov.trim().split('\n').map((l) => (JSON.parse(l) as RefEvent).id), ['old', 'a', 'b']);
  assert.ok(blobs.some((b) => b.includes('"id":"dec"') && !b.includes('"id":"a"')));
  assert.equal(calls.find((c) => c.method === 'updateRef')?.args.force, false);
});

test('a quiet run writes nothing: the timestamp alone is not a change', async () => {
  const { gh, calls } = fakeGh();
  const store = emptyStore({ stateJson: `${JSON.stringify({ schema: 1, generated_at: at(1), day: 1 }, null, 2)}\n` });
  const r = await writeStore(gh, config(), store, [], { schema: 1, generated_at: at(2), day: 1 }, at(2));
  assert.deepEqual(r, { committed: false, newEvents: 0 });
  assert.deepEqual(calls, []);
});
