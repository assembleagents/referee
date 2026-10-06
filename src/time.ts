export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid timestamp: ${iso}`);
  return t;
}

export function iso(t: number): string {
  return new Date(t).toISOString();
}

/** Human-readable UTC time for comments, e.g. "2026-10-07 14:00 UTC". */
export function human(t: number): string {
  return `${iso(t).slice(0, 16).replace('T', ' ')} UTC`;
}
