const express = require('express')
const request = require('supertest')

const mockClearUnifiedUserAgentCache = jest.fn().mockResolvedValue({ status: 1 })

jest.mock('../config/config', () => require('../config/config.example'), { virtual: true })
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/relay/claudeRelayService', () => ({
  clearUnifiedUserAgentCache: mockClearUnifiedUserAgentCache
}))
jest.mock('../src/models/redis', () => ({ client: {} }))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const systemRouter = require('../src/routes/admin/system')

describe('POST /claude-code-version/clear', () => {
  it('uses the generation-aware relay cache clear operation', async () => {
    const app = express()
    app.use(express.json())
    app.use(systemRouter)

    const response = await request(app).post('/claude-code-version/clear').send({})

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(mockClearUnifiedUserAgentCache).toHaveBeenCalledTimes(1)
  })
})
