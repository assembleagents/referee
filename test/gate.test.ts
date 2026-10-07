import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECK_SUMMARY_MAX, code } from '../src/gate.js';
import type { Action, OpenPull, Review } from '../src/types.js';
import { afterApplying, at, ciCheck, comment, issue, LAUNCH_POLICY, merged, policyWith, postGenesis, pull, push, run, snapshot } from './helpers.js';

type Cond = { id: string; verdict: string; detail: string };
type PrView = { number: number; ready: boolean; conditions: Cond[]; required_approvals: number; approvals: string[]; pushed_at: string | null; window_ends_at: string | null };
const view = (r: ReturnType<typeof run>, n = 20) => (r.state.pull_requests as PrView[]).find((p) => p.number === n)!;
const cond = (r: ReturnType<typeof run>, id: string, n = 20) => view(r, n).conditions.find((c) => c.id === id);
const merges = (actions: Action[]) => actions.filter((a) => a.type === 'merge');
const checkOf = (actions: Action[], n = 20) => actions.find((a): a is Extract<Action, { type: 'check' }> => a.type === 'check' && a.number === n);
const review = (author: string, state: string, commitId: string, h: number): Review => ({ author, authorIsBot: false, state, commitId, submittedAt: at(h) });

// PR #20 by bob: pushed at 200h, 24h window -> mergeable from 224h.
const PR = (extra: Partial<OpenPull> = {}) => pull(20, 200, extra);

test('genesis: a clean PR merges after the window, with no reviews needed', () => {
  const waiting = run(snapshot(223, { openPulls: [PR()] }));
  assert.equal(cond(waiting, 'window')?.verdict, 'wait');
  assert.equal(checkOf(waiting.actions)?.status, 'in_progress');
  assert.equal(checkOf(waiting.actions)?.conclusion, null);
  assert.equal(merges(waiting.actions).length, 0);

  const ready = run(snapshot(224, { openPulls: [PR({ body: 'Closes #5' })] }));
  assert.equal(view(ready).ready, true);
  assert.equal(checkOf(ready.actions)?.conclusion, 'success');
  assert.deepEqual(merges(ready.actions), [{ type: 'merge', number: 20, sha: 'head20', title: 'Change 20', amendment: false, author: 'bob', closes: [5] }]);
});

test('protected files block the PR permanently and log an incident', () => {
  const r = run(snapshot(300, { openPulls: [PR({ files: [{ path: '.github/workflows/ci.yml', previousPath: null }] })] }));
  assert.equal(cond(r, 'protected')?.verdict, 'block');
  assert.equal(checkOf(r.actions)?.conclusion, 'failure');
  assert.equal(merges(r.actions).length, 0);
  assert.ok(r.events.some((e) => e.incident === 'protected_path_attempt'));
});

test('any other spelling of policy.yaml is protected, not an amendment that waits forever', () => {
  const r = run(snapshot(300, { openPulls: [PR({ files: [{ path: 'POLICY.YAML', previousPath: null }] })] }));
  assert.equal(view(r).conditions.some((c) => c.id === 'amendment_valid'), false);
  assert.equal(cond(r, 'protected')?.verdict, 'block');
});

test('CI must pass on the head, from the real CI app', () => {
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ checks: [ciCheck(200, 'failure')] })] })), 'ci')?.verdict, 'block');
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ checks: [ciCheck(200, null)] })] })), 'ci')?.verdict, 'wait');
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ checks: [] })] })), 'ci')?.verdict, 'wait');
  // A check named "ci" from some other app (e.g. the author's own workflow app) does not count.
  const spoof = run(snapshot(300, { openPulls: [PR({ checks: [ciCheck(200, 'success', { appSlug: 'evil-app' })] })] }));
  assert.equal(cond(spoof, 'ci')?.verdict, 'wait');
  // The newest run decides: a later failure blocks, a later success (re-run) passes.
  const laterFail = run(snapshot(300, { openPulls: [PR({ checks: [ciCheck(200), ciCheck(201, 'failure')] })] }));
  assert.equal(cond(laterFail, 'ci')?.verdict, 'block');
  const rerunOk = run(snapshot(300, { openPulls: [PR({ checks: [ciCheck(200, 'cancelled'), ciCheck(201)] })] }));
  assert.equal(cond(rerunOk, 'ci')?.verdict, 'pass');
});

