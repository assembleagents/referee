import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDigest, daysToDigest, MAX_BACKFILL_DAYS, parseEvents, planChronicle, renderDigest } from '../src/digest.js';
import type { RefEvent } from '../src/types.js';
import { at, BOT, H, issue, LAUNCH } from './helpers.js';

const LAUNCH_AT = '2026-11-01T00:00:00.000Z';
const ev = (id: string, type: string, h: number, extra: Partial<RefEvent> = {}): RefEvent => ({ id, type, at: at(h), actor: null, item: null, ...extra });

test('a day is digested only once it is over plus the grace period', () => {
  assert.deepEqual(daysToDigest(LAUNCH_AT, LAUNCH + 25 * H, new Set()), []);
  assert.deepEqual(daysToDigest(LAUNCH_AT, LAUNCH + 26 * H, new Set()), ['2026-11-01']);
  assert.deepEqual(daysToDigest(LAUNCH_AT, LAUNCH + 50 * H, new Set(['2026-11-01'])), ['2026-11-02']);
});

test('a launch in the middle of a day still digests that day', () => {
  assert.deepEqual(daysToDigest('2026-11-01T15:30:00Z', LAUNCH + 26 * H, new Set()), ['2026-11-01']);
});

test('backfill is bounded', () => {
  assert.equal(daysToDigest(LAUNCH_AT, LAUNCH + 100 * 24 * H, new Set()).length, MAX_BACKFILL_DAYS);
});

test('the digest counts only that day, and lists items with titles', () => {
  const events = [
    ev('proposal-opened:1', 'proposal_opened', 2, { actor: 'alice', item: 1, data: { title: 'Build a search index' } }),
    ev('proposal-accepted:1', 'proposal_accepted', 26, { item: 1, data: { title: 'Build a search index' } }),
    ev('participant:alice', 'participant_first_seen', 1, { actor: 'alice' }),
    ev('cmd:1', 'task_claimed', 5, { actor: 'Bob', item: 7 }),
    ev('lease-expired:7:1', 'lease_expired', 23, { actor: 'Bob', item: 7, incident: 'abandoned_work' }),
    ev('intervention:abc', 'operator_intervention', 10, { actor: 'founder', incident: 'operator_intervention' }),
  ];
  const d = buildDigest(events, '2026-11-01', LAUNCH_AT);
  assert.equal(d.day_number, 1);
  assert.equal(d.counts.proposal_opened, 1);
  assert.equal(d.counts.proposal_accepted, undefined); // happened on day 2
  assert.deepEqual(d.new_participants, ['alice']);
  assert.deepEqual(d.active_participants, ['alice', 'bob']); // lease expiry and intervention aren't participant activity
  assert.deepEqual(d.proposals_opened, [{ item: 1, title: 'Build a search index', actor: 'alice' }]);
  assert.deepEqual(d.incidents, { abandoned_work: 1, operator_intervention: 1 });
  assert.equal(d.operator_interventions, 1);
  assert.equal(buildDigest(events, '2026-11-02', LAUNCH_AT).proposals_accepted[0]?.title, 'Build a search index');
});

test('the rendered digest neutralises participant text', () => {
  const events = [ev('p', 'proposal_opened', 2, { actor: 'evil', item: 1, data: { title: '[click](https://evil.example) @everyone `x`' } })];
  const md = renderDigest(buildDigest(events, '2026-11-01', LAUNCH_AT));
  assert.ok(md.includes('`[click](https://evil.example) @everyone  x`'));
  assert.ok(!md.includes('\n- #1 [click]'));
});

test('chronicle: opens today\'s issue once and closes older ones, ignoring look-alikes', () => {
  const issues = [
    issue(10, '[chronicle] 2026-11-01', 26, { author: BOT }),
    issue(11, '[chronicle] 2026-11-02', 30, { author: 'impostor' }), // a participant pre-empting the day
  ];
  const plan = planChronicle('2026-11-02', 'facts', issues, BOT);
  assert.equal(plan.open?.title, '[chronicle] 2026-11-02');
  assert.deepEqual(plan.close, [10]);
  const again = planChronicle('2026-11-02', 'facts', [...issues, issue(12, '[chronicle] 2026-11-02', 51, { author: BOT })], BOT);
  assert.equal(again.open, null);
});

test('event log parsing skips corrupt lines', () => {
  const text = `${JSON.stringify(ev('a', 'x', 1))}\nnot json\n\n${JSON.stringify({ id: 'b' })}\n${JSON.stringify(ev('c', 'y', 2))}\n`;
  assert.deepEqual(parseEvents([text]).map((e) => e.id), ['a', 'c']);
});

test('an event with an unreadable time or item is skipped, so one bad line can\'t stop every run', () => {
  const lines = [ev('ok', 'x', 1), { ...ev('bad-time', 'x', 1), at: 'yesterday' }, { ...ev('bad-item', 'x', 1), item: 'seven' }, null, 42].map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(parseEvents([lines]).map((e) => e.id), ['ok']);
});

test('the digest shows the event log\'s head hash', () => {
  const d = buildDigest([], '2026-11-01', LAUNCH_AT, 'ab'.repeat(32));
  assert.equal(d.log_head, 'ab'.repeat(32));
  assert.ok(renderDigest(d).includes(`| Event log head (sha256) | \`${'ab'.repeat(32)}\` |`));
  assert.ok(renderDigest(buildDigest([], '2026-11-01', LAUNCH_AT)).includes('| Event log head (sha256) | none yet |'));
});
