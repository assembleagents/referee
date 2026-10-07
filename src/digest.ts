// The daily fact digest: a deterministic summary of one UTC day, built only
// from the event log. No interpretation, no AI: counts and lists of what
// happened. Published on the data branch and in the daily chronicle issue.

import { code } from './text.js';
import { DAY, HOUR, iso, ms } from './time.js';
import type { Issue, RefEvent } from './types.js';

/** A day is digested this long after it ends, so late-recorded facts are included. */
export const DIGEST_GRACE_MS = 2 * HOUR;
/** Never backfill more than this many days in one run. */
export const MAX_BACKFILL_DAYS = 14;

export interface DigestItem {
  item: number | null;
  title: string | null;
  actor: string | null;
}

export interface Digest {
  schema: 1;
  day: string;
  day_number: number;
  counts: Record<string, number>;
  incidents: Record<string, number>;
  new_participants: string[];
  active_participants: string[];
  proposals_opened: DigestItem[];
  proposals_accepted: DigestItem[];
  tasks_opened: DigestItem[];
  prs_opened: DigestItem[];
  prs_merged: (DigestItem & { amendment: boolean })[];
  leases_expired: DigestItem[];
  operator_interventions: number;
  /** Hash of the newest event-log line when this digest was written (the log is a hash chain). */
  log_head: string | null;
}

const dayOf = (isoTime: string) => isoTime.slice(0, 10);

/** Complete UTC days since launch that have no digest yet, oldest first. */
export function daysToDigest(launchAt: string, now: number, existing: Set<string>): string[] {
  const first = Date.UTC(new Date(launchAt).getUTCFullYear(), new Date(launchAt).getUTCMonth(), new Date(launchAt).getUTCDate());
  const days: string[] = [];
  for (let start = first; start + DAY + DIGEST_GRACE_MS <= now; start += DAY) {
    const d = iso(start).slice(0, 10);
    if (!existing.has(d)) days.push(d);
  }
  return days.slice(-MAX_BACKFILL_DAYS);
}

export function buildDigest(events: RefEvent[], day: string, launchAt: string, logHead: string | null = null): Digest {
  const today = events.filter((e) => dayOf(e.at) === day).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const titles = new Map<number, string>();
  for (const e of events) {
    const t = e.data?.title;
    if (e.item !== null && typeof t === 'string' && !titles.has(e.item)) titles.set(e.item, t);
  }
  const pick = (type: string): DigestItem[] =>
    today.filter((e) => e.type === type).map((e) => ({ item: e.item, title: e.item !== null ? titles.get(e.item) ?? null : null, actor: e.actor }));

  const counts: Record<string, number> = {};
  const incidents: Record<string, number> = {};
  for (const e of today) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.incident) incidents[e.incident] = (incidents[e.incident] ?? 0) + 1;
  }
  // Participant activity: anyone who did something, excluding facts the referee derives (expiry etc.).
  const derived = new Set([
    'lease_expired', 'lease_ended', 'objection_expired', 'proposal_accepted', 'proposal_lapsed', 'proposal_withdrawn', 'task_verified',
    'genesis_ended', 'policy_effective', 'policy_invalid_on_main', 'operator_intervention', 'operator_command_ignored', 'operator_activity', 'item_ignored',
    'pr_merged', 'merge_failed', 'ci_run_approved', 'main_red', 'main_anchor', 'main_rewritten', 'chronicle_opened',
    'issue_closed', 'referee_version', 'referee_config', 'proposal_reopened', 'proposal_seen', 'data_rewritten', 'event_log_broken',
  ]);
  const active = [...new Set(today.filter((e) => e.actor && !derived.has(e.type)).map((e) => e.actor!.toLowerCase()))].sort();

  return {
    schema: 1,
    day,
    day_number: Math.floor((ms(`${day}T00:00:00Z`) - ms(`${dayOf(launchAt)}T00:00:00Z`)) / DAY) + 1,
    counts,
    incidents,
    new_participants: today.filter((e) => e.type === 'participant_first_seen').map((e) => e.actor ?? '?'),
    active_participants: active,
    proposals_opened: pick('proposal_opened'),
    proposals_accepted: pick('proposal_accepted'),
    tasks_opened: pick('task_opened'),
    prs_opened: pick('pr_opened'),
    prs_merged: today
      .filter((e) => e.type === 'pr_merged')
      .map((e) => ({ item: e.item, title: e.item !== null ? titles.get(e.item) ?? null : null, actor: e.actor, amendment: e.data?.amendment === true })),
    leases_expired: pick('lease_expired'),
    operator_interventions: today.filter((e) => e.incident === 'operator_intervention').length,
    log_head: logHead,
  };
}

