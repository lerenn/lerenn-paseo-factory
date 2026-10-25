export const INTERVAL_ENV = "PASEO_WARDEN_INTERVAL";

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Parse a default interval: a bare number is seconds ("900"); a duration string combines
 * number+unit pairs ("15m", "90s", "1h30m", "2h"). Returns minutes, at least 1 and at most 1440.
 * Throws on anything else.
 */
export function parseInterval(value: string): number {
  const text = value.trim().toLowerCase();
  let seconds: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    seconds = Number(text);
  } else if (/^(\d+(\.\d+)?[smhd])+$/.test(text)) {
    seconds = 0;
    for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) seconds += Number(n) * UNIT_SECONDS[unit];
  } else {
    throw new Error(`${INTERVAL_ENV}="${value}" is not an interval; use seconds ("900") or a duration ("15m", "1h30m").`);
  }
  if (seconds <= 0) throw new Error(`${INTERVAL_ENV}="${value}" must be greater than zero.`);
  return Math.min(1440, Math.max(1, Math.ceil(seconds / 60)));
}
