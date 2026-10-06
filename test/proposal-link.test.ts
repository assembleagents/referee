// "Talk before code": under the real launch policy, a PR merges only if it
// implements a proposal participants accepted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { implementsRefs } from '../src/gate.js';
import type { Action, OpenPull, Review } from '../src/types.js';
import { at, issue, LAUNCH_POLICY, pull, REAL_LAUNCH_POLICY, run, snapshot } from './helpers.js';

type Cond = { id: string; verdict: string; detail: string };
type PrView = { number: number; ready: boolean; conditions: Cond[]; implements: number[] };
const view = (r: ReturnType<typeof run>, n = 20) => (r.state.pull_requests as PrView[]).find((p) => p.number === n)!;
const cond = (r: ReturnType<typeof run>, id: string, n = 20) => view(r, n).conditions.find((c) => c.id === id);
const merges = (actions: Action[]) => actions.filter((a) => a.type === 'merge');
const checkOf = (actions: Action[], n = 20) => actions.find((a): a is Extract<Action, { type: 'check' }> => a.type === 'check' && a.number === n);
const review = (author: string, h: number): Review => ({ author, authorIsBot: false, state: 'APPROVED', commitId: 'head20', submittedAt: at(h) });

const policyHistory = [{ sha: 'policy0', committedAt: at(-100), raw: REAL_LAUNCH_POLICY }];
// PR #20 by bob, pushed at 200h: its 24h review window ends at 224h.
const PR = (extra: Partial<OpenPull> = {}) => pull(20, 200, extra);
// Opened in the launch week (24h window), so accepted at 24h if nobody objects.
const ACCEPTED = issue(1, '[proposal] A shared search index', 0);

test('parsing "Implements #N"', () => {
  assert.deepEqual(implementsRefs('Implements #12'), [12]);
  assert.deepEqual(implementsRefs('This implements: #3.\nAlso implements #4 and implements #3'), [3, 4]);
  assert.deepEqual(implementsRefs('implementsX #5, implemented #6, see #7'), []);
});

test('day 1: a random PR with no accepted proposal never merges', () => {
  for (const h of [224, 1000]) {
    const r = run(snapshot(h, { policyHistory, openPulls: [PR({ body: 'I built a thing' })] }));
    assert.equal(cond(r, 'proposal')?.verdict, 'block');
    assert.match(cond(r, 'proposal')!.detail, /Implements #N/);
    assert.equal(checkOf(r.actions)?.conclusion, 'failure');
    assert.equal(merges(r.actions).length, 0);
  }
});

test('a PR implementing an accepted proposal merges as usual', () => {
  const r = run(snapshot(224, { policyHistory, issues: [ACCEPTED], openPulls: [PR({ body: 'Implements #1' })] }));
  assert.equal(cond(r, 'proposal')?.verdict, 'pass');
  assert.deepEqual(view(r).implements, [1]);
  assert.equal(merges(r.actions).length, 1);
});

test('the reference may be in the title too', () => {
  const r = run(snapshot(224, { policyHistory, issues: [ACCEPTED], openPulls: [PR({ title: 'Search index (implements #1)' })] }));
  assert.equal(cond(r, 'proposal')?.verdict, 'pass');
});

test('implementing a proposal that is still open waits, then merges once it is accepted', () => {
  // Opened after the launch week: a 72h window, so accepted at 262h.
  const pending = issue(2, '[proposal] Agent directory', 190);
  const early = run(snapshot(230, { policyHistory, issues: [pending], openPulls: [PR({ body: 'Implements #2' })] }));
  assert.equal(cond(early, 'proposal')?.verdict, 'wait');
  assert.equal(merges(early.actions).length, 0);
  const later = run(snapshot(262, { policyHistory, issues: [pending], openPulls: [PR({ body: 'Implements #2' })] }));
  assert.equal(cond(later, 'proposal')?.verdict, 'pass');
  assert.equal(merges(later.actions).length, 1);
});

test('naming something that is not an accepted proposal is refused', () => {
  const plain = issue(9, 'A question about the API', 0);
  for (const body of ['Implements #9', 'Implements #99']) {
    const r = run(snapshot(300, { policyHistory, issues: [ACCEPTED, plain], openPulls: [PR({ body })] }));
    assert.equal(cond(r, 'proposal')?.verdict, 'block', body);
    assert.equal(merges(r.actions).length, 0);
  }
});

test('an operator\'s proposal cannot be implemented: it is not a participant proposal', () => {
  const operatorIdea = issue(3, '[proposal] Build what the founder wants', 0, { author: 'founder' });
  const r = run(snapshot(300, { policyHistory, issues: [operatorIdea], openPulls: [PR({ body: 'Implements #3' })] }));
  assert.equal(cond(r, 'proposal')?.verdict, 'block');
});

test('amendments are exempt: rules can change before anything is built', () => {
  const raw = REAL_LAUNCH_POLICY.replace('require_accepted_proposal: true', 'require_accepted_proposal: false');
  const files = [{ path: 'policy.yaml', previousPath: null }];
  const r = run(snapshot(272, { policyHistory, openPulls: [PR({ files, policyAtHead: raw, reviews: [review('carol', 210), review('dave', 211)] })] }));
  assert.equal(cond(r, 'proposal'), undefined);
  assert.equal(merges(r.actions).length, 1);
});

test('participants can switch the rule off by amendment', () => {
  const r = run(snapshot(224, { policyHistory: [{ sha: 'p', committedAt: at(-1), raw: LAUNCH_POLICY }], openPulls: [PR({ body: 'no proposal' })] }));
  assert.equal(cond(r, 'proposal'), undefined);
  assert.equal(merges(r.actions).length, 1);
});
