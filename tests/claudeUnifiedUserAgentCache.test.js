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
  const generationCacheKey = 'claude_code_user_agent:generation'
  const versionSortCacheKey = 'claude_code_user_agent:version_sort'
  const userAgent = 'claude-cli/2.1.114 (external, cli)'
  const publishedVersions = (...versions) => JSON.stringify(versions)
  const versionSortKey = (userAgentValue) => {
    const match = userAgentValue?.match(/^claude-cli\/(\d+(?:\.\d+){1,3}) \(external, cli\)$/i)
    if (!match) {
      return ''
    }
    const parts = match[1].split('.').map((part) => Number.parseInt(part, 10))
    while (parts.length < 4) {
      parts.push(0)
    }
    return parts.map((part) => String(part).padStart(4, '0')).join('.')
  }
  const withSnapshot = (client) => ({
    ...client,
    mget: jest.fn(async (...keys) => Promise.all(keys.map((key) => client.get(key))))
  })
  const createAtomicRedis = (store = new Map()) => ({
    get: jest.fn(async (key) => store.get(key) || null),
    mget: jest.fn(async (...keys) => keys.map((key) => store.get(key) || null)),
    set: jest.fn(async (key, value) => {
      store.set(key, value)
      return 'OK'
    }),
    persist: jest.fn().mockResolvedValue(1),
    del: jest.fn(async (...keys) => {
      keys.forEach((key) => store.delete(key))
      return keys.length
    }),
    mset: jest.fn(async (...values) => {
      for (let index = 0; index < values.length; index += 2) {
        store.set(values[index], values[index + 1])
      }
      return 'OK'
    }),
    eval: jest.fn(async (_script, numberOfKeys, ...args) => {
      const keys = args.slice(0, numberOfKeys)
      const values = args.slice(numberOfKeys)
      const [cache, verified, generation, versionSort] = keys
      const [action, expectedGeneration = '', expectedUserAgent = '', candidate = '', sort = ''] =
        values
      const currentGeneration = store.get(generation) || '0'

      if (action === 'clear') {
        const nextGeneration = String(Number.parseInt(currentGeneration, 10) + 1)
        store.set(generation, nextGeneration)
        store.delete(cache)
        store.delete(verified)
        store.delete(versionSort)
        return [1, nextGeneration]
      }
      if (expectedGeneration !== currentGeneration) {
        return [-1, store.get(cache) || '']
      }
      if (action === 'store') {
        const current = store.get(cache) || ''
        const currentSort = store.get(versionSort) || versionSortKey(current)
        if (current && currentSort >= sort) {
          return [0, current]
        }
        store.set(cache, candidate)
        store.set(verified, candidate)
        store.set(versionSort, sort)
        return [1, candidate]
      }
      if ((store.get(cache) || '') !== expectedUserAgent) {
        return [2, store.get(cache) || '']
      }
      if (action === 'verify') {
        store.set(verified, expectedUserAgent)
        store.set(versionSort, sort)
        return [1, expectedUserAgent]
      }
      if (action === 'delete') {
        const current = store.get(cache) || ''
        const currentSort = store.get(versionSort) || versionSortKey(current)
        if (sort && store.get(verified) === current && currentSort > sort) {
          return [0, current]
        }
        store.delete(cache)
        store.delete(verified)
        store.delete(versionSort)
        return [1, '']
      }
      throw new Error(`unexpected cache action: ${action}`)
    })
  })
  let originalClient

  beforeEach(() => {
    originalClient = redis.client
    if (claudeRelayService._claudeCodeVersionRetryTimer) {
      clearTimeout(claudeRelayService._claudeCodeVersionRetryTimer)
    }
    claudeRelayService._claudeCodeVersionRefreshPromise = null
    claudeRelayService._pendingClaudeCodeUserAgents = new Map()
    claudeRelayService._claudeCodePendingEpoch = 0
    claudeRelayService._claudeCodeVersionRetryAfter = 0
    claudeRelayService._claudeCodeVersionForceRefreshAfter = 0
    claudeRelayService._claudeCodeVersionRetryTimer = null
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ versions: { '2.1.114': {} } })
    })
  })

  afterEach(async () => {
    if (claudeRelayService._claudeCodeVersionRefreshPromise) {
      await claudeRelayService._claudeCodeVersionRefreshPromise
    }
    if (claudeRelayService._claudeCodeVersionRetryTimer) {
      clearTimeout(claudeRelayService._claudeCodeVersionRetryTimer)
      claudeRelayService._claudeCodeVersionRetryTimer = null
    }
    redis.client = originalClient
    jest.restoreAllMocks()
  })

  it('stores a newly captured Claude Code User-Agent without an expiration', async () => {
    // Given
    const store = new Map([[publishedVersionsCacheKey, publishedVersions('2.1.114')]])
    redis.client = createAtomicRedis(store)

    // When
    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': userAgent },
      { useUnifiedUserAgent: 'true' }
    )

    // Then
    expect(result).toBe(userAgent)
    expect(store.get(cacheKey)).toBe(userAgent)
    expect(store.get(verifiedCacheKey)).toBe(userAgent)
    expect(store.get(versionSortCacheKey)).toBe('0002.0001.0114.0000')
  })

  it('removes the legacy expiration when the cached version remains current', async () => {
    // Given
    const store = new Map([
      [cacheKey, userAgent],
      [publishedVersionsCacheKey, publishedVersions('2.1.114')]
    ])
    redis.client = createAtomicRedis(store)

    // When
    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': userAgent },
      { useUnifiedUserAgent: 'true' }
    )

    // Then
    expect(result).toBe(userAgent)
    expect(store.get(verifiedCacheKey)).toBe(userAgent)
    expect(store.get(versionSortCacheKey)).toBe('0002.0001.0114.0000')
    expect(redis.client.persist).toHaveBeenCalledWith(cacheKey)
  })

  it('removes the legacy expiration even when the request is not from Claude Code', async () => {
    const store = new Map([
      [cacheKey, userAgent],
      [publishedVersionsCacheKey, publishedVersions('2.1.114')]
    ])
    redis.client = createAtomicRedis(store)

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(userAgent)
    expect(store.get(verifiedCacheKey)).toBe(userAgent)
    expect(redis.client.persist).toHaveBeenCalledWith(cacheKey)
  })

  it('stores a newer valid Claude Code User-Agent without an expiration', async () => {
    const newerUserAgent = 'claude-cli/2.1.115 (external, cli)'
    const store = new Map([
      [cacheKey, userAgent],
      [verifiedCacheKey, userAgent],
      [publishedVersionsCacheKey, publishedVersions('2.1.114', '2.1.115')]
    ])
    redis.client = createAtomicRedis(store)

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': newerUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(newerUserAgent)
    expect(store.get(cacheKey)).toBe(newerUserAgent)
    expect(store.get(verifiedCacheKey)).toBe(newerUserAgent)
  })

  it('does not cache an unbounded client-supplied version', async () => {
    const maliciousUserAgent = `claude-cli/${'9'.repeat(256)}.0.0 (external, cli)`
    redis.client = withSnapshot({
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    })

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': maliciousUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('does not cache a canonical unpublished future version', async () => {
    const unpublishedUserAgent = 'claude-cli/9999.9999.9999.9999 (external, cli)'
    redis.client = withSnapshot({
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    })

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': unpublishedUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('does not cache a canonical below-latest version that was never published', async () => {
    const unpublishedUserAgent = 'claude-cli/0.0.0 (external, cli)'
    redis.client = withSnapshot({
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    })

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': unpublishedUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('does not cache a noncanonical version equivalent to an official release', async () => {
    const equivalentUserAgent = 'claude-cli/2.1.114.0 (external, cli)'
    redis.client = withSnapshot({
      get: jest.fn(async (key) =>
        key === publishedVersionsCacheKey ? publishedVersions('2.1.114') : null
      ),
      mset: jest.fn()
    })

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': equivalentUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(redis.client.mset).not.toHaveBeenCalled()
  })

  it('removes an invalid cached User-Agent instead of persisting it forever', async () => {
    const maliciousUserAgent = `claude-cli/${'9'.repeat(256)}.0.0 (external, cli)`
    const store = new Map([[cacheKey, maliciousUserAgent]])
    redis.client = createAtomicRedis(store)

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(store.get(cacheKey)).toBeUndefined()
  })

  it('removes an unpublished cached version', async () => {
    const unpublishedUserAgent = 'claude-cli/9999.9999.9999.9999 (external, cli)'
    const store = new Map([
      [cacheKey, unpublishedUserAgent],
      [publishedVersionsCacheKey, publishedVersions('2.1.114')]
    ])
    redis.client = createAtomicRedis(store)

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBeNull()
    expect(store.get(cacheKey)).toBeUndefined()
  })

  it('does not block the relay request while official version metadata is loading', async () => {
    let resolveFetch
    global.fetch.mockReturnValueOnce(new Promise((resolve) => (resolveFetch = resolve)))
    const store = new Map()
    redis.client = createAtomicRedis(store)

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
      { 'user-agent': 'claude-cli/2.1.115 (external, cli)' },
      { useUnifiedUserAgent: 'true' }
    )
    await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'claude-cli/9999.9999.9999.9999 (external, cli)' },
      { useUnifiedUserAgent: 'true' }
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const refreshPromise = claudeRelayService._claudeCodeVersionRefreshPromise
    resolveFetch({
      ok: true,
      json: async () => ({ versions: { '2.1.114': {}, '2.1.115': {} } })
    })
    await refreshPromise
    expect(store.get(cacheKey)).toBe('claude-cli/2.1.115 (external, cli)')
    expect(store.get(verifiedCacheKey)).toBe('claude-cli/2.1.115 (external, cli)')
  })

  it('refreshes a live published-version snapshot when a newer client version is missing', async () => {
    const newerUserAgent = 'claude-cli/2.1.115 (external, cli)'
    const store = new Map([
      [cacheKey, userAgent],
      [verifiedCacheKey, userAgent],
      [publishedVersionsCacheKey, publishedVersions('2.1.114')]
    ])
    redis.client = createAtomicRedis(store)
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ versions: { '2.1.114': {}, '2.1.115': {} } })
    })

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': newerUserAgent },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(userAgent)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    await claudeRelayService._claudeCodeVersionRefreshPromise
    expect(store.get(cacheKey)).toBe(newerUserAgent)
  })

  it('keeps the greatest published User-Agent when concurrent writes finish out of order', async () => {
    const olderCandidate = 'claude-cli/2.1.115 (external, cli)'
    const newerCandidate = 'claude-cli/2.1.116 (external, cli)'
    const store = new Map([
      [cacheKey, userAgent],
      [verifiedCacheKey, userAgent],
      [publishedVersionsCacheKey, publishedVersions('2.1.114', '2.1.115', '2.1.116')]
    ])
    const atomicRedis = createAtomicRedis(store)
    let releaseOlderMutation
    let olderMutationStarted
    const olderMutationStartedPromise = new Promise((resolve) => (olderMutationStarted = resolve))
    const baseEval = atomicRedis.eval.getMockImplementation()
    atomicRedis.eval.mockImplementation(async (...args) => {
      const candidate = args.at(-2)
      if (candidate === olderCandidate) {
        olderMutationStarted()
        await new Promise((resolve) => (releaseOlderMutation = resolve))
      }
      return baseEval(...args)
    })
    redis.client = atomicRedis

    const olderWrite = claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': olderCandidate },
      { useUnifiedUserAgent: 'true' }
    )
    await olderMutationStartedPromise
    await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': newerCandidate },
      { useUnifiedUserAgent: 'true' }
    )
    releaseOlderMutation()
    await olderWrite

    expect(store.get(cacheKey)).toBe(newerCandidate)
  })

  it('drains a candidate that arrives while the prior registry batch is reconciling', async () => {
    const olderCandidate = 'claude-cli/2.1.115 (external, cli)'
    const newerCandidate = 'claude-cli/2.1.116 (external, cli)'
    let resolveFirstFetch
    global.fetch
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirstFetch = resolve)))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ versions: { '2.1.115': {}, '2.1.116': {} } })
      })

    const store = new Map()
    const atomicRedis = createAtomicRedis(store)
    let releaseOlderMutation
    let olderMutationStarted
    const olderMutationStartedPromise = new Promise((resolve) => (olderMutationStarted = resolve))
    const baseEval = atomicRedis.eval.getMockImplementation()
    atomicRedis.eval.mockImplementation(async (...args) => {
      const candidate = args.at(-2)
      if (candidate === olderCandidate) {
        olderMutationStarted()
        await new Promise((resolve) => (releaseOlderMutation = resolve))
      }
      return baseEval(...args)
    })
    redis.client = atomicRedis

    await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': olderCandidate },
      { useUnifiedUserAgent: 'true' }
    )
    const firstRefresh = claudeRelayService._claudeCodeVersionRefreshPromise
    resolveFirstFetch({
      ok: true,
      json: async () => ({ versions: { '2.1.115': {}, '2.1.116': {} } })
    })
    await olderMutationStartedPromise

    claudeRelayService._scheduleOfficialClaudeCodeVersionRefresh(newerCandidate, '0')
    releaseOlderMutation()
    await firstRefresh
    await claudeRelayService._claudeCodeVersionRefreshPromise

    expect(store.get(cacheKey)).toBe(newerCandidate)
    expect(claudeRelayService._pendingClaudeCodeUserAgents.size).toBe(0)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('restores a drained batch when reconciliation fails and stores it on retry', async () => {
    jest.useFakeTimers()
    try {
      const store = new Map()
      const atomicRedis = createAtomicRedis(store)
      const baseEval = atomicRedis.eval.getMockImplementation()
      let failReconcile = true
      atomicRedis.eval.mockImplementation(async (...args) => {
        if (args.at(-5) === 'store' && failReconcile) {
          failReconcile = false
          throw new Error('transient Redis failure')
        }
        return baseEval(...args)
      })
      redis.client = atomicRedis

      await claudeRelayService.captureAndGetUnifiedUserAgent(
        { 'user-agent': userAgent },
        { useUnifiedUserAgent: 'true' }
      )
      await claudeRelayService._claudeCodeVersionRefreshPromise

      expect(store.get(cacheKey)).toBeUndefined()
      expect(claudeRelayService._pendingClaudeCodeUserAgents.size).toBe(1)
      expect(claudeRelayService._claudeCodeVersionRetryTimer).not.toBeNull()

      await jest.advanceTimersByTimeAsync(5 * 60 * 1000)
      if (claudeRelayService._claudeCodeVersionRefreshPromise) {
        await claudeRelayService._claudeCodeVersionRefreshPromise
      }

      expect(store.get(cacheKey)).toBe(userAgent)
      expect(claudeRelayService._pendingClaudeCodeUserAgents.size).toBe(0)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('schedules a queued forced refresh when its cooldown expires', () => {
    claudeRelayService._claudeCodeVersionForceRefreshAfter = Date.now() + 60_000

    claudeRelayService._scheduleOfficialClaudeCodeVersionRefresh(
      'claude-cli/2.1.115 (external, cli)',
      '0',
      true
    )

    expect(claudeRelayService._pendingClaudeCodeUserAgents.size).toBe(1)
    expect(claudeRelayService._claudeCodeVersionRetryTimer).not.toBeNull()
  })

  it('does not let a stale registry snapshot delete a newer verified User-Agent', async () => {
    const newerUserAgent = 'claude-cli/2.1.116 (external, cli)'
    const store = new Map([
      [cacheKey, newerUserAgent],
      [verifiedCacheKey, newerUserAgent],
      [versionSortCacheKey, versionSortKey(newerUserAgent)]
    ])
    redis.client = createAtomicRedis(store)

    const result = await claudeRelayService._reconcileUnifiedUserAgentCache(
      '0',
      { candidates: new Map() },
      new Set(['2.1.114', '2.1.115'])
    )

    expect(result).toBe(newerUserAgent)
    expect(store.get(cacheKey)).toBe(newerUserAgent)
    expect(store.get(verifiedCacheKey)).toBe(newerUserAgent)
  })

  it('does not let an in-flight pre-clear refresh repopulate the cache', async () => {
    let resolveFetch
    global.fetch.mockReturnValueOnce(new Promise((resolve) => (resolveFetch = resolve)))
    const store = new Map()
    redis.client = createAtomicRedis(store)

    await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': userAgent },
      { useUnifiedUserAgent: 'true' }
    )
    const refreshPromise = claudeRelayService._claudeCodeVersionRefreshPromise
    await claudeRelayService.clearUnifiedUserAgentCache()
    resolveFetch({ ok: true, json: async () => ({ versions: { '2.1.114': {} } }) })
    await refreshPromise

    expect(store.get(generationCacheKey)).toBe('1')
    expect(store.get(cacheKey)).toBeUndefined()
    expect(store.get(verifiedCacheKey)).toBeUndefined()
    expect(store.get(versionSortCacheKey)).toBeUndefined()
  })

  it('preserves an existing cache when the registry has a transient failure', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 })
    const store = new Map([[cacheKey, userAgent]])
    redis.client = withSnapshot({
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
    })

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
    redis.client = withSnapshot({
      get: jest.fn(async (key) => {
        if (key === cacheKey || key === verifiedCacheKey) {
          return userAgent
        }
        if (key === publishedVersionsCacheKey) {
          return publishedVersions('2.1.114')
        }
        return null
      }),
      persist: jest.fn().mockResolvedValue(1)
    })

    const result = await claudeRelayService.captureAndGetUnifiedUserAgent(
      { 'user-agent': 'opencode/1.0.0' },
      { useUnifiedUserAgent: 'true' }
    )

    expect(result).toBe(userAgent)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
