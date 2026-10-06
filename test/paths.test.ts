import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesPattern, protectedHits, touchesPolicy, validatePattern } from '../src/paths.js';

const f = (path: string, previousPath: string | null = null) => ({ path, previousPath });

test('core protected paths are caught', () => {
  assert.deepEqual(protectedHits([f('.github/workflows/ci.yml')], []), ['.github/workflows/ci.yml']);
  assert.deepEqual(protectedHits([f('SKILL.md'), f('src/a.js')], []), ['SKILL.md']);
  assert.deepEqual(protectedHits([f('CONSTITUTION.md')], []), ['CONSTITUTION.md']);
  assert.deepEqual(protectedHits([f('README.md')], []), ['README.md']);
});

test('case and leading ./ tricks do not bypass protection', () => {
  assert.equal(protectedHits([f('.GitHub/workflows/x.yml')], []).length, 1);
  assert.equal(protectedHits([f('./skill.md')], []).length, 1);
  assert.equal(protectedHits([f('/.github/CODEOWNERS')], []).length, 1);
});

test('renaming a protected file away is caught via previousPath', () => {
  assert.deepEqual(protectedHits([f('docs/old-constitution.md', 'CONSTITUTION.md')], []), ['CONSTITUTION.md']);
});

test('nested README files are not protected, only the root one', () => {
  assert.deepEqual(protectedHits([f('docs/README.md'), f('src/SKILL.md')], []), []);
});

test('policy.yaml is detected separately from other protected paths', () => {
  assert.deepEqual(protectedHits([f('policy.yaml')], []), []);
  assert.equal(touchesPolicy([f('policy.yaml')]), true);
  assert.equal(touchesPolicy([f('./policy.yaml')]), true);
  assert.equal(touchesPolicy([f('docs/policy.yaml')]), false);
  assert.equal(touchesPolicy([f('rules.yaml', 'policy.yaml')]), true);
});

test('other spellings of policy.yaml are protected, not amendments', () => {
  assert.equal(touchesPolicy([f('POLICY.YAML')]), false);
  assert.deepEqual(protectedHits([f('POLICY.YAML'), f('Policy.yaml'), f('policy.yaml')], []), ['POLICY.YAML', 'Policy.yaml']);
  assert.deepEqual(protectedHits([f('docs/Policy.yaml')], []), []);
});

test('agent-added patterns', () => {
  assert.equal(matchesPattern('contracts/auth-v1.json', 'contracts/**'), true);
  assert.equal(matchesPattern('contracts', 'contracts/**'), true);
  assert.equal(matchesPattern('contractsx/a', 'contracts/**'), false);
  assert.equal(matchesPattern('api/v1/schema.json', 'api/*/schema.json'), true);
  assert.equal(matchesPattern('api/v1/x/schema.json', 'api/*/schema.json'), false);
  assert.equal(matchesPattern('pkg/a/deep/file', 'pkg/*/**'), true);
  assert.deepEqual(protectedHits([f('contracts/a.json')], ['contracts/**']), ['contracts/a.json']);
});

test('pattern validation rejects dangerous shapes', () => {
  assert.equal(validatePattern('contracts/**'), null);
  assert.equal(validatePattern('a/*.json'), null);
  assert.notEqual(validatePattern('**'), null);
  assert.notEqual(validatePattern('/**'), null);
  assert.notEqual(validatePattern('../x'), null);
  assert.notEqual(validatePattern('a/**/b'), null);
  assert.notEqual(validatePattern(''), null);
  assert.notEqual(validatePattern('a b'), null);
});

test('patterns with many "*" in one segment are refused (they would make matching blow up)', () => {
  assert.equal(validatePattern('src/*.test.*'), null);
  assert.notEqual(validatePattern('*a*a*a*a*a*a*a*a*b'), null);
  assert.notEqual(validatePattern('docs/*x*y*/**'), null);
});
