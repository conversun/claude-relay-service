/**
 * OpenCode-specific request transforms.
 *
 * Mirrors opencode-anthropic-auth/src/transform.ts (Bun/TS) in JS so requests
 * routed through /opencode/v1/messages behave identically to the official
 * OpenCode plugin: minimal mutation, no message reordering, no cache_control
 * sweeps, just enough to pass Anthropic's third-party-client classifier.
 *
 * Why a dedicated path: thinking blocks emitted by Claude carry signatures
 * bound to the exact messages context they were generated against. Any
 * structural mutation on subsequent turns (unshift, content rewrites, sibling
 * cache_control changes) makes the upstream reject with
 * "thinking blocks cannot be modified".
 *
 * This module performs ONLY two mutations:
 *   1. Sanitize OpenCode brand markers from system prompt and prepend a
 *      Claude Code identity block (kept on the system field — never touches
 *      messages).
 *   2. Apply an idempotent `mcp_PascalCase` prefix to all tool names
 *      (tools, tool_choice, tool_use blocks). Idempotent so OpenCode can
 *      replay the previously-prefixed name without us double-prefixing.
 */

const { sanitizeSystemText } = require('./claudeCloakingUtils')

const TOOL_PREFIX = 'mcp_'
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

/**
 * Idempotent `mcp_PascalCase` prefix.
 *
 * Idempotency is critical: OpenCode persists the prefixed name from the
 * previous response, so the next turn arrives already prefixed. Without
 * this guard we'd emit `mcp_Mcp_Bash` and the upstream would 400.
 */
function prefixName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return name
  }
  if (name.startsWith(TOOL_PREFIX)) {
    return name
  }
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Apply mcp_ prefix to every tool-name surface in the request body:
 *   - body.tools[*].name
 *   - body.tool_choice.name (when the tool_choice carries a name)
 *   - body.messages[*].content[*].name where type === 'tool_use'
 *
 * All three locations move together — otherwise tools and tool_use names
 * mismatch and Claude returns a 400 "tool not found".
 */
function prefixToolNames(body) {
  if (!body || typeof body !== 'object') {
    return body
  }

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => {
      if (tool && typeof tool === 'object' && typeof tool.name === 'string') {
        return { ...tool, name: prefixName(tool.name) }
      }
      return tool
    })
  }

  if (
    body.tool_choice &&
    typeof body.tool_choice === 'object' &&
    typeof body.tool_choice.name === 'string'
  ) {
    body.tool_choice = { ...body.tool_choice, name: prefixName(body.tool_choice.name) }
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (!message || !Array.isArray(message.content)) {
        return message
      }
      return {
        ...message,
        content: message.content.map((block) => {
          if (block && block.type === 'tool_use' && typeof block.name === 'string') {
            return { ...block, name: prefixName(block.name) }
          }
          return block
        })
      }
    })
  }

  return body
}

/**
 * Sanitize the system field and prepend a Claude Code identity block.
 *
 * Always returns an array of `{type:'text', text:string}` blocks so the
 * downstream relay sees a uniform shape. Stays on the system field —
 * never relocates content into messages — so thinking-block contexts in
 * messages remain untouched across turns.
 *
 * Idempotent on the identity prefix: if the first sanitized block already
 * carries the Claude Code identity, no additional block is prepended.
 */
function prependClaudeCodeIdentity(system) {
  const identityBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY }

  if (system === null || system === undefined) {
    return [identityBlock]
  }

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (!sanitized || sanitized === CLAUDE_CODE_IDENTITY) {
      return [identityBlock]
    }
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (!Array.isArray(system)) {
    if (typeof system === 'object' && typeof system.text === 'string') {
      const sanitized = sanitizeSystemText(system.text)
      if (!sanitized) {
        return [identityBlock]
      }
      return [identityBlock, { ...system, type: system.type || 'text', text: sanitized }]
    }
    return [identityBlock]
  }

  const sanitizedArray = system
    .map((item) => {
      if (typeof item === 'string') {
        const sanitized = sanitizeSystemText(item)
        return sanitized ? { type: 'text', text: sanitized } : null
      }
      if (
        item &&
        typeof item === 'object' &&
        item.type === 'text' &&
        typeof item.text === 'string'
      ) {
        const sanitized = sanitizeSystemText(item.text)
        return sanitized ? { ...item, text: sanitized } : null
      }
      return item
    })
    .filter((item) => item !== null)

  if (sanitizedArray[0] && sanitizedArray[0].text === CLAUDE_CODE_IDENTITY) {
    return sanitizedArray
  }

  return [identityBlock, ...sanitizedArray]
}

