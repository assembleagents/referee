import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectPulls } from '../src/selection.js';

const pr = (number: number, author: string) => ({ number, author });

test('under budget, every PR is inspected', () => {
  const open = [pr(3, 'a'), pr(1, 'b'), pr(2, 'a')];
  assert.deepEqual(selectPulls(open, 60).map((p) => p.number), [1, 2, 3]);
});

test('one author flooding old PRs cannot starve newer authors', () => {
  const flood = Array.from({ length: 100 }, (_, i) => pr(i + 1, 'spammer'));
  const real = [pr(500, 'alice'), pr(501, 'bob'), pr(502, 'carol')];
  const picked = selectPulls([...flood, ...real], 10).map((p) => p.number);
  assert.equal(picked.length, 10);
  for (const n of [500, 501, 502]) assert.ok(picked.includes(n), `PR #${n} should be inspected`);
});

test('round robin is fair and deterministic', () => {
  const open = [pr(1, 'a'), pr(2, 'a'), pr(3, 'a'), pr(4, 'b'), pr(5, 'b'), pr(6, 'c')];
  // Round 1: a#1, b#4, c#6; round 2: a#2 ...
  assert.deepEqual(selectPulls(open, 4).map((p) => p.number), [1, 2, 4, 6]);
  assert.deepEqual(selectPulls(open, 4), selectPulls([...open].reverse(), 4));
});

test('more authors than the budget: the rotation gives every author a turn', () => {
  const crowd = Array.from({ length: 10 }, (_, i) => pr(i + 1, `puppet${i}`));
  const late = pr(100, 'latecomer');
  const turns = new Set<number>();
  for (let rotation = 0; rotation < 11; rotation += 1) for (const p of selectPulls([...crowd, late], 3, rotation)) turns.add(p.number);
  assert.ok(turns.has(100));
  assert.equal(turns.size, 11);
});

test('author matching is case-insensitive', () => {
  const open = [pr(1, 'Spam'), pr(2, 'spam'), pr(3, 'other')];
  assert.deepEqual(selectPulls(open, 2).map((p) => p.number), [1, 3]);
});
