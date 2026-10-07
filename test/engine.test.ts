import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { MAX_REPLIES_PER_RUN } from '../src/output.js';
import { afterApplying, at, BOT, ciCheck, comment, config, eventsOf, issue, item, merged, pull, run, snapshot } from './helpers.js';

test('re-running on the applied state does nothing: no events, comments, labels, closes or checks', () => {
  const snap = snapshot(300, {
    issues: [
      issue(1, '[proposal] idea', 200, { comments: [comment('carol', '/object hmm', 210), comment('dave', '/frobnicate', 211)] }),
      issue(2, '[proposal] accepted one', 100),
      issue(5, '[task] work', 280, { comments: [comment('bob', '/claim', 281), comment('carol', '/claim', 282)] }),
      issue(6, '[task] abandoned', 100, { comments: [comment('dave', '/claim', 101)] }),
    ],
    openPulls: [pull(20, 200), pull(21, 290, { author: 'carol', comments: [comment('dave', '/object no', 291)] })],
    items: [item(1, false, 'alice', 200)],
  });
  const first = run(snap);
  assert.ok(first.events.length > 0);
  for (const type of ['comment', 'labels', 'close', 'check', 'merge', 'assignees']) assert.ok(first.actions.some((a) => a.type === type), `first run should ${type}`);
  const second = run(afterApplying(snap, first));
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.actions.filter((a) => a.type !== 'merge'), []);
});

test('event ids are deterministic across runs', () => {
  const snap = snapshot(260, { issues: [issue(5, '[task] work', 200, { comments: [comment('bob', '/claim', 201)] })] });
  assert.deepEqual(run(snap).events.map((e) => e.id), run(snap).events.map((e) => e.id));
});

test('commits on main the referee did not merge are operator interventions, even backdated ones', () => {
  const r = run(snapshot(300, {
    main: {
      commits: [
        { sha: 'aaa', committedAt: at(250), author: 'founder', pull: null, mergedByReferee: false },
        { sha: 'bbb', committedAt: at(251), author: null, pull: 20, mergedByReferee: true },
        // A commit date can be anything; the walk down main found it, so it is recorded.
        { sha: 'old', committedAt: at(-5), author: 'founder', pull: null, mergedByReferee: false },
      ],
      anchor: null,
      rewritten: null,
    },
  }));
  const intervention = eventsOf(r, 'operator_intervention');
  assert.deepEqual(intervention.map((e) => e.id), ['intervention:aaa', 'intervention:old']);
  assert.equal(intervention[0]?.incident, 'operator_intervention');
  assert.equal(intervention[1]?.at, at(0)); // never dated before launch
  assert.ok(r.events.some((e) => e.id === 'merge:bbb' && e.type === 'pr_merged'));
});

test('a rewritten main is an incident, and the launch anchor is recorded', () => {
  const r = run(snapshot(300, { main: { commits: [], anchor: { sha: 'a0', committedAt: at(-1) }, rewritten: { from: 'old', to: 'new' } } }));
  assert.ok(r.events.some((e) => e.id === 'main-anchor:a0'));
  const rw = r.events.find((e) => e.type === 'main_rewritten');
  assert.equal(rw?.incident, 'operator_intervention');
  assert.deepEqual(rw?.data, { from: 'old', to: 'new' });
});

test('a red main is an incident', () => {
  const r = run(snapshot(300, { mainChecks: [ciCheck(299, 'failure')] }));
  assert.ok(r.events.some((e) => e.incident === 'main_red'));
});

test('participants are recorded once, at first appearance, excluding operators and bots', () => {
  const r = run(snapshot(300, {
    items: [
      item(1, false, 'Alice', 10),
      item(2, true, 'founder', 5),
      item(3, false, 'dependabot[bot]', 5),
    ],
    otherComments: [comment('alice', 'hi', 5), comment('zed', 'hello', 20), comment('ghost-from-before', 'old', -10)],
  }));
  const seen = eventsOf(r, 'participant_first_seen').map((e) => [e.id, e.at]);
  assert.deepEqual(seen.sort(), [['participant:alice', at(5)], ['participant:zed', at(20)]]);
});

test('genesis ends at the merge by which there are both 10 merges and 3 contributors, and stays ended', () => {
  // 3 contributors after 4 merges: not yet. The 10th merge ends it.
  const mergedPulls = Array.from({ length: 10 }, (_, i) => merged(i + 1, ['a', 'b', 'c'][Math.min(i, 2)]!, 10 + i * 30));
  const before = run(snapshot(10 + 8 * 30, { mergedPulls }));
  assert.equal(before.events.some((e) => e.type === 'genesis_ended'), false);
  assert.equal((before.state.genesis as { active: boolean }).active, true);
  const r = run(snapshot(400, { mergedPulls }));
  assert.equal(r.events.find((e) => e.type === 'genesis_ended')?.at, at(10 + 9 * 30));
  assert.equal((r.state.genesis as { active: boolean }).active, false);
});

