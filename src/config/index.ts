export const RELAY_RATE_LIMIT = (() => {
  const raw = process.env.VEIL_RELAY_RATE_LIMIT;
  if (raw === undefined) return 60;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid VEIL_RELAY_RATE_LIMIT value: "${raw}". Must be a positive integer.`);
  }
  return parsed;
})();