test('only the CI run of the latest push counts, not one left over from an earlier push of the same commit', () => {
  const checks = [ciCheck(200, 'success', { suiteId: 1 }), ciCheck(250, 'failure', { suiteId: 3 })];
  const ciRuns = [push(20, 'head20', 200, { suiteId: 1 }), push(20, 'other', 210, { suiteId: 2 }), push(20, 'head20', 250, { suiteId: 3 })];
  const r = run(snapshot(300, { openPulls: [PR({ checks })], ciRuns }));
  assert.equal(cond(r, 'ci')?.verdict, 'block');
});

test('the review window restarts on every push', () => {
  const r = run(snapshot(230, { openPulls: [PR()], ciRuns: [push(20, 'old', 200), push(20, 'head20', 220)] }));
  assert.equal(cond(r, 'window')?.verdict, 'wait');
  assert.match(cond(r, 'window')!.detail, /2026-11-11 04:00 UTC/); // 220 + 24 = 244h
  assert.equal(view(r).pushed_at, at(220));
});

test('pushing an old commit again restarts the window (no reuse of an earlier push time)', () => {
  // X at 200, Y at 201, then X again at 260: the window runs from 260, not 200.
  const ciRuns = [push(20, 'head20', 200), push(20, 'yyy', 201), push(20, 'head20', 260)];
  const r = run(snapshot(270, { openPulls: [PR()], ciRuns }));
  assert.equal(cond(r, 'window')?.verdict, 'wait');
  assert.equal(merges(r.actions).length, 0);
  assert.equal(view(r).window_ends_at, at(284));
});

test('if the newest push has no CI run for the current head yet, the gate waits', () => {
  // The head is back on X, but the only run after Y is not there yet.
  const r = run(snapshot(300, { openPulls: [PR()], ciRuns: [push(20, 'head20', 200), push(20, 'yyy', 201)] }));
  assert.equal(cond(r, 'window')?.verdict, 'wait');
  assert.equal(cond(r, 'ci')?.verdict, 'wait');
  assert.equal(view(r).pushed_at, null);
  assert.equal(merges(r.actions).length, 0);
});

test('a commit with [skip ci] in between, then the old head force-pushed back: the window runs from the force-push', () => {
  // X pushed at 200 (CI ran). Y pushed with [skip ci] at 201 (no run). X force-pushed back at 250,
  // and the referee runs before GitHub has created the CI run for that push.
  const r = run(snapshot(251, { openPulls: [PR({ forcePushedAt: at(250) })], ciRuns: [push(20, 'head20', 200)] }));
  assert.equal(view(r).pushed_at, at(250));
  assert.equal(cond(r, 'window')?.verdict, 'wait');
  assert.equal(merges(r.actions).length, 0);
});

test('a PR may not close a proposal with a closing keyword, in its title or its description', () => {
  const proposal = issue(5, '[proposal] keep it simple', 100);
  const byBody = run(snapshot(300, { issues: [proposal], openPulls: [PR({ body: 'Unrelated fix. Closes #5' })] }));
  assert.equal(cond(byBody, 'closes')?.verdict, 'block');
  assert.equal(merges(byBody.actions).length, 0);
  const byTitle = run(snapshot(300, { issues: [proposal], openPulls: [PR({ title: 'fixes #5' })] }));
  assert.equal(cond(byTitle, 'closes')?.verdict, 'block');
  // Tasks and ordinary issues are fine.
  const task = run(snapshot(300, { issues: [issue(6, '[task] do it', 100), issue(7, 'bug report', 100)], openPulls: [PR({ body: 'Closes #6, fixes #7' })] }));
  assert.equal(cond(task, 'closes'), undefined);
  assert.equal(merges(task.actions).length, 1);
});

test('/approve given while another commit was the head does not count after a switch back', () => {
  const ciRuns = [push(20, 'head20', 200), push(20, 'yyy', 210), push(20, 'head20', 230)];
  const comments = [comment('carol', '/approve', 220)];
  const r = run(snapshot(300, { mergedPulls: postGenesis(), openPulls: [PR({ comments })], ciRuns }));
  assert.deepEqual(view(r).approvals, []);
});

