/**
 * CCH Billing Header Helper
 *
 * Computes the `x-anthropic-billing-header` value that Anthropic's official
 * Claude Code CLI prepends to its system[] array as the first text block.
 * The header is a soft fingerprint Anthropic's classifier likely cross-checks
 * against client UA + system prompt content; missing/wrong values increase
 * the chance of being flagged as a third-party CLI.
 *
 * Header shape:
 *   x-anthropic-billing-header: cc_version=<ver>.<3hex>; cc_entrypoint=<ep>; cch=<5hex>;
 *
 * Algorithm:
 *   - cch        = SHA256(firstUserMessageText).slice(0, 5)
 *   - suffix     = SHA256(`${CCH_SALT}${chars}${version}`).slice(0, 3)
 *                  where chars = sampled characters of the same text at
 *                  CCH_POSITIONS (default char fallback = '0').
 *
 * Ported byte-for-byte from opencode-anthropic-auth/src/cch.ts at upstream
 * commit fdc7837 (origin/main HEAD as of 2026-04-30). Parity verified by
 * tests/cchHelper.test.js against upstream's known vectors.
 *
 * IMPORTANT: This module is intentionally NOT wired into _processRequestBody
 * yet. Wiring is a separate decision (see P3 in the OpenCode posture
 * roadmap) — the current relay still actively REMOVES client-supplied
 * billing headers via _removeBillingHeaderFromSystem and does not inject
 * a server-side replacement. This helper exists to make that wiring a
 * one-liner when the integration is sanctioned.
 */

const { createHash } = require('crypto')

// 🔒 Upstream-mirrored constants. Drift-checked by
//    scripts/sync-cloaking-constants.sh against
//    https://raw.githubusercontent.com/ex-machina-co/opencode-anthropic-auth/main/src/constants.ts
//    Do NOT edit these without running the drift checker afterwards.
const CCH_SALT = '59cf53e54c78'
const CCH_POSITIONS = [4, 7, 20]
const CLAUDE_CODE_VERSION = '2.1.87'
const CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'

/**
 * Extract text from the first user message's first text block.
 * Mirrors upstream's behaviour:
 *   - string content → return as-is
 *   - array content → return first block where type === 'text'
 *   - no user message / no text block → ''
 *
 * @param {Array} messages - Anthropic-shaped messages array
 * @returns {string}
 */
function extractFirstUserMessageText(messages) {
  if (!Array.isArray(messages)) {
    return ''
  }
  const userMsg = messages.find((message) => message && message.role === 'user')
  if (!userMsg) {
    return ''
  }

  const { content } = userMsg
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block && block.type === 'text')
    if (textBlock && typeof textBlock.text === 'string' && textBlock.text) {
      return textBlock.text
    }
  }

  return ''
}

/**
 * Compute the 5-char cch hash: SHA-256(messageText).slice(0, 5).
 *
 * @param {string} messageText
 * @returns {string} 5-char lowercase hex
 */
function computeCCH(messageText) {
  return createHash('sha256').update(String(messageText)).digest('hex').slice(0, 5)
}

/**
 * Compute the 3-char version suffix from sampled chars.
 *
 * Samples chars at CCH_POSITIONS (with '0' fallback for out-of-bounds),
 * concatenates SALT + chars + version, takes first 3 hex of SHA-256.
 *
 * @param {string} messageText
 * @param {string} version - default CLAUDE_CODE_VERSION
 * @returns {string} 3-char lowercase hex
 */
function computeVersionSuffix(messageText, version = CLAUDE_CODE_VERSION) {
  const text = String(messageText)
  const chars = CCH_POSITIONS.map((index) => text[index] || '0').join('')

  return createHash('sha256').update(`${CCH_SALT}${chars}${version}`).digest('hex').slice(0, 3)
}

/**
 * Build the complete billing header string for insertion into system[0].
 *
 * @param {Array} messages - messages array
 * @param {string} version - default CLAUDE_CODE_VERSION
 * @param {string} entrypoint - default CLAUDE_CODE_ENTRYPOINT (e.g. 'sdk-cli')
 * @returns {string} full `x-anthropic-billing-header: ...;` line
 */
function buildBillingHeaderValue(
  messages,
  version = CLAUDE_CODE_VERSION,
  entrypoint = CLAUDE_CODE_ENTRYPOINT
) {
  const text = extractFirstUserMessageText(messages)
  const suffix = computeVersionSuffix(text, version)
  const cch = computeCCH(text)

  return (
    'x-anthropic-billing-header: ' +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=${cch};`
  )
}

module.exports = {
  // functions
  extractFirstUserMessageText,
  computeCCH,
  computeVersionSuffix,
  buildBillingHeaderValue,
  // constants
  CCH_SALT,
  CCH_POSITIONS,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_ENTRYPOINT
}
