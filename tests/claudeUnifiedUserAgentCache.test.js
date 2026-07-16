const mockConfig = require('../config/config.example')
const mockRedis = { client: null }
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}

jest.mock('../config/config', () => mockConfig, { virtual: true })
jest.mock('../src/models/redis', () => mockRedis)
jest.mock('../src/utils/logger', () => mockLogger)
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))

const redis = require('../src/models/redis')
const claudeRelayService = require('../src/services/relay/claudeRelayService')

describe('ClaudeRelayService unified User-Agent cache', () => {
  const cacheKey = 'claude_code_user_agent:daily'
  const verifiedCacheKey = 'claude_code_user_agent:verified'
  const publishedVersionsCacheKey = 'claude_code_user_agent:published_versions'
  const userAgent = 'claude-cli/2.1.114 (external, cli)'
  const publishedVersions = (...versions) => JSON.stringify(versions)
  let originalClient

  beforeEach(() => {
    originalClient = redis.client
    if (claudeRelayService._claudeCodeVersionRetryTimer) {
      clearTimeout(claudeRelayService._claudeCodeVersionRetryTimer)
    }
    claudeRelayService._claudeCodeVersionRefreshPromise = null
    claudeRelayService._pendingClaudeCodeUserAgent = null
    claudeRelayService._claudeCodeVersionRetryAfter = 0
    claudeRelayService._claudeCodeVersionRetryTimer = null
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ versions: { '2.1.114': {} } })
    })
  })

  afterEach(() => {
    if (claudeRelayService._claudeCodeVersionRetryTimer) {
      clearTimeout(claudeRelayService._claudeCodeVersionRetryTimer)
      claudeRelayService._claudeCodeVersionRetryTimer = null
    }
    redis.client = originalClient
    jest.restoreAllMocks()
  })

  it('stores a newly captured Claude Code User-Agent without an expiration', async () => {
    // Given
    redis.client = {
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn().mockResolvedValue('OK')
    }

    // When
    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': userAgent },
      { useUnifiedUserAgent: 'true' }
    )

    // Then
    expect(result).toBe(userAgent)
    expect(redis.client.mset).toHaveBeenCalledWith(cacheKey, userAgent, verifiedCacheKey, userAgent)
  })

  it('removes the legacy expiration when the cached version remains current', async () => {
    // Given
    redis.client = {
      get: jest.fn(async (key) => {
        if (key === cacheKey) {
          return userAgent
        }
        if (key === publishedVersionsCacheKey) {
          return publishedVersions('2.1.114')
        }
        return null
      }),
      set: jest.fn().mockResolvedValue('OK'),
      persist: jest.fn().mockResolvedValue(1)
    }

    // When
    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': userAgent },
      { useUnifiedUserAgent: 'true' }
    )

    // Then
    expect(result).toBe(userAgent)
    expect(redis.client.set).toHaveBeenCalledWith(verifiedCacheKey, userAgent)
    expect(redis.client.persist).toHaveBeenCalledWith(cacheKey)
  })

  it('removes the legacy expiration even when the request is not from Claude Code', async () => {
    redis.client = {
      get: jest.fn(async (key) => {
        if (key === cacheKey) {
          return userAgent
        }
        if (key === publishedVersionsCacheKey) {
          return publishedVersions('2.1.114')
        }
        return null
      }),
      set: jest.fn().mockResolvedValue('OK'),
      persist: jest.fn().mockResolvedValue(1)
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(userAgent)
    expect(redis.client.set).toHaveBeenCalledWith(verifiedCacheKey, userAgent)
    expect(redis.client.persist).toHaveBeenCalledWith(cacheKey)
  })

  it('stores a newer valid Claude Code User-Agent without an expiration', async () => {
    const newerUserAgent = 'claude-cli/2.1.115 (external, cli)'
    redis.client = {
      get: jest.fn(async (key) => {
        if (key === cacheKey || key === verifiedCacheKey) {
          return userAgent
        }
        if (key === publishedVersionsCacheKey) {
          return publishedVersions('2.1.114', '2.1.115')
        }
        return null
      }),
      mset: jest.fn().mockResolvedValue('OK'),
      persist: jest.fn().mockResolvedValue(1)
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': newerUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(newerUserAgent)
    expect(redis.client.mset).toHaveBeenCalledWith(
      cacheKey,
      newerUserAgent,
      verifiedCacheKey,
      newerUserAgent
    )
  })

  it('does not cache an unbounded client-supplied version', async () => {
    const maliciousUserAgent = `claude-cli/${'9'.repeat(256)}.0.0 (external, cli)`
    redis.client = {
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': maliciousUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('does not cache a canonical unpublished future version', async () => {
    const unpublishedUserAgent = 'claude-cli/9999.9999.9999.9999 (external, cli)'
    redis.client = {
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': unpublishedUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('does not cache a canonical below-latest version that was never published', async () => {
    const unpublishedUserAgent = 'claude-cli/0.0.0 (external, cli)'
    redis.client = {
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': unpublishedUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('does not cache a noncanonical version equivalent to an official release', async () => {
    const equivalentUserAgent = 'claude-cli/2.1.114.0 (external, cli)'
    redis.client = {
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': equivalentUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('removes an invalid cached User-Agent instead of persisting it forever', async () => {
    const maliciousUserAgent = `claude-cli/${'9'.repeat(256)}.0.0 (external, cli)`
    redis.client = {
      get: jest.fn().mockResolvedValue(maliciousUserAgent),
      del: jest.fn().mockResolvedValue(1)
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.del).toHaveBeenCalledWith(cacheKey, verifiedCacheKey)
  })

  it('removes an unpublished cached version', async () => {
    const unpublishedUserAgent = 'claude-cli/9999.9999.9999.9999 (external, cli)'
    redis.client = {
      get: jest.fn(async (key) => {
        if (key === cacheKey) {
          return unpublishedUserAgent
        }
        if (key === publishedVersionsCacheKey) {
          return publishedVersions('2.1.114')
        }
        return null
      }),
      del: jest.fn().mockResolvedValue(2)
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.del).toHaveBeenCalledWith(cacheKey, verifiedCacheKey)
  })

  it('does not block the relay request while official version metadata is loading', async () => {
    let resolveFetch
    global.fetch.mockReturnValueOnce(new Promise((resolve) => (resolveFetch = resolve)))
    const store = new Map()
    redis.client = {
      get: jest.fn(async (key) => store.get(key) || null),
      set: jest.fn(async (key, value) => {
        store.set(key, value)
        return 'OK'
      }),
      mset: jest.fn(async (...values) => {
        for (let index = 0; index < values.length; index += 2) {
          store.set(values[index], values[index + 1])
        }
        return 'OK'
      }),
      persist: jest.fn().mockResolvedValue(1)
    }

    const pending = Symbol('pending')
    const result = await Promise.race([
      claudeRelayService.captureAndGetUnifiedUserAgent(
        { 'user-agent': userAgent },
        { useUnifiedUserAgent: 'true' }
      ),
      new Promise((resolve) => setImmediate(() => resolve(pending)))
    ])

    expect(result).toBeNull()
    expect(result).not.toBe(pending)
    await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'claude-cli/9999.9999.9999.9999 (external, cli)' },
      { useUnifiedUserAgent: 'true' }
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const refreshPromise = claudeRelayService._claudeCodeVersionRefreshPromise
    resolveFetch({ ok: true, json: async () => ({ versions: { '2.1.114': {} } }) })
    await refreshPromise
    expect(store.get(cacheKey)).toBe(userAgent)
    expect(store.get(verifiedCacheKey)).toBe(userAgent)
  })

  it('preserves an existing cache when the registry has a transient failure', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 })
    const store = new Map([[cacheKey, userAgent]])
    redis.client = {
      get: jest.fn(async (key) => store.get(key) || null),
      set: jest.fn(async (key, value) => {
        store.set(key, value)
        return 'OK'
      }),
      del: jest.fn(async (...keys) => {
        keys.forEach((key) => store.delete(key))
        return keys.length
      }),
      persist: jest.fn()
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(userAgent)
    await claudeRelayService._claudeCodeVersionRefreshPromise
    expect(store.get(cacheKey)).toBe(userAgent)
    expect(redis.client.del).not.toHaveBeenCalled()
    expect(redis.client.persist).toHaveBeenCalledWith(cacheKey)
    await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not contact the registry for a cache with a matching verification marker', async () => {
    redis.client = {
      get: jest.fn(async (key) => {
        if (key === cacheKey || key === verifiedCacheKey) {
          return userAgent
        }
        return null
      }),
      persist: jest.fn().mockResolvedValue(1)
    }

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(userAgent)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
