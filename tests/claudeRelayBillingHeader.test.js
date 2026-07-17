const mockConfig = require('../config/config.example')
mockConfig.claude.serverBillingHeader.enabled = true

const mockClaudeCodeHeadersService = {
  defaultHeaders: { 'user-agent': 'claude-cli/1.0.119 (external, cli)' },
  getAccountHeaders: jest.fn()
}
const mockRedis = {
  client: {
    get: jest.fn()
  }
}

jest.mock('../config/config', () => mockConfig, { virtual: true })
jest.mock('../src/models/redis', () => mockRedis)
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => mockClaudeCodeHeadersService)

const claudeRelayService = require('../src/services/relay/claudeRelayService')

describe('ClaudeRelayService server billing header', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    mockClaudeCodeHeadersService.getAccountHeaders.mockReset()
    mockRedis.client.get.mockReset()
  })

  it('derives cc_version from the User-Agent that is actually sent upstream', async () => {
    const clientUserAgent = 'claude-cli/2.1.115 (external, cli)'
    const accountUserAgent = 'claude-cli/2.1.114 (external, cli)'
    mockClaudeCodeHeadersService.getAccountHeaders.mockResolvedValue({
      'user-agent': accountUserAgent
    })
    mockRedis.client.get.mockImplementation(async (key) =>
      key === 'claude_code_user_agent:published_versions' ? JSON.stringify(['2.1.114']) : null
    )
    jest.spyOn(claudeRelayService, 'captureAndGetUnifiedUserAgent').mockResolvedValue(null)
    jest.spyOn(claudeRelayService, '_filterClientHeaders').mockReturnValue({
      'user-agent': clientUserAgent
    })
    jest.spyOn(claudeRelayService, 'isRealClaudeCodeRequest').mockReturnValue(false)
    jest
      .spyOn(claudeRelayService, '_applyRequestIdentityTransform')
      .mockImplementation((body, headers) => ({ body, headers }))

    const result = await claudeRelayService._prepareRequestHeadersAndPayload(
      {
        model: 'claude-sonnet-4-20250514',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{ role: 'user', content: 'hello' }]
      },
      { 'user-agent': clientUserAgent },
      'account-1',
      'token',
      { account: { useUnifiedUserAgent: 'false' } }
    )

    expect(result.headers['User-Agent']).toBe(accountUserAgent)
    expect(result.requestPayload.system[0].text).toContain('cc_version=2.1.114.')
    expect(result.requestPayload.system[0].text).not.toContain('cc_version=2.1.115.')
  })

  it('ignores a legacy override environment variable that disagrees with the outgoing User-Agent', () => {
    process.env.CLAUDE_CODE_VERSION_OVERRIDE = '9.9.9'
    const payload = {
      system: [{ type: 'text', text: 'You are Claude Code.' }],
      messages: [{ role: 'user', content: 'hello' }]
    }

    const injected = claudeRelayService._injectServerBillingHeader(
      payload,
      'claude-cli/2.1.114 (external, cli)'
    )

    expect(injected).toBe(true)
    expect(payload.system[0].text).toContain('cc_version=2.1.114.')
    expect(payload.system[0].text).not.toContain('cc_version=9.9.9.')
    delete process.env.CLAUDE_CODE_VERSION_OVERRIDE
  })

  it('derives billing from the actual default User-Agent fallback', async () => {
    mockClaudeCodeHeadersService.getAccountHeaders.mockResolvedValue({})
    jest.spyOn(claudeRelayService, 'captureAndGetUnifiedUserAgent').mockResolvedValue(null)
    jest.spyOn(claudeRelayService, '_filterClientHeaders').mockReturnValue({})
    jest.spyOn(claudeRelayService, 'isRealClaudeCodeRequest').mockReturnValue(false)
    jest
      .spyOn(claudeRelayService, '_applyRequestIdentityTransform')
      .mockImplementation((body, headers) => ({ body, headers }))

    const result = await claudeRelayService._prepareRequestHeadersAndPayload(
      {
        model: 'claude-sonnet-4-20250514',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{ role: 'user', content: 'hello' }]
      },
      {},
      'account-1',
      'token',
      { account: { useUnifiedUserAgent: 'false' } }
    )

    expect(result.headers['User-Agent']).toBe('claude-cli/1.0.119 (external, cli)')
    expect(result.requestPayload.system[0].text).toContain('cc_version=1.0.119.')
  })

  it('replaces an unverified outgoing User-Agent before deriving billing', async () => {
    const unverifiedUserAgent = 'claude-cli/9999.9999.9999.9999 (external, cli)'
    mockClaudeCodeHeadersService.getAccountHeaders.mockResolvedValue({})
    mockRedis.client.get.mockImplementation(async (key) => {
      if (key === 'claude_code_user_agent:published_versions') {
        return JSON.stringify(['2.1.114'])
      }
      return null
    })
    jest.spyOn(claudeRelayService, 'captureAndGetUnifiedUserAgent').mockResolvedValue(null)
    jest.spyOn(claudeRelayService, '_filterClientHeaders').mockReturnValue({
      'user-agent': unverifiedUserAgent
    })
    jest.spyOn(claudeRelayService, 'isRealClaudeCodeRequest').mockReturnValue(true)
    jest
      .spyOn(claudeRelayService, '_applyRequestIdentityTransform')
      .mockImplementation((body, headers) => ({ body, headers }))

    const result = await claudeRelayService._prepareRequestHeadersAndPayload(
      {
        model: 'claude-sonnet-4-20250514',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{ role: 'user', content: 'hello' }]
      },
      { 'user-agent': unverifiedUserAgent },
      'account-1',
      'token',
      { account: { useUnifiedUserAgent: 'false' } }
    )

    expect(result.headers['User-Agent']).toBe('claude-cli/1.0.119 (external, cli)')
    expect(result.requestPayload.system[0].text).toContain('cc_version=1.0.119.')
    expect(result.requestPayload.system[0].text).not.toContain('cc_version=9999.9999.9999.9999.')
  })

  it('strips client billing markers case-insensitively', () => {
    const stringPayload = { system: 'X-Anthropic-Billing-Header: forged' }
    claudeRelayService._removeBillingHeaderFromSystem(stringPayload)
    expect(stringPayload.system).toBeUndefined()

    const arrayPayload = {
      system: [
        { type: 'text', text: 'X-ANTHROPIC-BILLING-HEADER: forged' },
        { type: 'text', text: 'real system' }
      ]
    }
    claudeRelayService._removeBillingHeaderFromSystem(arrayPayload)
    expect(arrayPayload.system).toEqual([{ type: 'text', text: 'real system' }])
  })
})
