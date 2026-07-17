const {
  extractFirstUserMessageText,
  extractClaudeCodeVersionFromUserAgent,
  computeCCH,
  computeVersionSuffix,
  buildBillingHeaderValue,
  CCH_SALT,
  CCH_POSITIONS,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_ENTRYPOINT
} = require('../src/utils/cchHelper')

// ---------------------------------------------------------------------------
// Upstream parity vectors
//
// Ported from opencode-anthropic-auth/src/tests/cch.test.ts (commit fdc7837).
// These values MUST match upstream byte-for-byte — any divergence here means
// our port has drifted from the reference algorithm and the resulting
// billing header will not match official Claude Code traffic.
// ---------------------------------------------------------------------------

describe('cchHelper / upstream parity', () => {
  describe('extractFirstUserMessageText()', () => {
    it('extracts text from the first user message (skipping non-user, ignoring non-text blocks)', () => {
      expect(
        extractFirstUserMessageText([
          { role: 'assistant', content: 'ignore me' },
          {
            role: 'user',
            content: [
              { type: 'image', text: 'ignored' },
              { type: 'text', text: 'hello world test message' }
            ]
          }
        ])
      ).toBe('hello world test message')
    })
  })

  describe('computeCCH()', () => {
    it('produces the upstream-known 5-char hash for "hello world test message"', () => {
      expect(computeCCH('hello world test message')).toBe('4ffc3')
    })
  })

  describe('computeVersionSuffix()', () => {
    it('produces the upstream-known 3-char suffix for "hello world test message" + 2.1.87', () => {
      expect(computeVersionSuffix('hello world test message', '2.1.87')).toBe('6ff')
    })
  })

  describe('buildBillingHeaderValue()', () => {
    it('builds the exact upstream-known full header line', () => {
      expect(
        buildBillingHeaderValue(
          [{ role: 'user', content: 'hello world test message' }],
          '2.1.87',
          'sdk-cli'
        )
      ).toBe('x-anthropic-billing-header: cc_version=2.1.87.6ff; cc_entrypoint=sdk-cli; cch=4ffc3;')
    })
  })
})

// ---------------------------------------------------------------------------
// Defensive / edge-case tests beyond upstream's coverage
// ---------------------------------------------------------------------------

