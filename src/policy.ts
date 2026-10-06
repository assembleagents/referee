// policy.yaml: the agent-amendable rules, validated against hard limits that
// live here in the referee's code (Tier 1). An amendment outside these limits
// is refused no matter how many agents approve it.

import { parse as parseYaml } from 'yaml';
import { validatePattern } from './paths.js';
import { HOUR, iso, ms } from './time.js';
import type { PolicyVersion } from './types.js';

export interface Policy {
  version: 1;
  proposals: { window_hours: number; max_age_days: number; early_approvals: number };
  objections: { ttl_hours: number };
  leases: { hours: number; max_active_per_agent: number; reclaim_cooldown_hours: number };
  pull_requests: { window_hours: number; min_approvals: number; require_accepted_proposal: boolean; require_task_link: boolean; require_up_to_date: boolean };
  dependencies: { enforce: boolean };
  amendments: { window_hours: number; min_approvals: number; effective_delay_hours: number };
  standing: { min_merged_prs: number };
  protected_paths_extra: string[];
}

type Field =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'paths'; maxItems: number };

const int = (min: number, max: number): Field => ({ kind: 'int', min, max });
const bool: Field = { kind: 'bool' };

/** The hard limits. Changing these is an operator intervention. */
export const SCHEMA: Record<string, Record<string, Field> | Field> = {
  proposals: { window_hours: int(1, 336), max_age_days: int(1, 365), early_approvals: int(2, 50) },
  objections: { ttl_hours: int(1, 336) },
  leases: { hours: int(1, 336), max_active_per_agent: int(1, 20), reclaim_cooldown_hours: int(0, 336) },
  pull_requests: { window_hours: int(1, 336), min_approvals: int(0, 10), require_accepted_proposal: bool, require_task_link: bool, require_up_to_date: bool },
  dependencies: { enforce: bool },
  // Amendments can never pass faster than a day, never with zero approvals,
  // and never take effect sooner than a day after merging (anti-capture).
  amendments: { window_hours: int(24, 336), min_approvals: int(1, 10), effective_delay_hours: int(24, 336) },
  standing: { min_merged_prs: int(1, 50) },
  protected_paths_extra: { kind: 'paths', maxItems: 50 },
};

export type PolicyResult = { ok: true; policy: Policy } | { ok: false; errors: string[] };

function checkField(path: string, f: Field, v: unknown, errors: string[]): void {
  switch (f.kind) {
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) errors.push(`${path} must be an integer`);
      else if (v < f.min || v > f.max) errors.push(`${path} must be between ${f.min} and ${f.max} (got ${v})`);
      return;
    case 'bool':
      if (typeof v !== 'boolean') errors.push(`${path} must be true or false`);
      return;
    case 'paths':
      if (!Array.isArray(v)) {
        errors.push(`${path} must be a list`);
        return;
      }
      if (v.length > f.maxItems) errors.push(`${path} may have at most ${f.maxItems} entries`);
      v.forEach((p, i) => {
        if (typeof p !== 'string') errors.push(`${path}[${i}] must be a string`);
        else {
          const problem = validatePattern(p);
          if (problem) errors.push(`${path}[${i}] "${p}" ${problem}`);
        }
      });
      return;
  }
}

function isField(x: Record<string, Field> | Field): x is Field {
  return typeof (x as Field).kind === 'string';
}

/** Validates a parsed policy object. Strict: unknown keys and missing keys are both errors. */
export function validatePolicy(value: unknown): PolicyResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, errors: ['policy must be a mapping'] };
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) errors.push('version must be 1');
  for (const key of Object.keys(obj)) {
    if (key !== 'version' && !(key in SCHEMA)) errors.push(`unknown key "${key}"`);
  }
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const v = obj[key];
    if (v === undefined) {
      errors.push(`missing "${key}"`);
      continue;
    }
    if (isField(spec)) {
      checkField(key, spec, v, errors);
      continue;
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      errors.push(`${key} must be a mapping`);
      continue;
    }
    const section = v as Record<string, unknown>;
    for (const sub of Object.keys(section)) if (!(sub in spec)) errors.push(`unknown key "${key}.${sub}"`);
    for (const [sub, f] of Object.entries(spec)) {
      if (section[sub] === undefined) errors.push(`missing "${key}.${sub}"`);
      else checkField(`${key}.${sub}`, f, section[sub], errors);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy: obj as unknown as Policy };
}

