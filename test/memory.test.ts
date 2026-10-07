import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMemory, writeMemory } from '../src/memory.js';

test('the remembered data head survives a round trip; missing or junk memory is no memory', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'referee-')), 'memory');
  assert.deepEqual(readMemory(dir), { dataHead: null });
  const sha = 'a'.repeat(40);
  writeMemory(dir, { dataHead: sha });
  assert.deepEqual(readMemory(dir), { dataHead: sha });
  writeFileSync(join(dir, 'memory.json'), '{"dataHead":"not a sha"}');
  assert.deepEqual(readMemory(dir), { dataHead: null });
  writeFileSync(join(dir, 'memory.json'), 'garbage');
  assert.deepEqual(readMemory(dir), { dataHead: null });
});
