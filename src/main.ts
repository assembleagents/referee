// Entry point for one referee run.
//
//   GITHUB_TOKEN    installation token of the referee GitHub App (minted per run by the workflow)
//   REFEREE_CONFIG  path to config.json (default: ./config.json)
//   --dry-run       compute and print everything, change nothing

import { appendFileSync } from 'node:fs';
import { Octokit } from '@octokit/rest';
import { loadConfig, type RefereeConfig } from './config.js';
import { buildDigest, daysToDigest, planChronicle, renderDigest } from './digest.js';
import { evaluate } from './engine.js';
import { applyActions, ensureLabels } from './github/apply.js';
import { DIGEST_INDEX, readStore, writeStore, type Store } from './github/datastore.js';
import { fetchSnapshot } from './github/fetch.js';
import { EventLog } from './log.js';
import { MAX_PULLS_PER_RUN } from './selection.js';
import type { Action, Issue, RefEvent } from './types.js';

const log = (msg: string) => console.log(`[referee] ${msg}`);

interface DigestPlan {
  files: Map<string, string>;
  chronicle: { day: string; actions: Action[] } | null;
}

/**
 * Digests for every complete day not yet digested, and the chronicle for the
 * newest one. A day that gets a fact recorded late (after it was digested)
 * has its digest rewritten, so the digests never disagree with the event log.
 */
function planDigests(cfg: RefereeConfig, store: Store, events: RefEvent[], issues: Issue[], now: Date, fresh: RefEvent[]): DigestPlan {
  const files = new Map<string, string>();
  const days = daysToDigest(cfg.launchAt, now.getTime(), store.digestDays);
  const write = (day: string): string => {
    const digest = buildDigest(events, day, cfg.launchAt);
    const markdown = renderDigest(digest);
    files.set(`digests/${day}.json`, `${JSON.stringify(digest, null, 2)}\n`);
    files.set(`digests/${day}.md`, `${markdown}\n`);
    return markdown;
  };
  for (const day of new Set(fresh.map((e) => e.at.slice(0, 10)))) if (store.digestDays.has(day)) write(day);
  if (days.length === 0) return { files, chronicle: null };
  let latest: { day: string; markdown: string } | null = null;
  for (const day of days) latest = { day, markdown: write(day) };
  const index = [...new Set([...store.digestDays, ...days])].sort();
  files.set(DIGEST_INDEX, `${JSON.stringify({ days: index }, null, 2)}\n`);

  if (!cfg.chronicle || !latest) return { files, chronicle: null };
  const plan = planChronicle(latest.day, latest.markdown, issues, cfg.botLogin);
  const actions: Action[] = plan.close.map((number) => ({ type: 'close', number, reason: 'completed' }));
  if (plan.open) actions.push({ type: 'open_issue', number: 0, title: plan.open.title, body: plan.open.body, labels: ['chronicle'] });
  return { files, chronicle: { day: latest.day, actions } };
}

function dedupe(events: RefEvent[]): RefEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

/** main's head as the previous run recorded it in state.json. */
function previousMainSha(store: Store): string | null {
  try {
    const sha = (JSON.parse(store.stateJson ?? 'null') as { main?: { sha?: unknown } } | null)?.main?.sha;
    return typeof sha === 'string' ? sha : null;
  } catch {
    return null;
  }
}

/** API requests kept in reserve, and the rough cost of inspecting one open PR. */
const RATE_RESERVE = 400;
const CALLS_PER_PULL = 7;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadConfig(process.env.REFEREE_CONFIG ?? 'config.json');
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const gh = new Octokit({ auth: token, userAgent: 'assemble-referee' });
  const now = new Date();

  if (now.getTime() < Date.parse(cfg.launchAt)) {
    log(`launchAt ${cfg.launchAt} is in the future; nothing to do`);
    return;
  }

  // Outcomes don't depend on when the referee runs, so a run that would exhaust the API quota is simply skipped.
  const quota = (await gh.rest.rateLimit.get()).data.resources.core;
  const pullBudget = Math.min(MAX_PULLS_PER_RUN, Math.floor((quota.remaining - RATE_RESERVE) / CALLS_PER_PULL));
  if (pullBudget < 1) {
    log(`only ${quota.remaining} API requests left until ${new Date(quota.reset * 1000).toISOString()}; skipping this run`);
    return;
  }

  const store = await readStore(gh, cfg);
  const eventLog = new EventLog(store.events);
  const snapshot = await fetchSnapshot(gh, cfg, now, { log: eventLog, previousMainSha: previousMainSha(store), pullBudget }, log);
  snapshot.log = store.events;
  // GitHub Actions sets GITHUB_SHA to the referee commit being run, which puts the referee's own version on the record.
  snapshot.refereeVersion = process.env.GITHUB_SHA ?? null;
  const result = evaluate(snapshot, cfg);
  log(`${result.actions.length} action(s), ${result.events.length} new event(s)`);

  if (dryRun) {
    const digests = planDigests(cfg, store, dedupe([...store.events, ...result.events]), snapshot.issues, now, result.events);
    console.log(JSON.stringify({ actions: result.actions, events: result.events, state: result.state, digests: [...digests.files.keys()], chronicle: digests.chronicle }, null, 2));
    return;
  }

  await ensureLabels(gh, cfg, log);
  const applied = await applyActions(gh, cfg, result.actions, now, log);

  // Digests are built from everything recorded so far, including this run.
  const allEvents = dedupe([...store.events, ...result.events, ...applied.events]);
  const fresh = [...result.events, ...applied.events].filter((e) => !store.eventIds.has(e.id));
  const digests = planDigests(cfg, store, allEvents, snapshot.issues, now, fresh);
  const extraEvents: RefEvent[] = [];
  let chronicleFailures = 0;
  if (digests.chronicle && digests.chronicle.actions.length) {
    const c = await applyActions(gh, cfg, digests.chronicle.actions, now, log);
    chronicleFailures = c.failed.length;
    if (digests.chronicle.actions.some((a) => a.type === 'open_issue') && c.failed.every((f) => f.action.type !== 'open_issue')) {
      extraEvents.push({ id: `chronicle:${digests.chronicle.day}`, type: 'chronicle_opened', at: now.toISOString(), actor: null, item: null, data: { day: digests.chronicle.day } });
    }
  }

  const written = await writeStore(gh, cfg, store, [...result.events, ...applied.events, ...extraEvents], result.state, now.toISOString(), digests.files);
  log(`applied ${applied.done}, failed ${applied.failed.length}; data branch ${written.committed ? `updated (+${written.newEvents} events)` : 'unchanged'}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const lines = [
      '## Referee run',
      `- actions: ${result.actions.length} (applied ${applied.done}, failed ${applied.failed.length})`,
      `- new events: ${written.newEvents}`,
      `- digests written: ${[...digests.files.keys()].filter((k) => k.endsWith('.json') && k !== DIGEST_INDEX).length}`,
      ...result.actions.map((a) => `  - ${a.type} #${a.number}`),
      ...applied.failed.map((f) => `- ❌ ${f.action.type} #${f.action.number}: ${f.error}`),
    ];
    appendFileSync(summaryPath, `${lines.join('\n')}\n`);
  }
  // A failed action is retried next run (everything is idempotent), but the run goes red so it's visible.
  if (applied.failed.length || chronicleFailures) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