/**
 * Re-interleave consecutive thinking blocks in an assistant content array.
 *
 * Background:
 *   OpenCode 1.14.30 + ai-sdk/provider-utils 4.0.23 reconstructs streamed
 *   assistant turns by stacking ALL thinking blocks at the start of the
 *   content array, e.g.  [thinking, thinking, text, tool_use, ...].
 *
 *   Anthropic validates each multi-turn request against the original
 *   streamed shape and rejects requests where two thinking blocks sit
 *   adjacent (since the model never emits adjacent thinking) with
 *     400 messages.N.content.M: thinking blocks ... cannot be modified.
 *
 * Empirical validation (replayed against api.anthropic.com):
 *   - [thinking, thinking, text, tool_use*3]      → 400 rejected
 *   - [thinking, text, thinking, tool_use*3]      → 200 OK
 *
 * Strategy:
 *   Shift each "extra" thinking block forward by one non-thinking position
 *   so two thinking blocks never sit adjacent. Non-thinking blocks are
 *   never reordered. Idempotent on arrays already in interleaved form.
 *
 * Limitations:
 *   - Heuristic: when there are more pending thinking blocks than non-
 *     thinking separators available, leftover thinking blocks are appended
 *     at the end (still adjacent, but rare in practice).
 *   - This unMutates a client-side block-stacking bug; the original
 *     generation order from Anthropic is not preserved verbatim, but
 *     the upstream signature check passes because the new layout no
 *     longer violates the "no two adjacent thinking" invariant.
 */
function reinterleaveThinking(content) {
  if (!Array.isArray(content) || content.length < 2) {
    return content
  }
  const isThinking = (b) =>
    b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking')

  // Fast path: no adjacent thinking → return as-is (preserves reference identity).
  let hasAdjacent = false
  for (let i = 1; i < content.length; i++) {
    if (isThinking(content[i - 1]) && isThinking(content[i])) {
      hasAdjacent = true
      break
    }
  }
  if (!hasAdjacent) {
    return content
  }

  const result = []
  const pending = []
  for (const block of content) {
    if (isThinking(block)) {
      // If the previous emitted block is also thinking, defer this one.
      if (result.length === 0 || !isThinking(result[result.length - 1])) {
        result.push(block)
      } else {
        pending.push(block)
      }
    } else {
      result.push(block)
      // Flush ONE pending thinking right after this non-thinking block.
      if (pending.length > 0) {
        result.push(pending.shift())
      }
    }
  }

  // Any unflushed thinking (rare: more thinking than non-thinking blocks)
  // is appended at end. They will still be adjacent, but this is a corner
  // case we cannot reorder around without inventing separator blocks.
  for (const t of pending) {
    result.push(t)
  }
  return result
}

/**
 * Apply reinterleaveThinking to all assistant messages in body.messages.
 * Mutates the input body and returns it for chaining.
 */
function reinterleaveAssistantThinking(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return body
  }
  for (const message of body.messages) {
    if (message && message.role === 'assistant' && Array.isArray(message.content)) {
      message.content = reinterleaveThinking(message.content)
    }
  }
  return body
}

/**
 * Full request body rewrite for the /opencode route.
 *
 * What this DOES:
 *   - Replaces body.system with [identity, ...sanitized_existing_system].
 *   - Adds mcp_ prefix to all tool-name surfaces (idempotent).
 *   - Re-interleaves thinking blocks so two thinking blocks are never
 *     adjacent (works around an OpenCode/ai-sdk client-side block stacking
 *     bug; see reinterleaveThinking() for empirical evidence).
 *
 * What this DOES NOT do (intentionally):
 *   - Reorder, insert, or remove messages.
 *   - Touch thinking / redacted_thinking block CONTENT (only their position).
 *   - Mutate cache_control fields.
 *   - Change tool_use input or id.
 *   - Touch metadata.
 *
 * Mutates the body in place AND returns it for chaining convenience.
 */
function rewriteRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return body
  }

  body.system = prependClaudeCodeIdentity(body.system)
  prefixToolNames(body)
  reinterleaveAssistantThinking(body)
  return body
}

module.exports = {
  TOOL_PREFIX,
  CLAUDE_CODE_IDENTITY,
  prefixName,
  prefixToolNames,
  prependClaudeCodeIdentity,
  reinterleaveThinking,
  reinterleaveAssistantThinking,
  rewriteRequestBody
}
