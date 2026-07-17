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
  selectAccountByWeight,
  applyResetWindow
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

describe('selectAccountByWeight - priority 语义兼容', () => {
  test('带 weight marker 的 Claude 账户直接使用较大数值作为权重', () => {
    const accounts = [
      { accountId: 'A', priority: 80, priorityMode: 'weight' },
      { accountId: 'B', priority: 20, priorityMode: 'weight' }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeight(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeight(accounts).accountId).toBe('B')
  })

  test('无 marker 的历史账户保留数字越小优先级越高的含义', () => {
    const accounts = [
      { accountId: 'A', priority: 20 },
      { accountId: 'B', priority: 80 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeight(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeight(accounts).accountId).toBe('B')
  })

  test('历史 priority 与新 weight marker 可以在同一池中按有效权重选择', () => {
    const accounts = [
      { accountId: 'legacy', priority: 20 },
      { accountId: 'weight', priority: 80, priorityMode: 'weight' }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(selectAccountByWeight(accounts).accountId).toBe('legacy')
    jest.spyOn(Math, 'random').mockReturnValue(0.51)
    expect(selectAccountByWeight(accounts).accountId).toBe('weight')
  })
})

describe('selectAccountByWeightWithResetBias - 临近重置获得更高权重', () => {
  test('真实 5h 窗口内，近重置账户(1h)概率高于远重置账户(5h)', () => {
    const accounts = [
      {
        accountId: 'A',
        priority: 50,
        priorityMode: 'weight',
        sessionWindowEnd: hoursFromNow(1)
      },
      {
        accountId: 'B',
        priority: 50,
        priorityMode: 'weight',
        sessionWindowEnd: hoursFromNow(5)
      }
    ]

    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')

    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })
})

describe('selectAccountByWeightWithResetBias - 因子上下限 clamp', () => {
  test('极近重置(0.1h)因子封顶为 maxBias=4', () => {
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
    const accounts = [
      { accountId: 'A', priority: 50, sessionWindowEnd: hoursFromNow(1000) },
      { accountId: 'B', priority: 50 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.49)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.51)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })

  test('已过重置时间不再获得即将过期额度偏置', () => {
    const accounts = [
      {
        accountId: 'A',
        priority: 10,
        priorityMode: 'weight',
        sessionWindowEnd: hoursFromNow(-5)
      },
      { accountId: 'B', priority: 10, priorityMode: 'weight' }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.49)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.51)
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
    const accounts = [
      { accountId: 'A', priority: 10, rateLimitEndAt: hoursFromNow(2) },
      { accountId: 'B', priority: 10 }
    ]
    jest.spyOn(Math, 'random').mockReturnValue(0.7)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.72)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })
})

describe('applyResetWindow - 用会话窗口信息富化 sessionWindowEnd', () => {
  test('windowEnd 存在时写入 account.sessionWindowEnd 并返回该 account', () => {
    const acc = { accountId: 'A', priority: 50 }
    const end = hoursFromNow(2)
    const out = applyResetWindow(acc, { hasActiveWindow: true, windowEnd: end })
    expect(out).toBe(acc)
    expect(acc.sessionWindowEnd).toBe(end)
  })

  test('sessionWindowInfo 为 null 时不改动 account', () => {
    const acc = { accountId: 'A', priority: 50 }
    applyResetWindow(acc, null)
    expect(acc.sessionWindowEnd).toBeUndefined()
  })

  test('sessionWindowInfo 无 windowEnd 时不改动 account', () => {
    const acc = { accountId: 'A', priority: 50 }
    applyResetWindow(acc, { hasActiveWindow: false, windowEnd: null })
    expect(acc.sessionWindowEnd).toBeUndefined()
  })

  test('非活动窗口即使残留 windowEnd 也不写入 account', () => {
    const acc = { accountId: 'A', priority: 50, sessionWindowEnd: hoursFromNow(3) }
    applyResetWindow(acc, { hasActiveWindow: false, windowEnd: hoursFromNow(-1) })
    expect(acc.sessionWindowEnd).toBeUndefined()
  })

  test('account 为 null 时安全返回，不抛异常', () => {
    expect(() => applyResetWindow(null, { windowEnd: hoursFromNow(1) })).not.toThrow()
    expect(applyResetWindow(null, { windowEnd: hoursFromNow(1) })).toBeNull()
  })

  test('富化后近重置账户在加权选择中显著占优（端到端）', () => {
    const a = applyResetWindow(
      { accountId: 'A', priority: 50, priorityMode: 'weight' },
      { hasActiveWindow: true, windowEnd: hoursFromNow(1) }
    )
    const b = applyResetWindow(
      { accountId: 'B', priority: 50, priorityMode: 'weight' },
      { hasActiveWindow: true, windowEnd: hoursFromNow(5) }
    )
    const accounts = [a, b]
    // weights 200/50，A 区间[0,200) → random<0.8 选 A
    jest.spyOn(Math, 'random').mockReturnValue(0.79)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('A')
    jest.spyOn(Math, 'random').mockReturnValue(0.81)
    expect(selectAccountByWeightWithResetBias(accounts).accountId).toBe('B')
  })
})
