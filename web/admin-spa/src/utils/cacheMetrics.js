/**
 * Compute aggregate cache hit rate.
 *
 * Formula: cacheRead / (input + cacheRead + cacheCreate) × 100
 * Meaning: of all input-side tokens, what fraction was served at the
 *          (cheap) cache-read price. Directly maps to "how much money the
 *          cache saved me" for the user.
 *
 * NOTE: This is intentionally different from the per-request rate computed
 * in `src/utils/requestDetailHelper.js:calculateCacheHitRate()`. That one
 * uses platform-specific denominators for single-record diagnostic display.
 * This one is for cross-request aggregates and treats Claude/OpenAI
 * uniformly, since aggregated buckets have no per-request platform info.
 * For OpenAI keys cacheCreateTokens is always 0, so the formula naturally
 * degrades to `read / (input + read)`, matching the per-request semantics.
 *
 * @param {object} stats
 * @param {number} [stats.inputTokens]
 * @param {number} [stats.cacheReadTokens]
 * @param {number} [stats.cacheCreateTokens]
 * @returns {{ rate: number, hasData: boolean }}
 *   rate: percentage with 2 decimal places, or 0 when no data
 *   hasData: false when denominator is 0 (caller should render "—")
 */
export function calculateAggregateCacheHitRate(stats = {}) {
  const input = Math.max(0, Number(stats.inputTokens) || 0)
  const read = Math.max(0, Number(stats.cacheReadTokens) || 0)
  const create = Math.max(0, Number(stats.cacheCreateTokens) || 0)
  const denominator = input + read + create

  if (denominator <= 0) {
    return { rate: 0, hasData: false }
  }

  return {
    rate: Number(((read / denominator) * 100).toFixed(2)),
    hasData: true
  }
}

/**
 * Map a hit-rate percentage to a Tailwind color class for visual cue.
 * Tiers: ≥50 green, 20–50 orange, <20 red.
 */
export function cacheHitRateColorClass(rate) {
  if (rate >= 50) {
    return 'text-green-600 dark:text-green-400'
  }
  if (rate >= 20) {
    return 'text-orange-500 dark:text-orange-400'
  }
  return 'text-red-500 dark:text-red-400'
}