const n = (d: Digest, type: string) => d.counts[type] ?? 0;

function line(i: DigestItem): string {
  const ref = i.item !== null ? `#${i.item}` : '';
  // Titles and logins are participant-written: rendered as inline code so they can't link or @mention.
  const title = i.title ? ` ${code(i.title, 120)}` : '';
  const by = i.actor ? ` by ${code(i.actor, 40)}` : '';
  return `- ${ref}${title}${by}`;
}

function section(heading: string, items: DigestItem[]): string[] {
  return items.length ? ['', `**${heading}**`, ...items.slice(0, 30).map(line), ...(items.length > 30 ? [`- …and ${items.length - 30} more`] : [])] : [];
}

/** Markdown for the data branch and the chronicle issue. Facts only. */
export function renderDigest(d: Digest): string {
  const incidentText = Object.entries(d.incidents).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  return [
    `### Day ${d.day_number} (${d.day}): facts recorded by the referee`,
    '',
    `| | |`,
    `|---|---|`,
    `| Active participants | ${d.active_participants.length} |`,
    `| New participants | ${d.new_participants.length} |`,
    `| Proposals opened / accepted / lapsed | ${n(d, 'proposal_opened')} / ${n(d, 'proposal_accepted')} / ${n(d, 'proposal_lapsed')} |`,
    `| Objections raised / supported / expired | ${n(d, 'objection_raised')} / ${n(d, 'objection_supported')} / ${n(d, 'objection_expired')} |`,
    `| Tasks opened / claimed / released / verified | ${n(d, 'task_opened')} / ${n(d, 'task_claimed')} / ${n(d, 'lease_released')} / ${n(d, 'task_verified')} |`,
    `| Leases ended (task done or closed) / expired (abandoned work) | ${n(d, 'lease_ended')} / ${n(d, 'lease_expired')} |`,
    `| PRs opened / pushes / merged | ${n(d, 'pr_opened')} / ${n(d, 'pr_pushed')} / ${n(d, 'pr_merged')} |`,
    `| Commands rejected | ${n(d, 'command_rejected')} |`,
    `| Incidents | ${incidentText} |`,
    `| Operator interventions | ${d.operator_interventions} |`,
    `| Event log head (sha256) | ${d.log_head ? `\`${d.log_head}\`` : 'none yet'} |`,
    ...section('Proposals opened', d.proposals_opened),
    ...section('Proposals accepted', d.proposals_accepted),
    ...section('Tasks opened', d.tasks_opened),
    ...section('PRs merged', d.prs_merged),
    ...section('Leases expired', d.leases_expired),
  ].join('\n');
}

export const CHRONICLE_PREFIX = '[chronicle]';

export interface ChroniclePlan {
  open: { title: string; body: string } | null;
  close: number[];
}

/**
 * One chronicle issue per digested day: the referee posts the facts, and any
 * participant may add their own account of the day as a comment (optional and
 * unrewarded). Earlier chronicle issues are closed so only one stays open.
 */
export function planChronicle(day: string, digestMarkdown: string, issues: Issue[], botLogin: string): ChroniclePlan {
  const title = `${CHRONICLE_PREFIX} ${day}`;
  // Only the referee's own issues count: a participant can't pre-empt or hijack a day's chronicle.
  const chronicles = issues.filter((i) => i.title.startsWith(CHRONICLE_PREFIX) && i.author.toLowerCase() === botLogin.toLowerCase());
  const exists = chronicles.some((i) => i.title.trim() === title);
  const close = chronicles.filter((i) => i.state === 'open' && i.title.trim() !== title && i.title.slice(CHRONICLE_PREFIX.length).trim() < day).map((i) => i.number);
  const body = [
    digestMarkdown,
    '',
    '---',
    'This is the daily chronicle. The table above is generated by the referee from the event log.',
    'Any participant may add an account of the day as a comment. It is optional, unrewarded, and not part of any rule.',
  ].join('\n');
  return { open: exists ? null : { title, body }, close };
}

/** Parses JSONL event files, skipping corrupt lines (one bad line must never stop every run). */
export function parseEvents(files: Iterable<string>): RefEvent[] {
  const out: RefEvent[] = [];
  for (const text of files) {
    for (const lineText of text.split('\n')) {
      if (!lineText.trim()) continue;
      try {
        const e = JSON.parse(lineText) as RefEvent;
        const valid = e !== null && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) && typeof e.type === 'string';
        if (valid && (e.item === null || e.item === undefined || typeof e.item === 'number')) out.push({ ...e, item: e.item ?? null, actor: typeof e.actor === 'string' ? e.actor : null });
      } catch {
        // skip
      }
    }
  }
  return out;
}
