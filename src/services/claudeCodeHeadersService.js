/**
 * Claude Code Headers 管理服务
 * 负责存储和管理不同账号使用的 Claude Code headers
 */

const redis = require('../models/redis')
const logger = require('../utils/logger')
const {
  getCachedConfig,
  setCachedConfig,
  deleteCachedConfig
} = require('../utils/performanceOptimizer')
const { extractClaudeCodeVersionFromUserAgent } = require('../utils/cchHelper')

const PUBLISHED_VERSIONS_KEY = 'claude_code_user_agent:published_versions'
const VERSION_PATTERN = /^\d{1,4}(?:\.\d{1,4}){1,3}$/
const STORE_HEADERS_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local candidateData = ARGV[2]
local candidateSort = ARGV[3]

local function getVersionSort(version)
  if type(version) ~= 'string' then
    return nil
  end
  local parts = {}
  for component in string.gmatch(version, '[^%.]+') do
    if not string.match(component, '^%d+$') then
      return nil
    end
    local value = tonumber(component)
    if not value or value > 9999 then
      return nil
    end
    table.insert(parts, value)
  end
  if #parts < 2 or #parts > 4 then
    return nil
  end
  return string.format('%04d.%04d.%04d.%04d', parts[1] or 0, parts[2] or 0, parts[3] or 0, parts[4] or 0)
end

local currentData = redis.call('GET', key)
if currentData then
  local ok, current = pcall(cjson.decode, currentData)
  if ok and type(current) == 'table' then
    local currentSort = current.versionSort or getVersionSort(current.version)
    if currentSort and currentSort >= candidateSort then
      return {0, currentData}
    end
  end
end

redis.call('SETEX', key, ttl, candidateData)
return {1, candidateData}
`
const DELETE_HEADERS_IF_UNCHANGED_SCRIPT = `
local key = KEYS[1]
local expectedData = ARGV[1]
if redis.call('GET', key) == expectedData then
  return redis.call('DEL', key)
