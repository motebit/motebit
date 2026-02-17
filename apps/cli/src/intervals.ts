const UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseInterval(s: string): number {
  const match = s.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Invalid interval "${s}". Use e.g. "30m", "1h", "1d".`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = UNITS[match[2]!]!;
  if (value <= 0) {
    throw new Error(`Interval value must be positive, got ${value}.`);
  }
  return value * unit;
}
