/**
 * OpenCode-dedicated route mounted at /opencode.
 *
 * Provides /opencode/v1/messages for OpenCode clients that send
 * interleaved-thinking responses. Applies a minimal,
 * opencode-anthropic-auth-compatible transform pipeline at the entry
 * layer, then marks the request so the downstream Claude relay skips
 * mutation passes that would invalidate thinking-block signatures.
 *
 * Reuses the main /api/v1/messages handler for all account scheduling,
 * rate limiting, queue management, and cost accounting — only the
 * body-transform shape differs.
 *
 * Configuration on the OpenCode side: set the Anthropic base URL to
 *   https://<your-relay-host>/opencode
 * and use the same `cr_` API key as for /api.
 */

const express = require('express')
const { authenticateApiKey } = require('../middleware/auth')
const { handleMessagesRequest } = require('./api')
const openCodeTransform = require('../services/openCodeTransform')
const logger = require('../utils/logger')

const router = express.Router()

/**
 * Mark the request as OpenCode-mode and apply the entry-layer transform.
 *
 * The flag `req._openCodeMode` is read by the shared handleMessagesRequest
 * (in routes/api.js) to forward `isOpenCodeMode: true` into the relay
 * service options, which short-circuits the mutation-heavy
 * `_processRequestBody` path and disables the in-relay tool-name
 * transform (since this middleware already applied the prefix).
 */
function applyOpenCodeTransform(req, res, next) {
  req._openCodeMode = true

  if (req.body && typeof req.body === 'object') {
    try {
      req.body = openCodeTransform.rewriteRequestBody(req.body)
    } catch (error) {
      logger.warn('⚠️ [OpenCode] Failed to rewrite request body, forwarding as-is:', error.message)
    }
  }

  next()
}

router.post('/v1/messages', applyOpenCodeTransform, authenticateApiKey, handleMessagesRequest)

module.exports = router