test('pushes recorded in earlier runs count as much as new ones', () => {
  const log = [{ id: 'push:20:1', type: 'pr_pushed', at: at(250), actor: 'bob', item: 20, data: { sha: 'head20', suite: null, closes: [] } }];
  const r = run(snapshot(260, { openPulls: [PR()], ciRuns: [], log }));
  assert.equal(view(r).pushed_at, at(250));
});

test('the window is as long as the rules in force when the head was pushed', () => {
  const shorter = policyWith((y) => y.replace('window_hours: 24', 'window_hours: 2'));
  const policyHistory = [{ sha: 'p1', committedAt: at(-1), raw: LAUNCH_POLICY }, { sha: 'p2', committedAt: at(205), raw: shorter }]; // in force from 229
  const before = run(snapshot(232, { policyHistory, openPulls: [PR()], ciRuns: [push(20, 'head20', 228)] }));
  assert.equal(cond(before, 'window')?.verdict, 'wait'); // pushed at 228 under the 24h rule
  const after = run(snapshot(232, { policyHistory, openPulls: [PR()], ciRuns: [push(20, 'head20', 229)] }));
  assert.equal(cond(after, 'window')?.verdict, 'pass'); // pushed at 229 under the 2h rule
});

test('after genesis: approvals on the exact head commit are required', () => {
  const base = { mergedPulls: postGenesis() };
  const none = run(snapshot(300, { ...base, openPulls: [PR()] }));
  assert.equal(view(none).required_approvals, 1);
  assert.equal(cond(none, 'approvals')?.verdict, 'wait');

  const stale = run(snapshot(300, { ...base, openPulls: [PR({ reviews: [review('carol', 'APPROVED', 'oldsha', 210)] })] }));
  assert.equal(cond(stale, 'approvals')?.verdict, 'wait');

  const ok = run(snapshot(300, { ...base, openPulls: [PR({ reviews: [review('carol', 'APPROVED', 'head20', 210)] })] }));
  assert.equal(view(ok).ready, true);
  assert.equal(merges(ok.actions).length, 1);
});

test('later CHANGES_REQUESTED on the head cancels an earlier approval', () => {
  const reviews = [review('carol', 'APPROVED', 'head20', 210), review('carol', 'CHANGES_REQUESTED', 'head20', 211)];
  const r = run(snapshot(300, { mergedPulls: postGenesis(), openPulls: [PR({ reviews })] }));
  assert.equal(cond(r, 'approvals')?.verdict, 'wait');
});

test('/approve comments count only if posted after the latest push', () => {
  const base = { mergedPulls: postGenesis() };
  const before = run(snapshot(300, { ...base, openPulls: [PR({ comments: [comment('carol', '/approve', 199)] })] }));
  assert.equal(cond(before, 'approvals')?.verdict, 'wait');
  const after = run(snapshot(300, { ...base, openPulls: [PR({ comments: [comment('carol', '/approve', 201)] })] }));
  assert.equal(cond(after, 'approvals')?.verdict, 'pass');
});

test('approvals from agents without standing, the author or operators do not count', () => {
  const reviews = [review('newbie', 'APPROVED', 'head20', 210), review('bob', 'APPROVED', 'head20', 210), review('founder', 'APPROVED', 'head20', 210)];
  const r = run(snapshot(300, { mergedPulls: postGenesis(), openPulls: [PR({ reviews })] }));
  assert.deepEqual(view(r).approvals, []);
});

test('a live objection holds the merge; withdrawal releases it', () => {
  const objected = run(snapshot(230, { openPulls: [PR({ comments: [comment('carol', '/object breaks the API', 210)] })] }));
  assert.equal(cond(objected, 'objections')?.verdict, 'wait');
  assert.equal(merges(objected.actions).length, 0);
  const withdrawn = run(snapshot(230, { openPulls: [PR({ comments: [comment('carol', '/object x', 210), comment('carol', '/withdraw', 220)] })] }));
  assert.equal(merges(withdrawn.actions).length, 1);
  assert.ok(withdrawn.actions.some((a) => a.type === 'comment' && a.body.includes('withdrew their objection')));
});

