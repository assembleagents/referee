// Rendering participant-controlled text safely in anything the referee
// publishes under its own name (comments, check runs, chronicle issues).

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Renders participant-controlled text as inline code, so it can't become a
 * link, image or @mention.
 */
export function code(s: string, max = 200): string {
  const clean = truncate(s.replace(/[`\r\n\t]/g, ' ').replace(/\|/g, '/'), max).trim();
  return `\`${clean || ' '}\``;
}
