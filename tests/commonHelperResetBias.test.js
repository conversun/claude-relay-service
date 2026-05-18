// 测试 reset 感知账户选择（分层调度第 2 层：优先级权重 × 重置临近度反比）
// commonHelper.js 依赖 ../config/config（开发检出不存在）→ 虚拟 mock

jest.mock(
  '../config/config',
  () => ({
    security: { encryptionKey: 'test-encryption-key-32-bytes-len!' },
    system: { timezoneOffset: 8 }
  }),
  { virtual: true }
)

const {
  selectAccountByWeightWithResetBias,
  selectAccountByWeight
} = require('../src/utils/commonHelper')

// 构造相对当前时间的 ISO 时间串（小时偏移）
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000).toISOString()

afterEach(() => {
  jest.restoreAllMocks()
})

describe('selectAccountByWeightWithResetBias - 边界与防御', () => {
  test('空数组返回 null', () => {
    expect(selectAccountByWeightWithResetBias([])).toBeNull()
  })

  test('非数组返回 null', () => {
    expect(selectAccountByWeightWithResetBias(null)).toBeNull()
    expect(selectAccountByWeightWithResetBias(undefined)).toBeNull()
    expect(selectAccountByWeightWithResetBias('x')).toBeNull()
  })

  test('单账户始终返回该账户', () => {
    const acc = { accountId: 'a', priority: 50 }
    jest.spyOn(Math, 'random').mockReturnValue(0.999)
    expect(selectAccountByWeightWithResetBias([acc])).toBe(acc)
  })
})

describe('selectAccountByWeightWithResetBias - 无重置信息时向后兼容', () => {
  test('无 reset 字段时结果与 selectAccountByWeight 一致（因子恒为 1）', () => {
    const accounts = [
      { accountId: 'A', priority: 80 },
      { accountId: 'B', priority: 20 }
    ]
    // weights = [80, 20], total = 100
    for (const m of [0.0, 0.3, 0.79, 0.8, 0.81, 0.99]) {
      jest.spyOn(Math, 'random').mockReturnValue(m)
      const biased = selectAccountByWeightWithResetBias(accounts)
      jest.spyOn(Math, 'random').mockReturnValue(m)
      const plain = selectAccountByWeight(accounts)
      expect(biased).toBe(plain)
    }
  })
})

describe('selectAccountByWeightWithResetBias - 临近重置获得更高权重', () => {
  test('近重置账户(2h)概率显著高于远重置账户(100h)', () => {
    // A: priority 50, 2h 后重置 → factor clamp(24/2,1,4)=4 → weight 200
    // B: priority 50, 100h 后重置 → factor clamp(24/100,1,4)=1 → weight 50
    // total 250，A 命中区间 [0,200) → random < 0.8 选 A
    const accounts = [
      { accountId: 'A', priority: 50, sessionWindowEnd: hoursFromNow(2) },
      { accountId: 'B', priority: 50, sessionWindowEnd: hoursFromNow(100) }
    ]

    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')

    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })
})

describe('selectAccountByWeightWithResetBias - 因子上下限 clamp', () => {
  test('极近重置(0.1h)因子封顶为 maxBias=4', () => {
    // A: priority 10, 0.1h → 24/0.1=240 clamp→4 → weight 40
    // B: priority 10, 无 reset → factor 1 → weight 10
    // total 50，A 区间 [0,40) → random < 0.8 选 A
    const accounts = [
      { accountId: 'A', priority: 10, sessionWindowEnd: hoursFromNow(0.1) },
      { accountId: 'B', priority: 10 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })

  test('极远重置(1000h)因子下限为 1（不低于基础权重）', () => {
    // A: priority 50, 1000h → 0.024 clamp→1 → weight 50
    // B: priority 50, 无 reset → weight 50；二者相等，边界 0.5
    const accounts = [
      { accountId: 'A', priority: 50, sessionWindowEnd: hoursFromNow(1000) },
      { accountId: 'B', priority: 50 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.49)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.51)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })

  test('已过重置时间(负剩余)因子为 maxBias=4', () => {
    // A: priority 10, 5h 前已过重置 → 负剩余 → factor 4 → weight 40
    // B: priority 10, 无 reset → weight 10；边界 0.8
    const accounts = [
      { accountId: 'A', priority: 10, sessionWindowEnd: hoursFromNow(-5) },
      { accountId: 'B', priority: 10 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })
})

describe('selectAccountByWeightWithResetBias - 字段健壮性', () => {
  test('无法解析的重置时间串 → 因子退化为 1', () => {
    // A: 非法日期 → factor 1 → weight 50；B: 无 reset → weight 50；边界 0.5
    const accounts = [
      { accountId: 'A', priority: 50, sessionWindowEnd: 'not-a-date' },
      { accountId: 'B', priority: 50 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.49)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.51)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })

  test('sessionWindowEnd 优先级高于 rateLimitEndAt', () => {
    // A: sessionWindowEnd 1h(→factor4)，rateLimitEndAt 1000h(若误用→factor1)
    //    priority 10 → 若用 sessionWindowEnd: weight 40，边界落在 0.8
    // B: priority 10 无 reset → weight 10
    const accounts = [
      {
        accountId: 'A',
        priority: 10,
        sessionWindowEnd: hoursFromNow(1),
        rateLimitEndAt: hoursFromNow(1000)
      },
      { accountId: 'B', priority: 10 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })

  test('rateLimitEndAt 在无 sessionWindowEnd 时作为回退信号', () => {
    // A: 仅 rateLimitEndAt 2h → factor clamp(24/2,1,4)=4 → weight 40
    // B: 无 reset → weight 10；边界 0.8
    const accounts = [
      { accountId: 'A', priority: 10, rateLimitEndAt: hoursFromNow(2) },
      { accountId: 'B', priority: 10 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })
})