test('objection text is rendered inertly in the check output', () => {
  const r = run(snapshot(230, { openPulls: [PR({ comments: [comment('carol', '/object see [this](https://evil.example) `x` | y', 210)] })] }));
  const summary = checkOf(r.actions)!.summary;
  assert.ok(summary.includes('`see [this](https://evil.example)  x  / y`'));
  assert.equal(code('a`b\nc|d'), '`a b c/d`');
});

test('operator PRs never merge', () => {
  const r = run(snapshot(300, { openPulls: [PR({ author: 'founder' })] }));
  assert.equal(cond(r, 'participant')?.verdict, 'block');
  assert.equal(merges(r.actions).length, 0);
});

test('genesis rate limit: one merge per agent per 24h', () => {
  const r = run(snapshot(300, { openPulls: [PR()], mergedPulls: [merged(10, 'bob', 290)] }));
  assert.equal(cond(r, 'genesis_rate')?.verdict, 'wait');
  const later = run(snapshot(315, { openPulls: [PR()], mergedPulls: [merged(10, 'bob', 290)] }));
  assert.equal(cond(later, 'genesis_rate')?.verdict, 'pass');
});

test('amendments: valid policy, longer window, two approvals', () => {
  const raw = policyWith((y) => y.replace('hours: 48', 'hours: 24'));
  const files = [{ path: 'policy.yaml', previousPath: null }];
  const reviews = [review('carol', 'APPROVED', 'head20', 210), review('dave', 'APPROVED', 'head20', 211)];
  const early = run(snapshot(250, { openPulls: [PR({ files, policyAtHead: raw, reviews })] }));
  assert.equal(cond(early, 'window')?.verdict, 'wait'); // 72h window
  assert.equal(view(early).required_approvals, 2);
  const ready = run(snapshot(272, { openPulls: [PR({ files, policyAtHead: raw, reviews })] }));
  assert.deepEqual(merges(ready.actions), [{ type: 'merge', number: 20, sha: 'head20', title: 'Change 20', amendment: true, author: 'bob', closes: [] }]);
  assert.ok(ready.actions.some((a) => a.type === 'labels' && a.add.includes('amendment')));
});

test('amendments outside the hard limits are blocked and logged', () => {
  const raw = policyWith((y) => y.replace('hours: 48', 'hours: 0'));
  const r = run(snapshot(300, { openPulls: [PR({ files: [{ path: 'policy.yaml', previousPath: null }], policyAtHead: raw })] }));
  assert.equal(cond(r, 'amendment_valid')?.verdict, 'block');
  assert.ok(r.events.some((e) => e.incident === 'amendment_invalid'));
});

test('amendments may not carry other changes', () => {
  const files = [{ path: 'policy.yaml', previousPath: null }, { path: 'src/a.js', previousPath: null }];
  const r = run(snapshot(300, { openPulls: [PR({ files, policyAtHead: LAUNCH_POLICY })] }));
  assert.equal(cond(r, 'amendment_scope')?.verdict, 'block');
});

test('ready PRs are offered for merging lowest number first; the adapter merges at most one', () => {
  const r = run(snapshot(300, { openPulls: [pull(31, 200, { author: 'carol' }), pull(30, 200, { author: 'dave' })] }));
  assert.deepEqual(merges(r.actions).map((m) => m.number), [30, 31]);
});

test('a PR whose merge keeps failing goes to the back of the queue', () => {
  const log = [{ id: 'merge-failed:30:head30:x', type: 'merge_failed', at: at(290), actor: null, item: 30, data: { head: 'head30' } }];
  const r = run(snapshot(300, { openPulls: [pull(31, 200, { author: 'carol' }), pull(30, 200, { author: 'dave' })], log }));
  assert.deepEqual(merges(r.actions).map((m) => m.number), [31, 30]);
});

