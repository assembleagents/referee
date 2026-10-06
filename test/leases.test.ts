import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closingRefs, dependsOn, leaseExpiry, MAX_LEASE_PERIODS } from '../src/leases.js';
import type { RefEvent } from '../src/types.js';
import { afterApplying, at, comment, eventsOf, H, issue, LAUNCH_POLICY, merged, policyWith, pull, push, run, snapshot } from './helpers.js';

const T = (number: number, comments: ReturnType<typeof comment>[] = [], extra = {}) =>
  issue(number, `[task] Task ${number}`, 200, { comments, ...extra });

type TaskView = { number: number; status: string; holder: string | null; lease_expires_at: string | null };
const taskView = (r: ReturnType<typeof run>, n: number) => (r.state.tasks as TaskView[]).find((t) => t.number === n);
const rejectedFor = (r: ReturnType<typeof run>, actor: string) => r.events.filter((e) => e.type === 'command_rejected' && e.actor === actor);
const pushed = (pr: number, h: number, actor: string, closes: number[]): RefEvent => ({ id: `push:${pr}:${h}`, type: 'pr_pushed', at: at(h), actor, item: pr, data: { sha: `s${h}`, suite: null, closes } });

test('parsing closing references and dependencies', () => {
  assert.deepEqual(closingRefs('Closes #5 and fixes #7. Resolves: #9. see #11'), [5, 7, 9]);
  assert.deepEqual(closingRefs('closed #3, FIXED #4'), [3, 4]);
  assert.deepEqual(dependsOn('Build the API\nDepends-on: #2, #3\ndepends on: #4'), [2, 3, 4]);
  assert.deepEqual(dependsOn('no deps here, #2'), []);
});

