// Protected paths. The core list is hard-coded (Tier 1): agents can add to the
// protected set through policy.yaml, but can never remove these.

import type { ChangedFile } from './types.js';

export const POLICY_PATH = 'policy.yaml';

export const CORE_PROTECTED: readonly string[] = [
  '.github/**',
  'CONSTITUTION.md',
  'SKILL.md',
  'AGENTS.md',
  'README.md',
  'LICENSE',
  POLICY_PATH, // changeable only through an amendment PR, never alongside other files
];

/** Allowed shape of an agent-added pattern: plain path segments, `*` inside a segment, optional trailing `/**`. */
const PATTERN_SHAPE = /^[A-Za-z0-9._\-/*]+$/;

export function validatePattern(pattern: string): string | null {
  if (pattern.length === 0 || pattern.length > 200) return 'must be 1-200 characters';
  if (!PATTERN_SHAPE.test(pattern)) return 'may only contain letters, digits, . _ - / and *';
  if (pattern.split('/').includes('..')) return 'may not contain ".."';
  const body = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  if (body.includes('**')) return '"**" is only allowed as a trailing "/**"';
  if (body.length === 0) return 'may not protect the whole repository';
  // Many "*" in one segment make matching blow up on long file names.
  if (body.split('/').some((segment) => segment.split('*').length - 1 > 2)) return 'may have at most two "*" in each path segment';
  return null;
}

/** A repository path without "./", leading "/" or backslashes; case kept. */
export function cleanPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** Paths are compared case-insensitively so ".GitHub/x" cannot sneak past ".github/**". */
function normalize(p: string): string {
  return cleanPath(p).toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesPattern(path: string, pattern: string): boolean {
  const p = normalize(path);
  const pat = normalize(pattern);
  if (pat.endsWith('/**')) {
    // "a/*/**" matches anything whose leading segments match "a/*".
    const prefix = pat.slice(0, -3);
    const head = p.split('/').slice(0, prefix.split('/').length).join('/');
    return matchesPattern(head, prefix);
  }
  if (!pat.includes('*')) return p === pat;
  const re = new RegExp(`^${pat.split('*').map(escapeRe).join('[^/]*')}$`);
  return re.test(p);
}

/** Every path touched by the PR (both sides of renames). */
export function touchedPaths(files: ChangedFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f.path);
    if (f.previousPath) out.add(f.previousPath);
  }
  return [...out];
}

/**
 * Protected paths touched by the PR. policy.yaml itself is an amendment, not a
 * hit, but any other spelling of it (POLICY.YAML, Policy.yaml) is protected:
 * it would be a different file in git, and the same file on some systems.
 */
export function protectedHits(files: ChangedFile[], extra: readonly string[]): string[] {
  const patterns = [...CORE_PROTECTED.filter((p) => p !== POLICY_PATH), ...extra];
  return touchedPaths(files).filter(
    (path) => patterns.some((pat) => matchesPattern(path, pat)) || (normalize(path) === POLICY_PATH && cleanPath(path) !== POLICY_PATH),
  );
}

/** True if the PR changes policy.yaml, spelled exactly so: that makes it an amendment. */
export function touchesPolicy(files: ChangedFile[]): boolean {
  return touchedPaths(files).some((p) => cleanPath(p) === POLICY_PATH);
}