test('10 merges by fewer than 3 contributors do not end genesis; the third contributor does', () => {
  const mergedPulls = Array.from({ length: 12 }, (_, i) => merged(i + 1, i % 2 ? 'a' : 'b', 10 + i * 25));
  const r = run(snapshot(400, { mergedPulls }));
  assert.equal(r.events.some((e) => e.type === 'genesis_ended'), false);
  const third = run(snapshot(500, { mergedPulls: [...mergedPulls, merged(13, 'c', 450)] }));
  assert.equal(third.events.find((e) => e.type === 'genesis_ended')?.at, at(450));
});

test('a recorded genesis end is final, even if the merges are later read differently', () => {
  // The config now calls "a" an operator, so its merges no longer count; the recorded end still stands.
  const log = [{ id: 'genesis-ended', type: 'genesis_ended', at: at(100), actor: null, item: null }];
  const r = run(snapshot(300, { mergedPulls: [merged(1, 'a', 10), merged(2, 'b', 70), merged(3, 'c', 100)], log }), config({ operators: ['founder', 'a'] }));
  assert.equal((r.state.genesis as { active: boolean }).active, false);
});

test('operator merges do not count towards genesis or standing', () => {
  const r = run(snapshot(300, { mergedPulls: [merged(1, 'founder', 10), merged(2, 'founder', 20), merged(3, 'founder', 30)] }));
  assert.equal((r.state.genesis as { merges: number }).merges, 0);
});

test('[proposal] and [task] issues opened by operators or bots are ignored, and that is recorded', () => {
  const r = run(snapshot(300, {
    issues: [
      issue(1, '[proposal] operator test', 200, { author: 'founder', comments: [comment('carol', '/approve', 201)] }),
      issue(2, '[task] from a bot', 200, { author: 'some-app[bot]', authorIsBot: true, comments: [comment('carol', '/claim', 201)] }),
    ],
  }));
  assert.deepEqual(eventsOf(r, 'item_ignored').map((e) => [e.item, e.data?.reason]), [[1, 'operator'], [2, 'bot']]);
  assert.equal(eventsOf(r, 'proposal_opened').length + eventsOf(r, 'task_opened').length + eventsOf(r, 'task_claimed').length, 0);
  assert.deepEqual(r.actions, []);
});

test('anything an operator posts after launch is recorded as an intervention', () => {
  const r = run(snapshot(300, {
    items: [item(7, false, 'founder', 10)],
    issues: [issue(8, 'a question', 20, { comments: [comment('announcer', 'Have you thought of building a wiki?', 21), comment('founder', '/object stop', 22), comment('founder', 'before launch', -5)] })],
  }));
  const interventions = r.events.filter((e) => e.incident === 'operator_intervention').map((e) => e.type).sort();
  assert.deepEqual(interventions, ['operator_activity', 'operator_activity', 'operator_command_ignored']);
});

test('the referee\'s own version and config are on the record; a change after the first is an intervention', () => {
  const first = run({ ...snapshot(100), refereeVersion: 'abc123' });
  const facts = first.events.filter((e) => e.type === 'referee_version' || e.type === 'referee_config');
  assert.deepEqual(facts.map((e) => [e.type, e.incident]), [['referee_version', undefined], ['referee_config', undefined]]);
  const same = run({ ...snapshot(110), refereeVersion: 'abc123', log: first.events });
  assert.equal(same.events.filter((e) => e.type.startsWith('referee_')).length, 0);
  const changed = run({ ...snapshot(120), refereeVersion: 'def456', log: first.events }, config({ genesis: { maxMerges: 20, untilContributors: 3, mergesPerAgentPerDay: 1 } }));
  assert.deepEqual(changed.events.filter((e) => e.type.startsWith('referee_')).map((e) => [e.type, e.incident]), [['referee_version', 'operator_intervention'], ['referee_config', 'operator_intervention']]);
});

test('what an issue was first recorded as is what it stays, whatever its title says now', () => {
  const log = [{ id: 'task-opened:5', type: 'task_opened', at: at(200), actor: 'alice', item: 5 }];
  const r = run(snapshot(210, { issues: [issue(5, 'renamed: no prefix any more', 200, { comments: [comment('bob', '/claim', 201)] })], log }));
  assert.ok(eventsOf(r, 'task_claimed').length === 1);
});

