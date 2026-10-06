import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEdited, parseCommand } from '../src/commands.js';
import { comment } from './helpers.js';

test('plain comments are not commands', () => {
  assert.equal(parseCommand('I think we should build a search engine'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('see /claim below'), null);
});

test('basic commands', () => {
  assert.deepEqual(parseCommand('/claim'), { kind: 'claim' });
  assert.deepEqual(parseCommand('  /CLAIM  \nI will do it'), { kind: 'claim' });
  assert.deepEqual(parseCommand('\n\n/release'), { kind: 'release' });
  assert.deepEqual(parseCommand('/approve'), { kind: 'approve' });
  assert.deepEqual(parseCommand('/withdraw'), { kind: 'withdraw' });
});

test('only the first non-empty line counts', () => {
  assert.equal(parseCommand('hello\n/claim'), null);
});

test('/object requires a reason', () => {
  assert.deepEqual(parseCommand('/object breaks #12'), { kind: 'object', reason: 'breaks #12' });
  assert.equal(parseCommand('/object')?.kind, 'invalid');
  assert.equal(parseCommand('/object   ')?.kind, 'invalid');
});

test('/support needs a login', () => {
  assert.deepEqual(parseCommand('/support @Agent-17'), { kind: 'support', target: 'agent-17' });
  assert.deepEqual(parseCommand('/support agent-17'), { kind: 'support', target: 'agent-17' });
  assert.equal(parseCommand('/support')?.kind, 'invalid');
  assert.equal(parseCommand('/support @a b')?.kind, 'invalid');
  assert.equal(parseCommand('/support @-bad')?.kind, 'invalid');
});

test('unknown commands are reported as invalid', () => {
  const c = parseCommand('/merge now');
  assert.equal(c?.kind, 'invalid');
  assert.match((c as { problem: string }).problem, /unknown command/);
});

test('edited comments are detected after a grace period', () => {
  assert.equal(isEdited(comment('a', '/claim', 1)), false);
  assert.equal(isEdited(comment('a', '/claim', 1, { updatedAt: new Date(Date.parse(comment('a', 'x', 1).createdAt) + 30_000).toISOString() })), false);
  assert.equal(isEdited(comment('a', '/claim', 1, { updatedAt: new Date(Date.parse(comment('a', 'x', 1).createdAt) + 61_000).toISOString() })), true);
});
