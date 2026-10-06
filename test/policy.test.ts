import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildPolicyTimeline, parsePolicy } from '../src/policy.js';
import { at, eventsOf, H, LAUNCH, LAUNCH_POLICY, policyWith, REAL_LAUNCH_POLICY, run, snapshot } from './helpers.js';

test('the launch policy is valid, with talk-before-code on', () => {
  const r = parsePolicy(REAL_LAUNCH_POLICY);
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('\n'));
  assert.equal(r.ok && r.policy.pull_requests.require_accepted_proposal, true);
  assert.equal(parsePolicy(LAUNCH_POLICY).ok, true);
});

test('launch-policy.yaml matches commons/policy.yaml when both are present', (t) => {
  const commons = new URL('../../../commons/policy.yaml', import.meta.url);
  if (!existsSync(commons)) return t.skip('commons repo not checked out next to referee (CI checks the launch version separately)');
  assert.equal(readFileSync(commons, 'utf8').replace(/\r\n/g, '\n'), REAL_LAUNCH_POLICY.replace(/\r\n/g, '\n'));
});

const errorsOf = (raw: string): string => {
  const r = parsePolicy(raw);
  assert.equal(r.ok, false, 'expected the policy to be rejected');
  return r.ok ? '' : r.errors.join('\n');
};

test('values outside the hard limits are rejected', () => {
  assert.match(errorsOf(policyWith((y) => y.replace('hours: 48', 'hours: 0'))), /leases\.hours must be between 1 and 336/);
  assert.match(errorsOf(policyWith((y) => y.replace('hours: 48', 'hours: 100000'))), /leases\.hours/);
  assert.match(errorsOf(policyWith((y) => y.replace('effective_delay_hours: 24', 'effective_delay_hours: 1'))), /effective_delay_hours/);
  assert.match(errorsOf(policyWith((y) => y.replace(/amendments:\n(.*\n)*?  min_approvals: 2/, (m) => m.replace('min_approvals: 2', 'min_approvals: 0')))), /amendments\.min_approvals/);
  assert.match(errorsOf(policyWith((y) => y.replace('window_hours: 72\n  # Approvals needed for an amendment', 'window_hours: 1\n  # Approvals needed for an amendment'))), /amendments\.window_hours/);
});

test('wrong types, unknown and missing keys are rejected', () => {
  assert.match(errorsOf(policyWith((y) => y.replace('enforce: false', 'enforce: "yes"'))), /dependencies\.enforce must be true or false/);
  assert.match(errorsOf(policyWith((y) => y.replace('hours: 48', 'hours: 4.5'))), /must be an integer/);
  assert.match(errorsOf(`${LAUNCH_POLICY}\nadmins: [me]\n`), /unknown key "admins"/);
  assert.match(errorsOf(policyWith((y) => y.replace('  max_active_per_agent: 2\n', ''))), /missing "leases\.max_active_per_agent"/);
  assert.match(errorsOf(policyWith((y) => y.replace('version: 1', 'version: 2'))), /version must be 1/);
  assert.match(errorsOf(''), /policy must be a mapping/);
  assert.match(errorsOf('a: [unclosed'), /not valid YAML/);
});

test('a vote cannot grant itself privileges: Article 0 keys simply do not exist', () => {
  assert.match(errorsOf(`${LAUNCH_POLICY}\nreferee:\n  disabled: true\n`), /unknown key "referee"/);
  assert.match(errorsOf(policyWith((y) => y.replace('protected_paths_extra: []', 'protected_paths_extra: ["**"]'))), /protected_paths_extra/);
});

test('YAML aliases are refused', () => {
  // Otherwise valid: only the alias is wrong.
  const aliased = policyWith((y) => y.replace('  ttl_hours: 72', '  ttl_hours: &t 72').replace('  hours: 48', '  hours: *t'));
  assert.match(errorsOf(aliased), /not valid YAML: Alias/);
});

const T = (h: number) => LAUNCH + h * H;

test('amendments take effect only after their delay', () => {
  const v2 = policyWith((y) => y.replace('hours: 48', 'hours: 12'));
  const timeline = buildPolicyTimeline([
    { sha: 'v1', committedAt: at(-10), raw: LAUNCH_POLICY },
    { sha: 'v2', committedAt: at(100), raw: v2 },
  ], LAUNCH);
  assert.equal(timeline.eraAt(T(123)).sha, 'v1');
  assert.deepEqual(timeline.pending(T(123)), [{ sha: 'v2', effectiveAt: at(124) }]);
  assert.equal(timeline.eraAt(T(124)).sha, 'v2');
  assert.equal(timeline.at(T(124)).leases.hours, 12);
  assert.deepEqual(timeline.pending(T(124)), []);
  // The past keeps its rules.
  assert.equal(timeline.at(T(50)).leases.hours, 48);
});

