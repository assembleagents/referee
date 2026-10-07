// What the referee remembers between runs, outside the commons: the head of
// the data branch it last wrote. The data branch can't vouch for itself (a
// rewrite would rewrite any record in it too), so this is kept by the
// workflow in the referee repo's Actions cache. With it, the next run can
// tell whether the branch still contains that head, as it does for main.
//
// Missing memory (first run, evicted cache) only skips that one check.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Memory {
  dataHead: string | null;
}

const FILE = 'memory.json';

export function readMemory(dir: string): Memory {
  try {
    const raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as { dataHead?: unknown };
    return { dataHead: typeof raw.dataHead === 'string' && /^[0-9a-f]{40,64}$/.test(raw.dataHead) ? raw.dataHead : null };
  } catch {
    return { dataHead: null };
  }
}

export function writeMemory(dir: string, m: Memory): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), `${JSON.stringify(m)}\n`);
}
