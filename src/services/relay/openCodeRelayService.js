/**
 * OpenCode Relay Service - 零 mutation OpenCode 通道
 *
 * 设计目标：在 relay 内为 OpenCode 客户端提供与 opencode-anthropic-auth plugin
 * 完全等价的转发行为：
 *   - 完全 bypass claudeRelayService 的 mutation pipeline
 *     （_processRequestBody / _applyRequestIdentityTransform /
 *      _transformToolNamesInRequestBody / _stripTtlFromCacheControl 等）
 *   - 路由层 applyOpenCodeTransform 已完成 system 清洗 + Claude Code identity
 *     前置 + tool 名 mcp_ 前缀；本 service 拿到的 body 直接 byte-for-byte
 *     转发，确保多轮请求中 thinking blocks 的 cryptographic signature 不被
 *     破坏（Anthropic 严格校验 byte-equality）。
 *   - 强制注入 anthropic-beta: oauth-2025-04-20 + interleaved-thinking-2025-05-14
 *     （opencode-anthropic-auth 的 REQUIRED_BETAS）
 *   - 复用 unifiedClaudeScheduler 调度账号、claudeAccountService 取 OAuth token、
 *     ProxyHelper 代理、限流/计费/错误标记机制
 *
 * 适用范围：仅支持 claude-official 账号（OAuth 路径）。其他账号类型由路由层
 * 提前甄别，本 service 不做兜底转发。
 */

