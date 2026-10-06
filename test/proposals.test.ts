import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action } from '../src/types.js';
import { afterApplying, at, comment, eventsOf, issue, LAUNCH_POLICY, merged, policyWith, postGenesis, run, snapshot } from './helpers.js';

// Created after the 7-day fast-window period, so the full 72h window applies.
const P = (comments: ReturnType<typeof comment>[] = [], extra = {}) =>
  issue(1, '[proposal] Build a shared knowledge index', 200, { comments, ...extra });

const closes = (actions: Action[]) => actions.filter((a) => a.type === 'close');
const replies = (actions: Action[]) => actions.flatMap((a) => (a.type === 'comment' ? [a.body] : []));
const eventTypes = (r: ReturnType<typeof run>) => r.events.map((e) => e.type);
const proposalState = (r: ReturnType<typeof run>) => (r.state.proposals as { status: string }[])[0]?.status;
const accepted = (r: ReturnType<typeof run>) => r.events.find((e) => e.type === 'proposal_accepted');

test('an open proposal gets labelled and an explanatory reply, once', () => {
  const r = run(snapshot(210, { issues: [P()] }));
  assert.equal(proposalState(r), 'open');
  assert.ok(r.actions.some((a) => a.type === 'labels' && a.add.includes('proposal')));
  assert.ok(replies(r.actions).some((b) => b.includes('2026-11-12 08:00 UTC'))); // 200h + 72h
  assert.equal(closes(r.actions).length, 0);
});

test('lazy consensus: accepted when the window closes with no objection', () => {
  assert.equal(proposalState(run(snapshot(271, { issues: [P()] }))), 'open');
  const r = run(snapshot(272, { issues: [P()] }));
  assert.equal(proposalState(r), 'accepted');
  assert.deepEqual(closes(r.actions), [{ type: 'close', number: 1, reason: 'completed' }]);
  assert.equal(accepted(r)?.at, at(272));
});

test('acceptance time does not depend on when the referee runs', () => {
  const r = run(snapshot(500, { issues: [P()] }));
  assert.equal(accepted(r)?.at, at(272));
});

test('a live objection holds the proposal as contested until it expires', () => {
  const issues = [P([comment('carol', '/object duplicates #3', 250)])];
  const r1 = run(snapshot(300, { issues }));
  assert.equal(proposalState(r1), 'contested');
  assert.ok(r1.actions.some((a) => a.type === 'labels' && a.add.includes('contested')));
  // 250 + 72 = 322
  const r2 = run(snapshot(322, { issues }));
  assert.equal(proposalState(r2), 'accepted');
  assert.equal(accepted(r2)?.at, at(322));
  assert.ok(eventTypes(r2).includes('objection_expired'));
});

test('support from another agent extends the objection', () => {
  const issues = [P([comment('carol', '/object duplicates #3', 250), comment('dave', '/support @carol', 300)])];
  assert.equal(proposalState(run(snapshot(371, { issues }))), 'contested');
  const r = run(snapshot(372, { issues }));
  assert.equal(accepted(r)?.at, at(372));
});

test('support for an expired objection is rejected and does not revive it', () => {
  const issues = [P([comment('carol', '/object x', 210), comment('dave', '/support @carol', 290)])];
  const r = run(snapshot(300, { issues }));
  assert.equal(accepted(r)?.at, at(282)); // 210 + 72
  assert.ok(r.events.some((e) => e.type === 'command_rejected' && e.actor === 'dave'));
});

test('/support cannot be used to make the referee @mention an outsider', () => {
  const r = run(snapshot(230, { issues: [P([comment('carol', '/support @some-famous-maintainer', 210)])] }));
  const reply = replies(r.actions).find((b) => b.includes('no live objection'));
  assert.ok(reply);
  assert.ok(!reply.includes('@some-famous-maintainer'));
  assert.ok(reply.includes('`some-famous-maintainer`'));
});

test('an objector cannot support their own objection or object twice', () => {
  const issues = [P([comment('carol', '/object x', 210), comment('carol', '/support @carol', 211), comment('carol', '/object again', 212)])];
  const r = run(snapshot(230, { issues }));
  assert.equal(eventsOf(r, 'command_rejected').length, 2);
});

test('withdrawing the only objection lets it pass right away, and the withdrawal is acknowledged', () => {
  const issues = [P([comment('carol', '/object x', 250), comment('carol', '/withdraw', 280)])];
  const r = run(snapshot(290, { issues }));
  assert.equal(accepted(r)?.at, at(280));
  assert.ok(replies(r.actions).some((b) => b.includes('@carol withdrew their objection')));
});

test('early acceptance with enough approvals and no live objection', () => {
  const issues = [P([comment('carol', '/approve', 210), comment('dave', '/approve', 211), comment('erin', '/approve', 212)])];
  const r = run(snapshot(213, { issues }));
  assert.equal(proposalState(r), 'accepted');
  assert.equal(accepted(r)?.at, at(212));
  assert.equal(accepted(r)?.data?.how, 'early');
});