export function parsePolicy(raw: string): PolicyResult {
  let value: unknown;
  try {
    // Plain YAML only: no custom tags, no aliases bombs.
    value = parseYaml(raw, { maxAliasCount: 0, customTags: [], uniqueKeys: true });
  } catch (e) {
    return { ok: false, errors: [`not valid YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  return validatePolicy(value);
}

/** One valid version of policy.yaml and the moment it takes (or took) effect. */
export interface PolicyEra {
  policy: Policy;
  sha: string;
  /** Position in main's history of policy.yaml: a higher index is a newer commit. */
  index: number;
  committedAt: number;
  /** When it takes effect; -Infinity for the launch policy. */
  from: number;
}

/**
 * The rules in force at every instant. Rules are always applied as they stood
 * at the moment that matters (a command, a push, a window's start), so a run
 * after an amendment never re-decides the past under the new rules.
 */
export class PolicyTimeline {
  constructor(
    /** Valid versions, oldest commit first; eras[0] is the launch policy. */
    readonly eras: PolicyEra[],
    /** Versions committed to main after launch that break the hard limits; they never take effect. */
    readonly invalid: { sha: string; committedAt: string; errors: string[] }[],
  ) {}

  /** The era in force at t: the newest commit among those already in effect. */
  eraAt(t: number): PolicyEra {
    let best = this.eras[0]!;
    for (const e of this.eras) if (e.from <= t && e.index > best.index) best = e;
    return best;
  }

  at(t: number): Policy {
    return this.eraAt(t).policy;
  }

  /** Versions that will take effect after `now` and are newer than the one in force. */
  pending(now: number): { sha: string; effectiveAt: string }[] {
    const current = this.eraAt(now);
    return this.eras.filter((e) => e.from > now && e.index > current.index).map((e) => ({ sha: e.sha, effectiveAt: iso(e.from) }));
  }
}

/**
 * Builds the timeline from main's history of policy.yaml (oldest first).
 *
 * The version on main at launch is the launch policy and applies immediately;
 * earlier pre-launch versions are setup history and are ignored. Every later
 * version takes effect after the `amendments.effective_delay_hours` that was in
 * force when it was committed (never less than 24h), so an amendment can't
 * shorten its own delay.
 */
export function buildPolicyTimeline(history: PolicyVersion[], launch: number): PolicyTimeline {
  if (history.length === 0) throw new Error('policy.yaml has no history on main');
  let launchIndex = -1;
  history.forEach((v, i) => {
    if (ms(v.committedAt) <= launch) launchIndex = i;
  });
  // policy.yaml first committed after launch (a setup mistake): its first version is the launch policy.
  if (launchIndex < 0) launchIndex = 0;

  const first = history[launchIndex]!;
  const launchResult = parsePolicy(first.raw);
  if (!launchResult.ok) throw new Error(`the launch policy.yaml (${first.sha.slice(0, 7)}) is invalid; fix it before launch: ${launchResult.errors.join('; ')}`);
  const timeline = new PolicyTimeline([{ policy: launchResult.policy, sha: first.sha, index: launchIndex, committedAt: ms(first.committedAt), from: -Infinity }], []);

  for (let i = launchIndex + 1; i < history.length; i += 1) {
    const v = history[i]!;
    const result = parsePolicy(v.raw);
    if (!result.ok) {
      timeline.invalid.push({ sha: v.sha, committedAt: v.committedAt, errors: result.errors });
      continue;
    }
    const committedAt = ms(v.committedAt);
    const delay = Math.max(24, timeline.at(committedAt).amendments.effective_delay_hours) * HOUR;
    timeline.eras.push({ policy: result.policy, sha: v.sha, index: i, committedAt, from: committedAt + delay });
  }
  return timeline;
}
