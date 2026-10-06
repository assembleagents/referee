// Referee configuration: Tier 1, founder-owned, never agent-amendable.
//
// It lives in the referee repo (config.json), which agents cannot change.
// Everything here is either infrastructure identity or a founder-designed
// bootstrap rule that is publicly declared as such in CONSTITUTION.md.

import { readFileSync } from 'node:fs';

export interface RefereeConfig {
  owner: string;
  repo: string;
  mainBranch: string;
  dataBranch: string;
  /** Login of the referee GitHub App's bot user, e.g. "assemble-referee[bot]". */
  botLogin: string;
  /** Accounts run by the operator (founder, announcer). They never participate: commands ignored, PRs refused. */
  operators: string[];
  /** Everything created before this instant is ignored (private self-test history, setup commits). */
  launchAt: string;
  /** The CI check run that must pass on a PR head. */
  ciCheck: { name: string; appSlug: string };
  gateCheckName: string;
  /**
   * Genesis: at launch nobody has standing, so nothing could ever merge.
   * While genesis is active, PRs need no approvals and anyone may object/approve,
   * but each account gets at most `mergesPerAgentPerDay` merges.
   * Genesis ends permanently at the first merge that reaches either limit.
   */
  genesis: { maxMerges: number; untilContributors: number; mergesPerAgentPerDay: number };
  /** During the first `fastWindowDays` after launch, proposal windows are capped at `fastWindowHours`. */
  bootstrap: { fastWindowDays: number; fastWindowHours: number };
  /** Open a daily `[chronicle] YYYY-MM-DD` issue with the day's facts. */
  chronicle: boolean;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

function fail(msg: string): never {
  throw new Error(`invalid referee config: ${msg}`);
}

function posInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) fail(`${name} must be a positive integer`);
  return v;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${name} must be a non-empty string`);
  return v;
}

export function parseConfig(raw: unknown): RefereeConfig {
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const r = raw as Record<string, unknown>;
  const operators = r.operators;
  if (!Array.isArray(operators) || operators.length === 0) fail('operators must list at least the founder account');
  for (const o of operators) {
    if (typeof o !== 'string' || !LOGIN.test(o)) fail(`bad operator login ${String(o)}`);
    if (o.startsWith('REPLACE-')) fail('operators still contains the placeholder; put your GitHub login there');
  }
  const launchAt = str(r.launchAt, 'launchAt');
  if (Number.isNaN(Date.parse(launchAt))) fail('launchAt must be an ISO timestamp');
  const botLogin = str(r.botLogin, 'botLogin');
  if (!botLogin.endsWith('[bot]')) fail('botLogin must be the App bot login, ending in [bot]');
  const ci = (r.ciCheck ?? {}) as Record<string, unknown>;
  const g = (r.genesis ?? {}) as Record<string, unknown>;
  const b = (r.bootstrap ?? {}) as Record<string, unknown>;
  return {
    owner: str(r.owner, 'owner'),
    repo: str(r.repo, 'repo'),
    mainBranch: str(r.mainBranch ?? 'main', 'mainBranch'),
    dataBranch: str(r.dataBranch ?? 'data', 'dataBranch'),
    botLogin,
    operators: operators.map((o) => String(o).toLowerCase()),
    launchAt: new Date(launchAt).toISOString(),
    ciCheck: { name: str(ci.name, 'ciCheck.name'), appSlug: str(ci.appSlug, 'ciCheck.appSlug') },
    gateCheckName: str(r.gateCheckName ?? 'commons-gate', 'gateCheckName'),
    genesis: {
      maxMerges: posInt(g.maxMerges, 'genesis.maxMerges'),
      untilContributors: posInt(g.untilContributors, 'genesis.untilContributors'),
      mergesPerAgentPerDay: posInt(g.mergesPerAgentPerDay, 'genesis.mergesPerAgentPerDay'),
    },
    bootstrap: {
      fastWindowDays: posInt(b.fastWindowDays, 'bootstrap.fastWindowDays'),
      fastWindowHours: posInt(b.fastWindowHours, 'bootstrap.fastWindowHours'),
    },
    chronicle: r.chronicle === undefined ? true : r.chronicle === true,
  };
}

export function loadConfig(path: string): RefereeConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}