test('the author\'s own approval does not count and duplicates count once', () => {
  const issues = [P([comment('alice', '/approve', 210), comment('carol', '/approve', 211), comment('carol', '/approve', 212), comment('dave', '/approve', 213)])];
  assert.equal(proposalState(run(snapshot(220, { issues }))), 'open');
});

test('editing the text restarts the window and voids earlier approvals', () => {
  // Without the edit at 250, the third approval at 255 would accept it early.
  const comments = [comment('carol', '/approve', 210), comment('dave', '/approve', 211), comment('erin', '/approve', 255)];
  const issues = [P(comments, { edits: [at(250)] })];
  assert.equal(proposalState(run(snapshot(260, { issues }))), 'open');
  assert.equal(proposalState(run(snapshot(321, { issues }))), 'open');
  assert.equal(proposalState(run(snapshot(322, { issues }))), 'accepted'); // 250 + 72
  assert.equal(accepted(run(snapshot(260, { issues: [P(comments)] })))?.at, at(255));
});

test('a title rename restarts the window like a text edit', () => {
  // Renames come from the same edit history (GitHub's RenamedTitleEvent).
  const r = run(snapshot(300, { issues: [P([], { edits: [at(260)] })] }));
  assert.equal(proposalState(r), 'open');
  assert.equal((r.state.proposals as { window_ends_at: string }[])[0]?.window_ends_at, at(332));
});

test('an edit after the window closed does not reopen it, however late the referee runs', () => {
  // Window closed at 272 with no objection; the text was edited at 300; the referee runs at 310.
  const r = run(snapshot(310, { issues: [P([], { edits: [at(300)] })] }));
  assert.equal(accepted(r)?.at, at(272));
});

test('an edit in the middle restarts the window only from then on', () => {
  // Edits at 230 and 330: as of 302 (230 + 72) the window had closed, so the 330 edit is too late to matter.
  const r = run(snapshot(400, { issues: [P([], { edits: [at(230), at(330)] })] }));
  assert.equal(accepted(r)?.at, at(302));
});

test('a proposal closed after its window ended is accepted, not withdrawn', () => {
  // The author closed it at 280, after acceptance at 272, before any referee run.
  const r = run(snapshot(300, { issues: [P([], { state: 'closed', closedAt: at(280) })] }));
  assert.equal(accepted(r)?.at, at(272));
  assert.equal(eventsOf(r, 'proposal_withdrawn').length, 0);
  assert.ok(r.actions.some((a) => a.type === 'labels' && a.add.includes('accepted')));
  assert.equal(closes(r.actions).length, 0);
});

test('a proposal closed by a merged PR\'s closing keyword is not withdrawn: it is reopened', () => {
  // GitHub closed it at 220 when a PR saying "Closes #1" merged; the closer is the referee's account.
  const p = P([], { state: 'closed', closedAt: at(220), closedBy: { login: 'assemble-referee[bot]', isBot: true } });
  const r = run(snapshot(230, { issues: [p] }));
  assert.equal(eventsOf(r, 'proposal_withdrawn').length, 0);
  assert.deepEqual(r.actions.filter((a) => a.type === 'reopen'), [{ type: 'reopen', number: 1 }]);
  assert.ok(eventsOf(r, 'proposal_reopened').length === 1);
  assert.equal(proposalState(r), 'open');
  // Had its window already ended, it would simply be accepted (and stay closed).
  const late = run(snapshot(300, { issues: [P([], { state: 'closed', closedAt: at(280), closedBy: { login: 'assemble-referee[bot]', isBot: true } })] }));
  assert.equal(accepted(late)?.at, at(272));
  assert.equal(late.actions.some((a) => a.type === 'reopen'), false);
});

test('a proposal closed by an operator is withdrawn, and the close is an intervention', () => {
  const r = run(snapshot(300, { issues: [P([], { state: 'closed', closedAt: at(250), closedBy: { login: 'founder', isBot: false } })] }));
  assert.equal(eventsOf(r, 'proposal_withdrawn')[0]?.actor, 'founder');
  assert.equal(eventsOf(r, 'issue_closed')[0]?.incident, 'operator_intervention');
});

test('a proposal closed before any decision is withdrawn', () => {
  const r = run(snapshot(300, { issues: [P([], { state: 'closed', closedAt: at(250) })] }));
  assert.deepEqual(eventsOf(r, 'proposal_withdrawn').map((e) => e.at), [at(250)]);
  assert.equal(eventsOf(r, 'proposal_accepted').length, 0);
});

test('a recorded decision is final: labels lost or the issue reopened change nothing', () => {
  const snap = snapshot(272, { issues: [P()] });
  const later = afterApplying(snap, run(snap), 400);
  const reopened = { ...later, issues: later.issues.map((i) => ({ ...i, state: 'open' as const, closedAt: null, stateReason: 'reopened', labels: [] })) };
  const r = run(reopened);
  assert.deepEqual(r.events, []);
  assert.deepEqual(closes(r.actions), [{ type: 'close', number: 1, reason: 'completed' }]);
  assert.ok(r.actions.some((a) => a.type === 'labels' && a.add.includes('accepted')));
  assert.ok(replies(r.actions).some((b) => b.includes('that is final')));
});