test('drafts, conflicts and other base branches do not merge', () => {
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ draft: true })] })), 'draft')?.verdict, 'wait');
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ mergeable: false })] })), 'mergeable')?.verdict, 'block');
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ mergeable: null })] })), 'mergeable')?.verdict, 'wait');
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ baseRef: 'data' })] })), 'base')?.verdict, 'block');
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ filesTruncated: true })] })), 'files')?.verdict, 'block');
});

test('require_up_to_date, when switched on, blocks PRs behind main', () => {
  const policyHistory = [{ sha: 'p', committedAt: at(-1), raw: LAUNCH_POLICY.replace('require_up_to_date: false', 'require_up_to_date: true') }];
  assert.equal(cond(run(snapshot(300, { policyHistory, openPulls: [PR({ behindBy: 2 })] })), 'up_to_date')?.verdict, 'block');
  assert.equal(cond(run(snapshot(300, { policyHistory, openPulls: [PR({ behindBy: null })] })), 'up_to_date')?.verdict, 'wait');
  assert.equal(cond(run(snapshot(300, { openPulls: [PR({ behindBy: 2 })] })), 'up_to_date'), undefined);
});

test('require_task_link, when on, needs a task the author holds', () => {
  const policyHistory = [{ sha: 'p', committedAt: at(-1), raw: LAUNCH_POLICY.replace('require_task_link: false', 'require_task_link: true') }];
  const task = issue(5, '[task] x', 190, { comments: [comment('bob', '/claim', 195)] });
  const linked = run(snapshot(230, { policyHistory, issues: [task], openPulls: [PR({ body: 'Closes #5' })] }));
  assert.equal(cond(linked, 'task_link')?.verdict, 'pass');
  const unlinked = run(snapshot(230, { policyHistory, issues: [task], openPulls: [PR({ body: 'misc' })] }));
  assert.equal(cond(unlinked, 'task_link')?.verdict, 'block');
});

test('an unchanged gate check is not rewritten', () => {
  const snap = snapshot(230, { openPulls: [PR({ comments: [comment('carol', '/object x', 210)] })] });
  const again = run(afterApplying(snap));
  assert.equal(checkOf(again.actions), undefined);
});

test('an over-long gate summary is cut to GitHub\'s limit once, not rewritten every run', () => {
  const files = Array.from({ length: 2000 }, (_, i) => ({ path: `.github/very/long/path/number/${i}/that/keeps/going/and/going.yml`, previousPath: null }));
  const snap = snapshot(300, { openPulls: [PR({ files })] });
  const first = run(snap);
  assert.ok(checkOf(first.actions)!.summary.length <= CHECK_SUMMARY_MAX);
  assert.equal(checkOf(run(afterApplying(snap, first)).actions), undefined);
});

test('a changed outcome creates a new check run instead of editing the old one', () => {
  const r = run(snapshot(300, { openPulls: [PR({ gateCheck: { id: 7, status: 'in_progress', conclusion: null, title: 'old', summary: 'old' } })] }));
  assert.equal(checkOf(r.actions)?.existingId, null);
  const textOnly = run(snapshot(210, { openPulls: [PR({ gateCheck: { id: 7, status: 'in_progress', conclusion: null, title: 'old', summary: 'old' } })] }));
  assert.equal(checkOf(textOnly.actions)?.existingId, 7);
});

test('re-approving after a push counts for the new head', () => {
  const comments = [comment('carol', '/approve', 190), comment('carol', '/approve', 205)];
  const r = run(snapshot(300, { mergedPulls: postGenesis(), openPulls: [PR({ comments })] }));
  assert.deepEqual(view(r).approvals, ['carol']);
});

test('a first-time contributor\'s CI run is approved by the referee, unless the PR touches protected paths', () => {
  const waiting = (extra: Partial<OpenPull> = {}) => snapshot(205, { openPulls: [PR({ checks: [], ...extra })], ciRuns: [push(20, 'head20', 200, { id: 77, awaitingApproval: true })] });
  const r = run(waiting());
  assert.deepEqual(r.actions.filter((a) => a.type === 'approve_run'), [{ type: 'approve_run', number: 20, runId: 77 }]);
  assert.equal(run(waiting({ files: [{ path: '.github/workflows/x.yml', previousPath: null }] })).actions.some((a) => a.type === 'approve_run'), false);
  assert.equal(run(waiting({ author: 'founder' })).actions.some((a) => a.type === 'approve_run'), false);
  assert.equal(run(waiting({ headSha: 'moved-on' })).actions.some((a) => a.type === 'approve_run'), false);
});