end
return 0
`

class ClaudeCodeHeadersService {
  constructor() {
    this.defaultHeaders = {
      'x-stainless-retry-count': '0',
      'x-stainless-timeout': '60',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.55.1',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v20.19.2',
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
      'user-agent': 'claude-cli/1.0.57 (external, cli)',
      'accept-language': '*',
      'sec-fetch-mode': 'cors'
    }

    // 需要捕获的 Claude Code 特定 headers
    this.claudeCodeHeaderKeys = [
      'x-stainless-retry-count',
      'x-stainless-timeout',
      'x-stainless-lang',
      'x-stainless-package-version',
      'x-stainless-os',
      'x-stainless-arch',
      'x-stainless-runtime',
      'x-stainless-runtime-version',
      'anthropic-dangerous-direct-browser-access',
      'x-app',
      'user-agent',
      'accept-language',
      'sec-fetch-mode'
      // 注意：不捕获 accept-encoding，避免存储客户端的 zstd 等不支持的编码
    ]

    // Headers 缓存 TTL（60秒）
    this.headersCacheTtl = 60000
  }

  /**
   * 从 user-agent 中提取版本号
   */
  extractVersionFromUserAgent(userAgent) {
    return extractClaudeCodeVersionFromUserAgent(userAgent)
  }

  _getVersionSortKey(version) {
    const parts = version.split('.').map((part) => Number.parseInt(part, 10))
    while (parts.length < 4) {
      parts.push(0)
    }
    return parts.map((part) => String(part).padStart(4, '0')).join('.')
  }

  async _getPublishedVersions(client) {
    const serialized = await client.get(PUBLISHED_VERSIONS_KEY)
    if (!serialized) {
      return null
    }
    try {
      const versions = JSON.parse(serialized)
      if (
        !Array.isArray(versions) ||
        versions.length === 0 ||
        versions.some((version) => typeof version !== 'string' || !VERSION_PATTERN.test(version))
      ) {
        return null
      }
      return new Set(versions)
    } catch (_error) {
      return null
    }
  }

  /**
   * 从客户端 headers 中提取 Claude Code 相关的 headers
   */
  extractClaudeCodeHeaders(clientHeaders) {
    const headers = {}

    // 转换所有 header keys 为小写进行比较
    const lowerCaseHeaders = {}
    Object.keys(clientHeaders || {}).forEach((key) => {
      lowerCaseHeaders[key.toLowerCase()] = clientHeaders[key]
    })

    // 提取需要的 headers
    this.claudeCodeHeaderKeys.forEach((key) => {
      const lowerKey = key.toLowerCase()
      if (lowerCaseHeaders[lowerKey]) {
        headers[key] = lowerCaseHeaders[lowerKey]
      }
    })

    return headers
  }

  /**
   * 存储账号的 Claude Code headers
   */
  async storeAccountHeaders(accountId, clientHeaders) {
    try {
      const extractedHeaders = this.extractClaudeCodeHeaders(clientHeaders)

      const userAgent = extractedHeaders['user-agent']
      const version = this.extractVersionFromUserAgent(userAgent)
      if (!version) {
        return
      }

      const client = redis.getClient()
      const publishedVersions = await this._getPublishedVersions(client)
      if (!publishedVersions?.has(version)) {
        logger.warn(`⚠️ Ignored unverified Claude Code headers for account ${accountId}`)
        return
      }

      const key = `claude_code_headers:${accountId}`
      const data = {
        headers: extractedHeaders,
        version,
        versionSort: this._getVersionSortKey(version),
        updatedAt: new Date().toISOString()
      }
      const result = await client.eval(
        STORE_HEADERS_SCRIPT,
        1,
        key,
        86400 * 7,
        JSON.stringify(data),
        data.versionSort
      )
      deleteCachedConfig(key)

      if (Number(result?.[0]) === 1) {
        logger.info(`✅ Stored Claude Code headers for account ${accountId}, version: ${version}`)
      }
    } catch (error) {
      logger.error(`❌ Failed to store Claude Code headers for account ${accountId}:`, error)
    }
  }

  /**
   * 获取账号的 Claude Code headers（带内存缓存）
   */
  async getAccountHeaders(accountId) {
    const cacheKey = `claude_code_headers:${accountId}`

    // 检查内存缓存
    const cached = getCachedConfig(cacheKey)
    if (cached) {
      const version = this.extractVersionFromUserAgent(cached['user-agent'])
      const publishedVersions = await this._getPublishedVersions(redis.getClient())
      if (version && publishedVersions?.has(version)) {
        return cached
      }
      deleteCachedConfig(cacheKey)
      return this.defaultHeaders
    }

    try {
      const data = await redis.getClient().get(cacheKey)

      if (data) {
        const parsed = JSON.parse(data)
        const version = this.extractVersionFromUserAgent(parsed.headers?.['user-agent'])
        const publishedVersions = await this._getPublishedVersions(redis.getClient())
        if (!version || !publishedVersions?.has(version)) {
          deleteCachedConfig(cacheKey)
          if (publishedVersions) {
            await redis.getClient().eval(DELETE_HEADERS_IF_UNCHANGED_SCRIPT, 1, cacheKey, data)
          }
          return this.defaultHeaders
        }
        logger.debug(
          `📋 Retrieved Claude Code headers for account ${accountId}, version: ${parsed.version}`
        )
        // 缓存到内存
        setCachedConfig(cacheKey, parsed.headers, this.headersCacheTtl)
        return parsed.headers
      }

      // 返回默认 headers
      logger.debug(`📋 Using default Claude Code headers for account ${accountId}`)
      return this.defaultHeaders
    } catch (error) {
      logger.error(`❌ Failed to get Claude Code headers for account ${accountId}:`, error)
      return this.defaultHeaders
    }
  }

  /**
   * 清除账号的 Claude Code headers
   */
  async clearAccountHeaders(accountId) {
    try {
      const cacheKey = `claude_code_headers:${accountId}`
      await redis.getClient().del(cacheKey)
      // 删除内存缓存
      deleteCachedConfig(cacheKey)
      logger.info(`🗑️ Cleared Claude Code headers for account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to clear Claude Code headers for account ${accountId}:`, error)
    }
  }

  /**
   * 获取所有账号的 headers 信息（使用 scanKeys 替代 keys）
   */
  async getAllAccountHeaders() {
    try {
      const pattern = 'claude_code_headers:*'
      const keys = await redis.scanKeys(pattern)

      const results = {}
      for (const key of keys) {
        const accountId = key.replace('claude_code_headers:', '')
        const data = await redis.getClient().get(key)
        if (data) {
          results[accountId] = JSON.parse(data)
        }
      }

      return results
    } catch (error) {
      logger.error('❌ Failed to get all account headers:', error)
      return {}
    }
  }
}

module.exports = new ClaudeCodeHeadersService()