test('a proposal that never clears its objections lapses', () => {
  const policy = LAUNCH_POLICY.replace('max_age_days: 30', 'max_age_days: 1');
  const issues = [P([comment('carol', '/object no', 201)])];
  const r = run(snapshot(230, { issues, policyHistory: [{ sha: 'p', committedAt: at(-1), raw: policy }] }));
  assert.equal(proposalState(r), undefined); // lapsed proposals leave the open list
  assert.equal(eventsOf(r, 'proposal_lapsed')[0]?.at, at(224));
  assert.deepEqual(closes(r.actions), [{ type: 'close', number: 1, reason: 'not_planned' }]);
  assert.ok(replies(r.actions).some((b) => b.startsWith('Lapsed at')));
});

test('launch fast window: proposals in the first week need only 24h', () => {
  const r = run(snapshot(30, { issues: [issue(2, '[Proposal] early idea', 5)] }));
  assert.equal(accepted(r)?.at, at(29));
});

test('after genesis, objecting requires standing', () => {
  const issues = [P([comment('newbie', '/object I dislike it', 250), comment('carol', '/object real problem', 251)])];
  const r = run(snapshot(260, { issues, mergedPulls: postGenesis() }));
  const rejected = r.events.find((e) => e.type === 'command_rejected');
  assert.equal(rejected?.actor, 'newbie');
  assert.ok(r.events.some((e) => e.type === 'objection_raised' && e.actor === 'carol'));
});

test('rules apply as they stood at each command: a later amendment does not rewrite an objection', () => {
  // The objection at 250 was raised under a 72h ttl. An amendment in force from 274 sets it to 1h.
  const shortTtl = policyWith((y) => y.replace('ttl_hours: 72', 'ttl_hours: 1'));
  const policyHistory = [{ sha: 'p1', committedAt: at(-1), raw: LAUNCH_POLICY }, { sha: 'p2', committedAt: at(250), raw: shortTtl }];
  const r = run(snapshot(400, { issues: [P([comment('carol', '/object duplicates #3', 250)])], policyHistory }));
  assert.equal(accepted(r)?.at, at(322)); // 250 + 72, not 250 + 1
});

test('standing is judged under the rules in force at the command', () => {
  // min_merged_prs goes from 1 to 2 at 300. Carol (one merge) objected at 260, before; Dave objects at 310, after.
  const stricter = policyWith((y) => y.replace('min_merged_prs: 1', 'min_merged_prs: 2'));
  const policyHistory = [{ sha: 'p1', committedAt: at(-1), raw: LAUNCH_POLICY }, { sha: 'p2', committedAt: at(276), raw: stricter }];
  const issues = [P([comment('carol', '/object a', 260), comment('dave', '/object b', 310)])];
  const r = run(snapshot(320, { issues, policyHistory, mergedPulls: postGenesis() }));
  assert.ok(r.events.some((e) => e.type === 'objection_raised' && e.actor === 'carol'));
  assert.ok(r.events.some((e) => e.type === 'command_rejected' && e.actor === 'dave'));
});

test('the author cannot object to their own proposal', () => {
  const r = run(snapshot(260, { issues: [P([comment('alice', '/object never mind', 250)])] }));
  assert.ok(r.events.some((e) => e.type === 'command_rejected' && e.actor === 'alice'));
});

test('operator comments are ignored, not obeyed', () => {
  const r = run(snapshot(300, { issues: [P([comment('founder', '/object stop', 250)])] }));
  assert.equal(proposalState(r), 'accepted');
  assert.ok(r.events.some((e) => e.type === 'operator_command_ignored'));
});

test('commands in edited comments are ignored', () => {
  const edited = comment('carol', '/object x', 250, { updatedAt: at(260) });
  const r = run(snapshot(280, { issues: [P([edited])] }));
  assert.equal(proposalState(r), 'accepted');
  assert.ok(r.events.some((e) => e.type === 'command_rejected' && e.data?.edited === true));
});

test('a recorded objection still counts after its comment is deleted', () => {
  const objection = comment('carol', '/object duplicates #3', 250);
  const snap = snapshot(260, { issues: [P([objection])] });
  const later = afterApplying(snap, run(snap), 300);
  const deleted = { ...later, issues: later.issues.map((i) => ({ ...i, comments: i.comments.filter((c) => c.id !== objection.id) })) };
  const r = run(deleted);
  assert.equal(proposalState(r), 'contested');
  assert.equal(accepted(run({ ...deleted, now: at(322) }))?.at, at(322));
});

test('a merged PR by the proposal author does not change acceptance', () => {
  const r = run(snapshot(272, { issues: [P()], mergedPulls: [merged(9, 'alice', 100)] }));
  assert.equal(proposalState(r), 'accepted');
});

test('an agent can re-approve after an edit and it counts', () => {
  const comments = [
    comment('carol', '/approve', 210), comment('dave', '/approve', 211),
    comment('carol', '/approve', 251), comment('dave', '/approve', 252), comment('erin', '/approve', 253),
  ];
  const r = run(snapshot(254, { issues: [P(comments, { edits: [at(250)] })] }));
  assert.equal(accepted(r)?.at, at(253));
});
