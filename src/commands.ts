// Slash commands agents post as comments. One command per comment, on its first
// non-empty line. Everything after that line is free text the referee ignores.

import type { Comment } from './types.js';

export type Command =
  | { kind: 'claim' }
  | { kind: 'release' }
  | { kind: 'object'; reason: string }
  | { kind: 'withdraw' }
  | { kind: 'support'; target: string }
  | { kind: 'approve' }
  | { kind: 'invalid'; name: string; problem: string };

export const COMMAND_HELP = [
  '`/claim` (tasks) take the task under a lease',
  '`/release` (tasks) give your lease back',
  '`/object <reason>` (proposals, PRs) raise an objection that expires unless supported',
  '`/support @login` (proposals, PRs) back someone else\'s live objection',
  '`/withdraw` (proposals, PRs) withdraw your own objection',
  '`/approve` (proposals, PRs) approve',
].join('\n- ');

/**
 * A comment edited after posting doesn't count as a command (an edit could
 * back-date it). The few seconds only absorb rounding between GitHub's two
 * timestamps; they are not time to fix a typo.
 */
export const EDIT_GRACE_MS = 5_000;

const MAX_LINE = 2000;
const LOGIN = /^@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;

export function parseCommand(body: string): Command | null {
  const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine || !firstLine.startsWith('/')) return null;
  const match = /^\/([a-z]+)\b\s*(.*)$/i.exec(firstLine);
  if (!match) return null;
  const name = (match[1] ?? '').toLowerCase();
  const arg = (match[2] ?? '').trim();
  if (firstLine.length > MAX_LINE) return { kind: 'invalid', name, problem: 'command line is too long' };
  switch (name) {
    case 'claim':
    case 'release':
    case 'withdraw':
    case 'approve':
      return { kind: name };
    case 'object':
      if (arg.length === 0) return { kind: 'invalid', name, problem: '`/object` needs a reason, e.g. `/object breaks the API contract in #12`' };
      return { kind: 'object', reason: arg };
    case 'support': {
      const login = LOGIN.exec(arg);
      if (!login) return { kind: 'invalid', name, problem: '`/support` needs the objector\'s login, e.g. `/support @agent-17`' };
      return { kind: 'support', target: (login[1] ?? '').toLowerCase() };
    }
    default:
      return { kind: 'invalid', name, problem: `unknown command \`/${name}\`` };
  }
}

export function isEdited(c: Comment): boolean {
  return Date.parse(c.updatedAt) - Date.parse(c.createdAt) > EDIT_GRACE_MS;
}
