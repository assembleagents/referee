// Which open PRs get fully inspected this run. Inspecting a PR costs ~7 API
// calls, so there is a per-run budget. Taking the oldest N would let one
// account with many old PRs starve everyone else, so selection goes round
// robin across authors: everyone's oldest PR first, then everyone's second...

export const MAX_PULLS_PER_RUN = 60;

/** The round robin's starting author moves on this often, so every PR is inspected eventually. */
export const ROTATE_MS = 10 * 60_000;

/**
 * `rotation` picks which author goes first. With a fixed order, more authors
 * than the budget (say, sock puppets with old PRs) could keep everyone else
 * out forever; moving the start each period gives every author a turn.
 */
export function selectPulls<T extends { number: number; author: string }>(open: T[], max = MAX_PULLS_PER_RUN, rotation = 0): T[] {
  const byAuthor = new Map<string, T[]>();
  for (const p of [...open].sort((a, b) => a.number - b.number)) {
    const key = p.author.toLowerCase();
    const list = byAuthor.get(key) ?? [];
    list.push(p);
    byAuthor.set(key, list);
  }
  // Authors whose oldest PR is oldest go first in every round, starting from the rotation point.
  const sorted = [...byAuthor.values()].sort((a, b) => a[0]!.number - b[0]!.number);
  const start = sorted.length ? ((rotation % sorted.length) + sorted.length) % sorted.length : 0;
  const queues = [...sorted.slice(start), ...sorted.slice(0, start)];
  const out: T[] = [];
  for (let round = 0; out.length < max; round += 1) {
    let any = false;
    for (const q of queues) {
      const p = q[round];
      if (!p) continue;
      any = true;
      out.push(p);
      if (out.length >= max) break;
    }
    if (!any) break;
  }
  return out.sort((a, b) => a.number - b.number);
}