const https = require('https')
const { URL } = require('url')
const config = require('../../../config/config')
const logger = require('../../utils/logger')
const sessionHelper = require('../../utils/sessionHelper')
const { filterForClaude } = require('../../utils/headerFilter')
const { getHttpsAgentForStream } = require('../../utils/performanceOptimizer')
const ProxyHelper = require('../../utils/proxyHelper')
const claudeAccountService = require('../account/claudeAccountService')
const unifiedClaudeScheduler = require('../scheduler/unifiedClaudeScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const { isStreamWritable } = require('../../utils/streamHelper')

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages?beta=true'

// opencode-anthropic-auth REQUIRED_BETAS
// 这两个 beta 缺一会让多轮 thinking blocks 报 "thinking blocks cannot be modified"
const REQUIRED_BETAS = ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14']

class OpenCodeRelayService {
  // 🌊 流式转发主入口
  //
  // 调用者责任：预先通过 unifiedClaudeScheduler.selectAccountForApiKey 选好账号，
  // 并且确保 accountType === 'claude-official'。这里不再重复调度，与
  // claudeRelayService 的账号调度保持一致。
  async relayStream({
    requestBody,
    apiKeyData,
    responseStream,
    clientHeaders,
    usageCallback,
    accountId,
    accountType,
    sessionHash
  }) {
    if (!accountId) {
      throw new Error('OpenCodeRelayService.relayStream requires accountId from upstream scheduler')
    }
    if (accountType !== 'claude-official') {
      const error = new Error(`OpenCode mode requires claude-official account, got: ${accountType}`)
      error.code = 'OPENCODE_UNSUPPORTED_ACCOUNT_TYPE'
      throw error
    }

    const effectiveSessionHash = sessionHash || sessionHelper.generateSessionHash(requestBody)
    let succeeded = false

    try {
      logger.info(
        `📡 [OpenCode] Stream relay for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId}${
          effectiveSessionHash ? `, session: ${effectiveSessionHash}` : ''
        }`
      )

      // 2. 拿 OAuth access token（getValidAccessToken 内部会自动 refresh）
      const accessToken = await claudeAccountService.getValidAccessToken(accountId)
      if (!accessToken) {
        throw new Error(`No valid access token for account ${accountId}`)
      }

      // 3. 拿账号信息（用于代理 + UA 等）
      const account = await claudeAccountService.getAccount(accountId)

      // 4. 拿代理 agent
      const proxyAgent = await this._getProxyAgent(accountId, account)

      // 5. 构建 headers（透传 client + 注入 OAuth + 强制 REQUIRED_BETAS）
      const bodyString = JSON.stringify(requestBody)
      const contentLength = Buffer.byteLength(bodyString, 'utf8')
      const headers = this._buildHeaders(clientHeaders, accessToken, contentLength)

      // 6. 发起 HTTPS 流式请求
      await this._streamRequest({
        bodyString,
        headers,
        proxyAgent,
        responseStream,
        accountId,
        accountType,
        sessionHash: effectiveSessionHash,
        account,
        apiKeyData,
        usageCallback
      })
      succeeded = true
    } catch (error) {
      logger.error(
        `❌ [OpenCode] Stream relay error for account ${accountId}: ${error.message}`,
        error
      )
      if (!succeeded) {
        this._sendErrorIfWritable(responseStream, 500, error.message || 'OpenCode relay error')
      }
      throw error
    }
  }

  // 🔧 构建 headers：透传 client + 注入 OAuth + 合并 REQUIRED_BETAS
  _buildHeaders(clientHeaders, accessToken, contentLength) {
    // filterForClaude 用白名单挑出可透传的 headers（同时排除 host/content-length/auth/x-api-key）
    const filtered = filterForClaude(clientHeaders || {})

    // 合并 anthropic-beta：客户端 betas + REQUIRED_BETAS（去重）
    const clientBetas = (filtered['anthropic-beta'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const mergedBetas = Array.from(new Set([...REQUIRED_BETAS, ...clientBetas])).join(',')

    return {
      ...filtered,
      host: 'api.anthropic.com',
      'content-type': 'application/json',
      'content-length': String(contentLength),
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': mergedBetas,
      'anthropic-version': filtered['anthropic-version'] || '2023-06-01',
      // 强制 identity 编码避免 Cloudflare 返 gzip 不带 Content-Encoding 头导致 SSE 损坏
      'accept-encoding': 'identity'
      // 注：filterForClaude 是白名单过滤，本身就不会透传 x-api-key；并且上面用
      // authorization: Bearer 覆盖授权。不必（也不能）在此写 'x-api-key': undefined—
      // Node.js https.request 拒绝 undefined header 值（ERR_HTTP_INVALID_HEADER_VALUE）。
    }
  }

  // 🌐 实际发起流式请求 + SSE 透传 + usage 捕获 + 错误处理
  _streamRequest({
    bodyString,
    headers,
    proxyAgent,
    responseStream,
    accountId,
    accountType,
    sessionHash,
    account,
    apiKeyData,
    usageCallback
  }) {
    return new Promise((resolve, reject) => {
      const url = new URL(ANTHROPIC_API_URL)
      const requestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers,
        agent: proxyAgent || getHttpsAgentForStream(),
        timeout: config.requestTimeout || 600000
      }

      const upstreamReq = https.request(requestOptions, async (upstreamRes) => {
        logger.debug(
          `🌊 [OpenCode] Upstream stream response: ${upstreamRes.statusCode} for account ${accountId}`
        )

        if (upstreamRes.statusCode !== 200) {
          await this._handleUpstreamError({
            upstreamRes,
            responseStream,
            accountId,
            accountType,
            sessionHash,
            account,
            apiKeyData,
            resolve,
            _reject: reject
          })
          return
        }

        // 200 OK：透传 headers
        if (!responseStream.headersSent) {
          responseStream.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          })
        }

        // SSE 透传 + usage 解析（边收边解析，确保不破坏字节流）
        let sseBuffer = ''
        let currentUsage = {}
        const allUsage = []

        const onData = (chunk) => {
          if (isStreamWritable(responseStream)) {
            responseStream.write(chunk)
          }
          // 解析 SSE 拿 usage
          sseBuffer += chunk.toString('utf8')
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data:')) {
              continue
            }
            const json = line.slice(5).trim()
            if (!json || json === '[DONE]') {
              continue
            }
            try {
              const data = JSON.parse(json)
              if (data.type === 'message_start' && data.message && data.message.usage) {
                currentUsage.input_tokens = data.message.usage.input_tokens || 0
                currentUsage.cache_creation_input_tokens =
                  data.message.usage.cache_creation_input_tokens || 0
                currentUsage.cache_read_input_tokens =
                  data.message.usage.cache_read_input_tokens || 0
                currentUsage.model = data.message.model
                if (
                  data.message.usage.cache_creation &&
                  typeof data.message.usage.cache_creation === 'object'
                ) {
                  currentUsage.cache_creation = {
                    ephemeral_5m_input_tokens:
                      data.message.usage.cache_creation.ephemeral_5m_input_tokens || 0,
                    ephemeral_1h_input_tokens:
                      data.message.usage.cache_creation.ephemeral_1h_input_tokens || 0
                  }
                }
              }
              if (
                data.type === 'message_delta' &&
                data.usage &&
                data.usage.output_tokens !== undefined
              ) {
                currentUsage.output_tokens = data.usage.output_tokens
                if (currentUsage.input_tokens !== undefined) {
                  allUsage.push({ ...currentUsage })
                  currentUsage = {}
                }
              }
            } catch (_) {
              // 单条 SSE JSON 解析失败不影响透传
            }
          }
        }

        upstreamRes.on('data', onData)

        upstreamRes.on('end', () => {
          if (isStreamWritable(responseStream)) {
            responseStream.end()
          }
          // 触发计费 callback
          if (usageCallback && typeof usageCallback === 'function') {
            for (const usage of allUsage) {
              try {
                usageCallback({ ...usage, accountId })
              } catch (cbError) {
                logger.warn(`⚠️ [OpenCode] Usage callback error: ${cbError.message}`)
              }
            }
          }
          resolve()
        })

        upstreamRes.on('error', (err) => {
          logger.error(`❌ [OpenCode] Upstream stream error: ${err.message}`)
          if (isStreamWritable(responseStream)) {
            responseStream.end()
          }
          reject(err)
        })
      })

      // 客户端断开：abort 上游
      const onClientClose = () => {
        if (!upstreamReq.destroyed) {
          logger.info(
            `🔌 [OpenCode] Client disconnected, aborting upstream for account ${accountId}`
          )
          upstreamReq.destroy()
        }
      }
      responseStream.once('close', onClientClose)

      upstreamReq.on('error', (err) => {
        logger.error(`❌ [OpenCode] Upstream request error: ${err.message}`)
        this._sendErrorIfWritable(responseStream, 502, err.message || 'Upstream request error')
        reject(err)
      })

      upstreamReq.on('timeout', () => {
        logger.warn(`⏱️ [OpenCode] Upstream timeout for account ${accountId}`)
        upstreamReq.destroy(new Error('Upstream request timeout'))
      })

      upstreamReq.write(bodyString)
      upstreamReq.end()
    })
  }

  // ❌ 处理上游非 200 响应：标记账号状态 + 错误透传
  async _handleUpstreamError({
    upstreamRes,
    responseStream,
    accountId,
    accountType,
    sessionHash,
    account,
    resolve,
    _reject
  }) {
    const { statusCode } = upstreamRes
    const bodyChunks = []
    await new Promise((done) => {
      upstreamRes.on('data', (chunk) => bodyChunks.push(chunk))
      upstreamRes.on('end', done)
      upstreamRes.on('error', done)
    })
    const errorBody = Buffer.concat(bodyChunks).toString('utf8')

    logger.error(
      `❌ [OpenCode] Upstream ${statusCode} for account ${account?.name || accountId}: ${errorBody.substring(0, 500)}`
    )

    // 401/403：token 失效 → 标记账号
    if (statusCode === 401 || statusCode === 403) {
      try {
        await upstreamErrorHelper
          .markTempUnavailable(accountId, accountType, statusCode, null)
          .catch(() => {})
      } catch (_) {
        // ignore
      }
    }

    // 429：限流 → 标记
    if (statusCode === 429) {
      const resetHeader = upstreamRes.headers
        ? upstreamRes.headers['anthropic-ratelimit-unified-reset']
        : null
      const parsedReset = resetHeader ? parseInt(resetHeader, 10) : NaN
      try {
        await unifiedClaudeScheduler.markAccountRateLimited(
          accountId,
          accountType,
          sessionHash,
          Number.isNaN(parsedReset) ? null : parsedReset
        )
        await upstreamErrorHelper
          .markTempUnavailable(
            accountId,
            accountType,
            429,
            upstreamErrorHelper.parseRetryAfter(upstreamRes.headers)
          )
          .catch(() => {})
      } catch (_) {
        // ignore
      }
    }

    // 5xx：上游错误 → 临时不可用
    if (statusCode >= 500 && statusCode < 600) {
      try {
        await upstreamErrorHelper
          .markTempUnavailable(accountId, accountType, statusCode, null)
          .catch(() => {})
      } catch (_) {
        // ignore
      }
    }

    // 透传错误给客户端
    if (isStreamWritable(responseStream)) {
      if (!responseStream.headersSent) {
        responseStream.writeHead(statusCode, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
      }
      responseStream.write('event: error\n')
      responseStream.write(
        `data: ${JSON.stringify({
          type: 'error',
          error: {
            type: 'upstream_error',
            status: statusCode,
            message: errorBody
          }
        })}\n\n`
      )
      responseStream.end()
    }

    // resolve（不 reject）以避免 router 再返一次错误
    resolve()
  }

  // 🌐 拿代理 agent
  async _getProxyAgent(accountId, account = null) {
    try {
      const accountData = account || (await claudeAccountService.getAccount(accountId))
      if (!accountData || !accountData.proxy) {
        return null
      }
      const proxyAgent = ProxyHelper.createProxyAgent(accountData.proxy)
      if (proxyAgent) {
        logger.info(
          `🌐 [OpenCode] Using proxy: ${ProxyHelper.getProxyDescription(accountData.proxy)}`
        )
      }
      return proxyAgent
    } catch (error) {
      logger.warn(`⚠️ [OpenCode] Failed to create proxy agent: ${error.message}`)
      return null
    }
  }

  // 🚨 错误响应（仅在 stream 仍可写时）
  _sendErrorIfWritable(responseStream, statusCode, message) {
    if (!isStreamWritable(responseStream)) {
      return
    }
    try {
      if (!responseStream.headersSent) {
        responseStream.writeHead(statusCode, {
          'Content-Type': 'application/json'
        })
      }
      responseStream.write(
        JSON.stringify({
          error: 'opencode_relay_error',
          status: statusCode,
          message
        })
      )
      responseStream.end()
    } catch (_) {
      // ignore
    }
  }
}

module.exports = new OpenCodeRelayService()
