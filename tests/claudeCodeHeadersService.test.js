const store = new Map()
const mockClient = {
  get: jest.fn(async (key) => store.get(key) || null),
  del: jest.fn(async (key) => (store.delete(key) ? 1 : 0)),
  eval: jest.fn()
}
const mockDeleteCachedConfig = jest.fn()
const mockGetCachedConfig = jest.fn()

jest.mock('../src/models/redis', () => ({
  getClient: () => mockClient,
  scanKeys: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getCachedConfig: mockGetCachedConfig,
  setCachedConfig: jest.fn(),
  deleteCachedConfig: mockDeleteCachedConfig
}))

const claudeCodeHeadersService = require('../src/services/claudeCodeHeadersService')

describe('ClaudeCodeHeadersService verified header cache', () => {
  const publishedKey = 'claude_code_user_agent:published_versions'
  const accountKey = 'claude_code_headers:account-1'

  beforeEach(() => {
    store.clear()
    mockClient.get.mockClear()
    mockClient.del.mockClear()
    mockDeleteCachedConfig.mockClear()
    mockGetCachedConfig.mockReset()
    mockClient.eval.mockImplementation(async (_script, _keyCount, key, ...args) => {
      if (args.length === 1) {
        if (store.get(key) === args[0]) {
          store.delete(key)
          return 1
        }
        return 0
      }
      const [_ttl, data, sort] = args
      const currentData = store.get(key)
      if (currentData) {
        const current = JSON.parse(currentData)
        const currentSort =
          current.versionSort || claudeCodeHeadersService._getVersionSortKey(current.version)
        if (currentSort >= sort) {
          return [0, currentData]
        }
      }
      store.set(key, data)
      return [1, data]
    })
  })

  it('rejects an unpublished client User-Agent', async () => {
    store.set(publishedKey, JSON.stringify(['2.1.114']))

    await claudeCodeHeadersService.storeAccountHeaders('account-1', {
      'user-agent': 'claude-cli/9999.9999.9999.9999 (external, cli)'
    })

    expect(mockClient.eval).not.toHaveBeenCalled()
    expect(store.get(accountKey)).toBeUndefined()
  })

  it('rejects a noncanonical client User-Agent', async () => {
    store.set(publishedKey, JSON.stringify(['2.1.114']))

    await claudeCodeHeadersService.storeAccountHeaders('account-1', {
      'user-agent': 'claude-cli/2.1.114 (external, cli) forged'
    })

    expect(mockClient.eval).not.toHaveBeenCalled()
  })

  it('keeps the newest published headers when writes arrive out of order', async () => {
    store.set(publishedKey, JSON.stringify(['2.1.115', '2.1.116']))
    let releaseOlder
    let olderStarted
    const olderStartedPromise = new Promise((resolve) => (olderStarted = resolve))
    const baseEval = mockClient.eval.getMockImplementation()
    mockClient.eval.mockImplementation(async (...args) => {
      const data = JSON.parse(args[4])
      if (data.version === '2.1.115') {
        olderStarted()
        await new Promise((resolve) => (releaseOlder = resolve))
      }
      return baseEval(...args)
    })

    const olderWrite = claudeCodeHeadersService.storeAccountHeaders('account-1', {
      'user-agent': 'claude-cli/2.1.115 (external, cli)'
    })
    await olderStartedPromise
    const newerWrite = claudeCodeHeadersService.storeAccountHeaders('account-1', {
      'user-agent': 'claude-cli/2.1.116 (external, cli)'
    })
    await newerWrite
    releaseOlder()
    await olderWrite

    expect(JSON.parse(store.get(accountKey)).version).toBe('2.1.116')
  })

  it('does not downgrade a newer legacy record that has no versionSort field', async () => {
    store.set(publishedKey, JSON.stringify(['2.1.115', '2.1.116']))
    store.set(
      accountKey,
      JSON.stringify({
        headers: { 'user-agent': 'claude-cli/2.1.116 (external, cli)' },
        version: '2.1.116'
      })
    )

    await claudeCodeHeadersService.storeAccountHeaders('account-1', {
      'user-agent': 'claude-cli/2.1.115 (external, cli)'
    })

    expect(JSON.parse(store.get(accountKey)).version).toBe('2.1.116')
  })

  it('does not reuse a previously poisoned stored User-Agent', async () => {
    store.set(publishedKey, JSON.stringify(['2.1.114']))
    store.set(
      accountKey,
      JSON.stringify({
        headers: { 'user-agent': 'claude-cli/9999.9999.9999.9999 (external, cli)' },
        version: '9999.9999.9999.9999'
      })
    )

    const result = await claudeCodeHeadersService.getAccountHeaders('account-1')

    expect(result).toBe(claudeCodeHeadersService.defaultHeaders)
    expect(store.get(accountKey)).toBeUndefined()
  })

  it('does not delete a valid record stored while stale data is being rejected', async () => {
    store.set(publishedKey, JSON.stringify(['2.1.114']))
    store.set(
      accountKey,
      JSON.stringify({
        headers: { 'user-agent': 'claude-cli/9999.9999.9999.9999 (external, cli)' },
        version: '9999.9999.9999.9999'
      })
    )
    const validData = JSON.stringify({
      headers: { 'user-agent': 'claude-cli/2.1.114 (external, cli)' },
      version: '2.1.114',
      versionSort: '0002.0001.0114.0000'
    })
    const baseEval = mockClient.eval.getMockImplementation()
    mockClient.eval.mockImplementationOnce(async (...args) => {
      store.set(accountKey, validData)
      return baseEval(...args)
    })

    const result = await claudeCodeHeadersService.getAccountHeaders('account-1')

    expect(result).toBe(claudeCodeHeadersService.defaultHeaders)
    expect(store.get(accountKey)).toBe(validData)
  })

  it('does not reuse an unverified in-memory User-Agent', async () => {
    store.set(publishedKey, JSON.stringify(['2.1.114']))
    mockGetCachedConfig.mockReturnValue({
      'user-agent': 'claude-cli/9999.9999.9999.9999 (external, cli)'
    })

    const result = await claudeCodeHeadersService.getAccountHeaders('account-1')

    expect(result).toBe(claudeCodeHeadersService.defaultHeaders)
    expect(mockDeleteCachedConfig).toHaveBeenCalledWith(accountKey)
  })
})
