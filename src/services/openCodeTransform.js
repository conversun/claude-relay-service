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
 * Full request body rewrite for the /opencode route.
 *
 * What this DOES:
 *   - Replaces body.system with [identity, ...sanitized_existing_system].
 *   - Adds mcp_ prefix to all tool-name surfaces (idempotent).
 *
 * What this DOES NOT do (intentionally):
 *   - Reorder, insert, or remove messages.
 *   - Touch thinking / redacted_thinking blocks.
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
  return body
}

module.exports = {
  TOOL_PREFIX,
  CLAUDE_CODE_IDENTITY,
  prefixName,
  prefixToolNames,
  prependClaudeCodeIdentity,
  rewriteRequestBody
}