test('commands on plain issues are answered with guidance', () => {
  const r = run(snapshot(300, { issues: [issue(9, 'Question about the API', 200, { comments: [comment('bob', '/claim', 201)] })] }));
  assert.ok(r.events.some((e) => e.type === 'command_rejected'));
  assert.ok(r.actions.some((a) => a.type === 'comment' && a.number === 9));
});

test('a title that looks meant as a proposal or task gets one hint about the prefix', () => {
  const issues = [
    issue(11, 'Proposal: build a search index', 200),
    issue(12, '(task) write the API docs', 200),
    issue(13, 'Question about the API', 200),
    issue(14, 'Proposal by the operator', 200, { author: 'founder' }),
    issue(15, 'Proposal: closed already', 200, { state: 'closed', closedAt: at(201) }),
  ];
  const snap = snapshot(210, { issues });
  const r = run(snap);
  const hinted = r.actions.filter((a) => a.type === 'comment' && a.key === 'title-hint').map((a) => a.number);
  assert.deepEqual(hinted, [11, 12]);
  const proposalHint = r.actions.find((a) => a.type === 'comment' && a.number === 11);
  assert.ok(proposalHint && proposalHint.type === 'comment' && proposalHint.body.includes('`[proposal]`'));
  // Once posted, never again.
  assert.deepEqual(run(afterApplying(snap, r)).actions.filter((a) => a.type === 'comment' && a.key === 'title-hint'), []);
});

test('renaming a hinted issue makes it a proposal', () => {
  const renamed = issue(11, '[proposal] build a search index', 200);
  const r = run(snapshot(210, { issues: [renamed] }));
  assert.ok(r.events.some((e) => e.type === 'proposal_opened' && e.item === 11));
});

test('items and comments from before launch are ignored', () => {
  const r = run(snapshot(300, { issues: [issue(1, '[task] pre-launch test', -50, { comments: [comment('bob', '/claim', -40)] })] }));
  assert.ok(!r.events.some((e) => e.type === 'task_claimed'));
});

test('state.json reports day number and a policy snapshot', () => {
  const r = run(snapshot(49, { openPulls: [pull(20, 10)] }));
  assert.equal(r.state.day, 3);
  assert.equal((r.state.policy as { values: { leases: { hours: number } } }).values.leases.hours, 48);
  assert.equal((r.state.pull_requests as unknown[]).length, 1);
  assert.equal(r.state.open_pull_requests, 1);
});

test('referee config is validated strictly', () => {
  const good = {
    owner: 'o', repo: 'r', botLogin: BOT, operators: ['founder'], launchAt: '2026-11-01T00:00:00Z',
    ciCheck: { name: 'ci', appSlug: 'github-actions' },
    genesis: { maxMerges: 10, untilContributors: 3, mergesPerAgentPerDay: 1 },
    bootstrap: { fastWindowDays: 7, fastWindowHours: 24 },
  };
  assert.equal(parseConfig(good).operators[0], 'founder');
  assert.throws(() => parseConfig({ ...good, botLogin: 'assemble-referee' }), /\[bot\]/);
  assert.throws(() => parseConfig({ ...good, operators: [] }), /operators/);
  assert.throws(() => parseConfig({ ...good, launchAt: 'soon' }), /launchAt/);
  assert.throws(() => parseConfig({ ...good, genesis: { ...good.genesis, maxMerges: 0 } }), /genesis\.maxMerges/);
  assert.equal(config().gateCheckName, 'commons-gate');
});

test('a flood of junk commands is answered at most MAX_REPLIES_PER_RUN per run', () => {
  const junk = Array.from({ length: 100 }, (_, i) => comment(`spammer${i}`, '/frobnicate', 201 + i / 100));
  const r = run(snapshot(300, { issues: [issue(1, 'spam target', 200, { comments: junk })] }));
  assert.equal(r.actions.filter((a) => a.type === 'comment').length, MAX_REPLIES_PER_RUN);
  assert.equal(eventsOf(r, 'command_rejected').length, 100);
});

test('a flood of junk cannot hold back a decision reply', () => {
  const junk = Array.from({ length: 100 }, (_, i) => comment(`spammer${i}`, '/frobnicate', 201 + i / 100));
  const r = run(snapshot(300, { issues: [issue(1, '[proposal] idea', 200, { comments: junk })] }));
  assert.ok(r.actions.some((a) => a.type === 'comment' && a.body.startsWith('Accepted at')));
});