test('closing references and dependencies parse long hostile bodies in linear time', () => {
  const started = Date.now();
  closingRefs(`closes${' '.repeat(65_000)}x`);
  closingRefs(`fix:${' \t'.repeat(30_000)}y`.repeat(2));
  dependsOn('\n'.repeat(65_000));
  dependsOn(`depends${' -'.repeat(30_000)}`);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test('lease expiry is extended by activity before each deadline', () => {
  assert.equal(leaseExpiry(0, 48, []), 48 * H);
  assert.equal(leaseExpiry(0, 48, [10 * H]), 58 * H);
  assert.equal(leaseExpiry(0, 48, [10 * H, 50 * H]), 98 * H);
  assert.equal(leaseExpiry(0, 48, [50 * H, 10 * H]), 98 * H); // order doesn't matter
  assert.equal(leaseExpiry(0, 48, [60 * H]), 48 * H); // too late: already expired
});

test('a lease can never be extended past MAX_LEASE_PERIODS periods', () => {
  // A commit every 40h would extend forever without the cap.
  const pushes = Array.from({ length: 50 }, (_, i) => (i + 1) * 40 * H);
  assert.equal(leaseExpiry(0, 48, pushes), MAX_LEASE_PERIODS * 48 * H);
});

test('first /claim wins; the second is told who holds it', () => {
  const r = run(snapshot(210, { issues: [T(5, [comment('bob', '/claim', 201), comment('carol', '/claim', 202)])] }));
  assert.deepEqual(taskView(r, 5), { ...taskView(r, 5), status: 'claimed', holder: 'bob', lease_expires_at: at(249) });
  assert.equal(rejectedFor(r, 'carol').length, 1);
  assert.ok(r.actions.some((a) => a.type === 'labels' && a.number === 5 && a.add.includes('claimed')));
  assert.ok(r.actions.some((a) => a.type === 'assignees' && a.add.includes('bob')));
});

test('simultaneous claims are ordered deterministically by comment id', () => {
  const first = comment('bob', '/claim', 201);
  const second = comment('carol', '/claim', 201);
  const r = run(snapshot(210, { issues: [T(5, [second, first])] }));
  assert.equal(taskView(r, 5)?.holder, 'bob');
});

test('an expired lease is logged as abandoned work and the task reopens', () => {
  const r = run(snapshot(249, { issues: [T(5, [comment('bob', '/claim', 201)], { labels: ['task', 'claimed'], assignees: ['bob'] })] }));
  assert.equal(taskView(r, 5)?.status, 'available');
  const ev = r.events.find((e) => e.type === 'lease_expired');
  assert.equal(ev?.incident, 'abandoned_work');
  assert.equal(ev?.at, at(249));
  assert.ok(r.actions.some((a) => a.type === 'labels' && a.remove.includes('claimed')));
  assert.ok(r.actions.some((a) => a.type === 'assignees' && a.remove.includes('bob')));
});

test('after expiry another agent can claim, but the same agent waits out the cooldown', () => {
  const comments = [comment('bob', '/claim', 201), comment('bob', '/claim', 250), comment('carol', '/claim', 251)];
  const r = run(snapshot(252, { issues: [T(5, comments)] }));
  assert.equal(rejectedFor(r, 'bob').length, 1);
  assert.equal(taskView(r, 5)?.holder, 'carol');
});

test('/release frees the task immediately; only the holder can release', () => {
  const comments = [comment('bob', '/claim', 201), comment('carol', '/release', 205), comment('bob', '/release', 210), comment('carol', '/claim', 211)];
  const r = run(snapshot(212, { issues: [T(5, comments)] }));
  assert.equal(rejectedFor(r, 'carol').length, 1);
  assert.equal(taskView(r, 5)?.holder, 'carol');
  assert.ok(!r.events.some((e) => e.type === 'lease_expired'));
});

test('an agent can hold at most max_active_per_agent leases', () => {
  const issues = [T(5, [comment('bob', '/claim', 201)]), T(6, [comment('bob', '/claim', 202)]), T(7, [comment('bob', '/claim', 203)])];
  const r = run(snapshot(210, { issues }));
  assert.equal(taskView(r, 7)?.status, 'available');
  assert.equal(rejectedFor(r, 'bob').length, 1);
});

test('opening and pushing to a linked PR keeps the lease alive, by GitHub\'s clock', () => {
  const pr = pull(20, 230, { author: 'bob', body: 'Implements the index.\n\nCloses #5' });
  const r = run(snapshot(300, { issues: [T(5, [comment('bob', '/claim', 201)])], openPulls: [pr], ciRuns: [push(20, 'a', 230), push(20, 'b', 270)] }));
  assert.equal(taskView(r, 5)?.lease_expires_at, at(318)); // 230+48=278, then 270+48=318
  assert.equal(taskView(r, 5)?.holder, 'bob');
});

test('every push counts, not just the newest: a late run never backdates an expiry', () => {
  // Claimed at 205 (due 253); pushes at 240 (-> 288) and 280 (-> 328). A run at 285 must not expire it at 253.
  const pr = pull(20, 206, { author: 'bob', body: 'Closes #5' });
  const issues = [T(5, [comment('bob', '/claim', 205)])];
  const r = run(snapshot(285, { issues, openPulls: [pr], ciRuns: [push(20, 'a', 206), push(20, 'b', 240), push(20, 'c', 280)] }));
  assert.equal(eventsOf(r, 'lease_expired').length, 0);
  assert.equal(taskView(r, 5)?.lease_expires_at, at(328));
});

test('pushes recorded while the PR was open still count after it closes', () => {
  const log = [pushed(20, 230, 'bob', [5]), pushed(20, 270, 'bob', [5])];
  const r = run(snapshot(300, { issues: [T(5, [comment('bob', '/claim', 201)])], log }));
  assert.equal(taskView(r, 5)?.lease_expires_at, at(318));
});

test('a PR by someone else does not extend the holder\'s lease', () => {
  const pr = pull(20, 230, { author: 'carol', body: 'Closes #5' });
  const r = run(snapshot(250, { issues: [T(5, [comment('bob', '/claim', 201)])], openPulls: [pr], ciRuns: [push(20, 'a', 240)] }));
  assert.equal(taskView(r, 5)?.status, 'available');
});

test('a push before the PR said it closes the task does not count for that task', () => {
  const log = [pushed(20, 230, 'bob', []), pushed(20, 260, 'bob', [5])];
  const r = run(snapshot(300, { issues: [T(5, [comment('bob', '/claim', 201)])], log }));
  assert.ok(eventsOf(r, 'lease_expired').some((e) => e.at === at(249)));
});

test('finished work ends the lease as done, never as abandoned', () => {
  // Bob's PR merged at 260 (it had extended the lease to 278 by opening at 230); GitHub closed the task at 260.
  const log = [pushed(20, 230, 'bob', [5]), { id: 'merge:m1', type: 'pr_merged', at: at(260), actor: 'bob', item: 20, data: { closes: [5] } }];
  const task = T(5, [comment('bob', '/claim', 201)], { state: 'closed', closedAt: at(260) });
  const r = run(snapshot(400, { issues: [task], mergedPulls: [merged(20, 'bob', 260, 'Closes #5')], log }));
  assert.equal(eventsOf(r, 'lease_expired').length, 0);
  assert.deepEqual(eventsOf(r, 'lease_ended').map((e) => [e.at, e.data?.reason]), [[at(260), 'done']]);
  assert.ok(!r.actions.some((a) => a.type === 'comment' && a.body.includes('available again')));
});

test('the lease ends as done when the PR merges, even if GitHub did not close the task', () => {
  const r = run(snapshot(400, { issues: [T(5, [comment('bob', '/claim', 201)])], mergedPulls: [merged(20, 'carol', 240, 'Closes #5')] }));
  assert.deepEqual(eventsOf(r, 'lease_ended').map((e) => e.data?.reason), ['done']);
  assert.equal(eventsOf(r, 'lease_expired').length, 0);
  assert.equal(taskView(r, 5)?.status, 'available');
});

test('verification uses the references frozen at merge, not the PR body as edited later', () => {
  const log = [{ id: 'merge:m1', type: 'pr_merged', at: at(240), actor: 'carol', item: 20, data: { closes: [5] } }];
  const r = run(snapshot(400, { issues: [T(5)], mergedPulls: [merged(20, 'carol', 240, 'edited after merge: nothing here')], log }));
  assert.ok(eventsOf(r, 'task_verified').some((e) => e.item === 5));
  const forged = run(snapshot(400, { issues: [T(6)], mergedPulls: [merged(21, 'carol', 240, 'Closes #6')], log: [{ id: 'merge:m2', type: 'pr_merged', at: at(240), actor: 'carol', item: 21, data: { closes: [] } }] }));
  assert.equal(eventsOf(forged, 'task_verified').length, 0);
});

test('closing the task ends the lease without an incident', () => {
  const r = run(snapshot(300, { issues: [T(5, [comment('bob', '/claim', 201)], { state: 'closed', closedAt: at(220) })] }));
  assert.ok(!r.events.some((e) => e.type === 'lease_expired'));
  assert.deepEqual(eventsOf(r, 'lease_ended').map((e) => e.data?.reason), ['closed']);
});

test('a recorded expiry is final, even if activity before it shows up later', () => {
  const claim = comment('bob', '/claim', 201);
  const log = [{ id: `lease-expired:5:${claim.id}`, type: 'lease_expired', at: at(249), actor: 'bob', item: 5 }, pushed(20, 240, 'bob', [5])];
  const r = run(snapshot(300, { issues: [T(5, [claim])], log }));
  assert.equal(taskView(r, 5)?.status, 'available');
});

test('a recorded close of the lease is final, even after the task is reopened', () => {
  const claim = comment('bob', '/claim', 201);
  const log = [{ id: `lease-ended:5:${claim.id}`, type: 'lease_ended', at: at(220), actor: 'bob', item: 5, data: { reason: 'closed' } }];
  const r = run(snapshot(300, { issues: [T(5, [claim], { stateReason: 'reopened' })], log }));
  assert.equal(taskView(r, 5)?.status, 'available');
  assert.equal(eventsOf(r, 'lease_expired').length, 0);
});

test('a recorded claim stands even after its comment is edited or deleted', () => {
  const claim = comment('bob', '/claim', 201);
  const snap = snapshot(210, { issues: [T(5, [claim])] });
  const recorded = afterApplying(snap);
  const edited = run({ ...recorded, issues: recorded.issues.map((i) => ({ ...i, comments: i.comments.map((c) => (c.id === claim.id ? { ...c, body: 'never mind', updatedAt: at(209) } : c)) })) });
  assert.equal(taskView(edited, 5)?.holder, 'bob');
  const deleted = run({ ...recorded, issues: recorded.issues.map((i) => ({ ...i, comments: i.comments.filter((c) => c.id !== claim.id) })) });
  assert.equal(taskView(deleted, 5)?.holder, 'bob');
  assert.deepEqual(deleted.events, []);
});

test('a lease keeps the terms in force when it was granted', () => {
  const longer = policyWith((y) => y.replace('hours: 48', 'hours: 100'));
  const policyHistory = [{ sha: 'p1', committedAt: at(-1), raw: LAUNCH_POLICY }, { sha: 'p2', committedAt: at(210), raw: longer }]; // in force from 234
  const r = run(snapshot(240, { policyHistory, issues: [T(5, [comment('bob', '/claim', 201)]), T(6, [comment('carol', '/claim', 235)])] }));
  assert.equal(taskView(r, 5)?.lease_expires_at, at(249)); // claimed under the 48h rule
  assert.equal(taskView(r, 6)?.lease_expires_at, at(335)); // claimed under the 100h rule
});

test('with dependencies enforced, a task is claimable only after its dependency is verified', () => {
  const policy = LAUNCH_POLICY.replace('enforce: false', 'enforce: true');
  const policyHistory = [{ sha: 'p', committedAt: at(-1), raw: policy }];
  const dep = T(5, [], { state: 'closed', closedAt: at(260), stateReason: 'completed' });
  const t6 = T(6, [comment('bob', '/claim', 210), comment('carol', '/claim', 261)], { body: 'Depends-on: #5' });
  const before = run(snapshot(220, { issues: [T(5), t6], policyHistory }));
  assert.equal(taskView(before, 6)?.status, 'available');
  assert.ok(before.actions.some((a) => a.type === 'labels' && a.number === 6 && a.add.includes('blocked')));
  const after = run(snapshot(262, { issues: [dep, t6], policyHistory, mergedPulls: [merged(30, 'dave', 260, 'Closes #5')] }));
  assert.equal(taskView(after, 6)?.holder, 'carol');
  assert.equal(rejectedFor(after, 'bob').length, 1);
});

test('dependencies are ignored while enforcement is off', () => {
  const r = run(snapshot(220, { issues: [T(5), T(6, [comment('bob', '/claim', 210)], { body: 'Depends-on: #5' })] }));
  assert.equal(taskView(r, 6)?.holder, 'bob');
});

test('claiming a closed task is rejected', () => {
  const r = run(snapshot(300, { issues: [T(5, [comment('bob', '/claim', 230)], { state: 'closed', closedAt: at(220) })] }));
  assert.equal(rejectedFor(r, 'bob').length, 1);
});

test('proposal commands on a task are rejected with guidance', () => {
  const r = run(snapshot(210, { issues: [T(5, [comment('bob', '/object nope', 201)])] }));
  assert.equal(rejectedFor(r, 'bob').length, 1);
});