test('an amendment waits the delay in force when it merged; it cannot shorten its own', () => {
  const slow = policyWith((y) => y.replace('effective_delay_hours: 24', 'effective_delay_hours: 100'));
  const fastAgain = policyWith((y) => y.replace('effective_delay_hours: 24', 'effective_delay_hours: 24').replace('hours: 48', 'hours: 10'));
  const timeline = buildPolicyTimeline([
    { sha: 'v1', committedAt: at(-10), raw: LAUNCH_POLICY },
    { sha: 'slow', committedAt: at(1), raw: slow }, // under v1: in force at 25
    { sha: 'fast', committedAt: at(30), raw: fastAgain }, // under "slow" (100h): in force at 130, not 54
  ], LAUNCH);
  assert.equal(timeline.eraAt(T(24)).sha, 'v1');
  assert.equal(timeline.eraAt(T(25)).sha, 'slow');
  assert.equal(timeline.eraAt(T(129)).sha, 'slow');
  assert.equal(timeline.eraAt(T(130)).sha, 'fast');
});

test('setup edits before launch are not amendments: the version on main at launch applies at once', () => {
  const draft = policyWith((y) => y.replace('hours: 48', 'hours: 5'));
  const timeline = buildPolicyTimeline([
    { sha: 'draft', committedAt: at(-50), raw: draft },
    { sha: 'broken', committedAt: at(-40), raw: 'version: 1\n' },
    { sha: 'final', committedAt: at(-1), raw: LAUNCH_POLICY },
  ], LAUNCH);
  assert.equal(timeline.eraAt(T(0)).sha, 'final');
  assert.equal(timeline.eraAt(T(0)).from, -Infinity);
  assert.deepEqual(timeline.invalid, []); // pre-launch history is not an incident
});

test('an invalid version on main is skipped and reported, not applied', () => {
  const timeline = buildPolicyTimeline([
    { sha: 'v1', committedAt: at(-10), raw: LAUNCH_POLICY },
    { sha: 'bad', committedAt: at(1), raw: 'version: 1\n' },
  ], LAUNCH);
  assert.equal(timeline.eraAt(T(500)).sha, 'v1');
  assert.equal(timeline.invalid[0]?.sha, 'bad');
  const r = run(snapshot(500, { policyHistory: [{ sha: 'v1', committedAt: at(-10), raw: LAUNCH_POLICY }, { sha: 'bad', committedAt: at(1), raw: 'version: 1\n' }] }));
  assert.equal(eventsOf(r, 'policy_invalid_on_main')[0]?.incident, 'policy_invalid_on_main');
});

test('a newer version that takes effect first is never overridden by an older one', () => {
  const slowDelay = policyWith((y) => y.replace('effective_delay_hours: 24', 'effective_delay_hours: 300'));
  const s = policyWith((y) => y.replace('hours: 48', 'hours: 20')); // back to a 24h delay
  const a = policyWith((y) => y.replace('hours: 48', 'hours: 30').replace('effective_delay_hours: 24', 'effective_delay_hours: 300'));
  const b = policyWith((y) => y.replace('hours: 48', 'hours: 40'));
  const history = [
    { sha: 'v1', committedAt: at(-10), raw: slowDelay }, // 300h delay at launch
    { sha: 's', committedAt: at(1), raw: s }, // under v1: in force at 301
    { sha: 'a', committedAt: at(30), raw: a }, // under v1: due at 330
    { sha: 'b', committedAt: at(302), raw: b }, // under s (24h): in force at 326, before a was due
  ];
  const timeline = buildPolicyTimeline(history, LAUNCH);
  assert.equal(timeline.eraAt(T(310)).sha, 's');
  assert.equal(timeline.eraAt(T(326)).sha, 'b');
  assert.equal(timeline.eraAt(T(400)).sha, 'b'); // a, older, never takes over
  const r = run(snapshot(400, { policyHistory: history }));
  assert.deepEqual(eventsOf(r, 'policy_effective').map((e) => [e.data?.sha, e.at]), [['s', at(301)], ['b', at(326)]]);
});

test('an invalid launch policy is a hard error', () => {
  assert.throws(() => buildPolicyTimeline([{ sha: 'x', committedAt: at(0), raw: 'nope: 1' }], LAUNCH), /launch policy/);
});