describe('cchHelper / edge cases', () => {
  describe('extractFirstUserMessageText() defensive paths', () => {
    it('returns empty string for non-array input', () => {
      expect(extractFirstUserMessageText(null)).toBe('')
      expect(extractFirstUserMessageText(undefined)).toBe('')
      expect(extractFirstUserMessageText('not an array')).toBe('')
      expect(extractFirstUserMessageText({})).toBe('')
    })

    it('returns empty string when no user message exists', () => {
      expect(extractFirstUserMessageText([])).toBe('')
      expect(
        extractFirstUserMessageText([
          { role: 'assistant', content: 'a' },
          { role: 'system', content: 'b' }
        ])
      ).toBe('')
    })

    it('returns empty string when user message has no text block in content array', () => {
      expect(
        extractFirstUserMessageText([
          {
            role: 'user',
            content: [
              { type: 'image', source: 'x' },
              { type: 'tool_result', content: 'y' }
            ]
          }
        ])
      ).toBe('')
    })

    it('skips falsy/malformed messages safely', () => {
      expect(
        extractFirstUserMessageText([
          null,
          undefined,
          { role: 'user', content: 'first real user msg' }
        ])
      ).toBe('first real user msg')
    })

    it('returns string content directly when content is a plain string', () => {
      expect(extractFirstUserMessageText([{ role: 'user', content: 'plain string' }])).toBe(
        'plain string'
      )
    })

    it('takes the FIRST text block when multiple text blocks exist', () => {
      expect(
        extractFirstUserMessageText([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' }
            ]
          }
        ])
      ).toBe('first')
    })

    it('takes the FIRST user message when multiple user messages exist', () => {
      expect(
        extractFirstUserMessageText([
          { role: 'user', content: 'first user msg' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second user msg' }
        ])
      ).toBe('first user msg')
    })

    it('returns empty when text block has empty/non-string text', () => {
      expect(
        extractFirstUserMessageText([{ role: 'user', content: [{ type: 'text', text: '' }] }])
      ).toBe('')
      expect(
        extractFirstUserMessageText([{ role: 'user', content: [{ type: 'text', text: null }] }])
      ).toBe('')
    })
  })

  describe('computeCCH() determinism & shape', () => {
    it('returns 5 lowercase hex chars', () => {
      const out = computeCCH('any text')
      expect(out).toMatch(/^[0-9a-f]{5}$/)
    })

    it('is deterministic for the same input', () => {
      expect(computeCCH('abc')).toBe(computeCCH('abc'))
    })

    it('handles empty string without throwing', () => {
      const out = computeCCH('')
      expect(out).toMatch(/^[0-9a-f]{5}$/)
    })

    it('coerces non-string input to string instead of throwing', () => {
      // SHA-256 of "123" is determined; just ensure no throw + valid shape
      expect(computeCCH(123)).toMatch(/^[0-9a-f]{5}$/)
    })
  })

  describe('computeVersionSuffix() position sampling', () => {
    it('returns 3 lowercase hex chars', () => {
      expect(computeVersionSuffix('long enough text 12345', '2.1.87')).toMatch(/^[0-9a-f]{3}$/)
    })

    it('uses "0" fallback for out-of-bounds positions (short input)', () => {
      // For 3-char input "abc", positions [4,7,20] all fall back to '0'.
      // chars = '000', so suffix = SHA-256('59cf53e54c780002.1.87').slice(0,3)
      // Stable regardless of impl as long as fallback rule holds.
      const expected = require('crypto')
        .createHash('sha256')
        .update(`${CCH_SALT}000${CLAUDE_CODE_VERSION}`)
        .digest('hex')
        .slice(0, 3)
      expect(computeVersionSuffix('abc', CLAUDE_CODE_VERSION)).toBe(expected)
    })

    it('returns null instead of using a hardcoded fallback when version is missing', () => {
      expect(computeVersionSuffix('abc')).toBeNull()
      expect(computeVersionSuffix('abc', '')).toBeNull()
      expect(computeVersionSuffix('abc', null)).toBeNull()
    })

    it('different version produces different suffix (with same text)', () => {
      const a = computeVersionSuffix('hello world test message', '2.1.87')
      const b = computeVersionSuffix('hello world test message', '9.9.99')
      expect(a).not.toBe(b)
    })
  })

  describe('buildBillingHeaderValue() composition', () => {
    it('returns null when version is omitted so live traffic cannot silently hardcode one', () => {
      const out = buildBillingHeaderValue([{ role: 'user', content: 'hello world test message' }])
      expect(out).toBeNull()
    })

    it('uses default entrypoint when version is provided', () => {
      const out = buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        CLAUDE_CODE_VERSION
      )
      expect(out).toContain(`cc_version=${CLAUDE_CODE_VERSION}.`)
      expect(out).toContain(`cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`)
      expect(out).toMatch(/cch=[0-9a-f]{5};$/)
    })

    it('emits empty-text fingerprint when no user message exists', () => {
      // Should not throw; cch/suffix should be deterministic for empty text.
      const out = buildBillingHeaderValue(
        [{ role: 'assistant', content: 'a' }],
        '2.1.87',
        'sdk-cli'
      )
      expect(out).toMatch(
        /^x-anthropic-billing-header: cc_version=2\.1\.87\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/
      )
    })

    it('header line is exactly one line, no trailing newline', () => {
      const out = buildBillingHeaderValue([{ role: 'user', content: 'x' }], '2.1.87', 'sdk-cli')
      expect(out).not.toMatch(/\n/)
      expect(out.endsWith(';')).toBe(true)
    })
  })

  describe('extractClaudeCodeVersionFromUserAgent()', () => {
    it('extracts stable Claude Code versions from outgoing User-Agent', () => {
      expect(extractClaudeCodeVersionFromUserAgent('claude-cli/2.1.87 (external, cli)')).toBe(
        '2.1.87'
      )
    })

    it('rejects prerelease and field-injection shaped versions', () => {
      expect(
        extractClaudeCodeVersionFromUserAgent('claude-cli/2.1.0-beta.1 (external, cli)')
      ).toBeNull()
      expect(
        extractClaudeCodeVersionFromUserAgent(
          'claude-cli/2.1.87;cc_entrypoint=attacker (external, cli)'
        )
      ).toBeNull()
    })

    it('returns null for non-Claude-Code or malformed user agents', () => {
      expect(extractClaudeCodeVersionFromUserAgent('opencode/1.0')).toBeNull()
      expect(extractClaudeCodeVersionFromUserAgent('claude-cli/2.1.87')).toBeNull()
      expect(extractClaudeCodeVersionFromUserAgent('')).toBeNull()
      expect(extractClaudeCodeVersionFromUserAgent(null)).toBeNull()
    })
  })

  describe('billing field validation', () => {
    it('rejects versions and entrypoints that could inject extra billing fields', () => {
      const messages = [{ role: 'user', content: 'hello' }]
      expect(buildBillingHeaderValue(messages, '2.1.87;cc_entrypoint=attacker')).toBeNull()
      expect(buildBillingHeaderValue(messages, '2.1.87', 'sdk-cli; cch=attacker')).toBeNull()
    })
  })

  describe('constants', () => {
    it('CCH_SALT matches upstream literal', () => {
      expect(CCH_SALT).toBe('59cf53e54c78')
    })

    it('CCH_POSITIONS matches upstream literal', () => {
      expect(CCH_POSITIONS).toEqual([4, 7, 20])
    })

    it('CLAUDE_CODE_VERSION is a semver-shaped string', () => {
      expect(CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    })

    it('CLAUDE_CODE_ENTRYPOINT matches upstream default', () => {
      expect(CLAUDE_CODE_ENTRYPOINT).toBe('sdk-cli')
    })
  })
})
