const mockConfig = require('../config/config.example')

jest.mock('../config/config', () => mockConfig, { virtual: true })
jest.mock('../src/models/redis', () => ({ client: null }))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')

describe('ClaudeRelayService thinking block reinterleave', () => {
  it('preserves the relative order of thinking and non-thinking blocks', () => {
    const thinkingA = { type: 'thinking', thinking: 'a' }
    const thinkingB = { type: 'redacted_thinking', data: 'b' }
    const text = { type: 'text', text: 'answer' }
    const tool = { type: 'tool_use', id: 'tool-1' }

    expect(claudeRelayService._reinterleaveThinking([thinkingA, thinkingB, text, tool])).toEqual([
      thinkingA,
      text,
      thinkingB,
      tool
    ])
  })

  it('does not use quadratic Array.shift work for attacker-controlled block arrays', () => {
    const content = []
    for (let index = 0; index < 2000; index += 1) {
      content.push({ type: 'thinking', thinking: String(index) })
    }
    for (let index = 0; index < 2000; index += 1) {
      content.push({ type: 'text', text: String(index) })
    }

    const originalShift = Array.prototype.shift
    let shiftCalls = 0
    Array.prototype.shift = function countedShift() {
      shiftCalls += 1
      return originalShift.call(this)
    }

    try {
      expect(claudeRelayService._reinterleaveThinking(content)).toHaveLength(content.length)
    } finally {
      Array.prototype.shift = originalShift
    }

    expect(shiftCalls).toBe(0)
  })
})