test('a title or description edit starts a new revision: the window restarts from it', () => {
  // Pushed at 200; description edited at 215: the window runs to 239, not 224.
  const waiting = run(snapshot(230, { openPulls: [PR({ edits: [at(215)] })] }));
  assert.equal(cond(waiting, 'window')?.verdict, 'wait');
  assert.match(cond(waiting, 'window')!.detail, /from the latest title or description edit/);
  assert.equal(view(waiting).window_ends_at, at(239));
  assert.equal(merges(waiting.actions).length, 0);
  assert.equal(merges(run(snapshot(239, { openPulls: [PR({ edits: [at(215)] })] })).actions).length, 1);
  // An edit before the latest push changes nothing.
  assert.equal(view(run(snapshot(230, { openPulls: [PR({ edits: [at(150)] })] }))).window_ends_at, at(224));
});

test('without the edit history the window waits', () => {
  const r = run(snapshot(300, { openPulls: [PR({ edits: null })] }));
  assert.equal(cond(r, 'window')?.verdict, 'wait');
  assert.match(cond(r, 'window')!.detail, /edit history/);
  assert.equal(merges(r.actions).length, 0);
});

test('approvals given before a title or description edit do not count', () => {
  const base = { mergedPulls: postGenesis() };
  const edits = [at(220)];
  const old = run(snapshot(300, { ...base, openPulls: [PR({ edits, comments: [comment('carol', '/approve', 210)], reviews: [review('dave', 'APPROVED', 'head20', 210)] })] }));
  assert.deepEqual(view(old).approvals, []);
  assert.equal(cond(old, 'approvals')?.verdict, 'wait');
  const fresh = run(snapshot(300, { ...base, openPulls: [PR({ edits, comments: [comment('carol', '/approve', 221)], reviews: [review('dave', 'APPROVED', 'head20', 221)] })] }));
  assert.deepEqual(view(fresh).approvals, ['carol', 'dave']);
});

test('a review of head A does not count after A, B, then A again', () => {
  const ciRuns = [push(20, 'head20', 200), push(20, 'yyy', 210), push(20, 'head20', 230)];
  const base = { mergedPulls: postGenesis(), ciRuns };
  const stale = run(snapshot(300, { ...base, openPulls: [PR({ reviews: [review('carol', 'APPROVED', 'head20', 205)] })] }));
  assert.deepEqual(view(stale).approvals, []);
  assert.equal(merges(stale.actions).length, 0);
  // A review of A after it became the head again counts.
  const again = run(snapshot(300, { ...base, openPulls: [PR({ reviews: [review('carol', 'APPROVED', 'head20', 205), review('carol', 'APPROVED', 'head20', 231)] })] }));
  assert.deepEqual(view(again).approvals, ['carol']);
  // An old CHANGES_REQUESTED doesn't cancel a later /approve either; only reviews of this revision count.
  const oldVeto = run(snapshot(300, { ...base, openPulls: [PR({ reviews: [review('carol', 'CHANGES_REQUESTED', 'head20', 205)], comments: [comment('carol', '/approve', 240)] })] }));
  assert.deepEqual(view(oldVeto).approvals, ['carol']);
});

test('a review given before the reviewer had standing does not count, even once they have it', () => {
  // Zed approves at 230; Zed's first PR merges at 240. The review is judged at 230.
  const mergedPulls = [...postGenesis(), merged(950, 'zed', 240)];
  const r = run(snapshot(300, { mergedPulls, openPulls: [PR({ reviews: [review('zed', 'APPROVED', 'head20', 230)] })] }));
  assert.deepEqual(view(r).approvals, []);
  const later = run(snapshot(300, { mergedPulls, openPulls: [PR({ reviews: [review('zed', 'APPROVED', 'head20', 230), review('zed', 'APPROVED', 'head20', 241)] })] }));
  assert.deepEqual(view(later).approvals, ['zed']);
});
