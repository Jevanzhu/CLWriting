/**
 * 定长实睡门直测（scripts/check-sleeps.mjs）。
 *
 * 判据的难点全在**区分三类形态**，三者的源码长得几乎一样，故逐类锚定：
 * 1. 裸实睡（不受欢迎）→ 命中，应改 `vi.waitFor` 轮询判据；
 * 2. 循环内的轮询间隔（正确形态）→ 不命中——`while (!ok && Date.now() < deadline) await sleep(100)`
 *    里的 100ms 是两次探测之间的间隔，判据是那行 while 条件；
 * 3. 竞速守卫（正确形态）→ 不命中——promise 由真实事件 resolve，定时器只是「等太久就杀掉」
 *    的兜底；把它算成实睡会让门逼人删掉兜底，用例在挂死时会永久卡住。
 *
 * 另锚「上锚」口径的双向：存量内不红、超出即红、低于不追。
 */
import { describe, expect, it } from 'vitest'
import {
  findSleeps,
  REGISTERED,
  SLEEP_BASELINE,
  SLEEP_THRESHOLD_MS,
  splitByBaseline,
  // @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）。
} from '../../scripts/check-sleeps.mjs'

/** 命中形状（与脚本返回值对齐；脚本侧无 d.ts，故在测试面显式声明） */
interface SleepHit {
  file?: string
  line: number
  ms: number
  text: string
}

const sleepIn = (body: string) => findSleeps(`async function t() {\n${body}\n}\n`, 'x.test.ts')

describe('findSleeps：裸实睡命中', () => {
  it('new Promise + setTimeout 两形都命中（裸调用与属性访问）', () => {
    expect(sleepIn('await new Promise((r) => setTimeout(r, 200))').map((h: SleepHit) => h.ms)).toEqual([200])
    expect(sleepIn('await new Promise((r) => globalThis.setTimeout(r, 300))').map((h: SleepHit) => h.ms)).toEqual([300])
    // 回调包一层同样命中（resolve 调用落在定时器内，属唯一出口）
    expect(sleepIn('await new Promise((r) => setTimeout(() => r(), 150))').map((h: SleepHit) => h.ms)).toEqual([150])
  })

  it('sleep()/delay() 助手形命中', () => {
    expect(sleepIn('await sleep(500)').map((h: SleepHit) => h.ms)).toEqual([500])
    expect(sleepIn('await delay(120)').map((h: SleepHit) => h.ms)).toEqual([120])
  })

  it('阈值以下不算（个位数毫秒是让出事件循环，不是等一个状态）', () => {
    expect(sleepIn('await new Promise((r) => setTimeout(r, 3))')).toEqual([])
    expect(SLEEP_THRESHOLD_MS).toBe(100)
    // 边界：恰好等于阈值算命中（「≥100ms 才值得拦」是本门的口径）
    expect(sleepIn('await new Promise((r) => setTimeout(r, 100))')).toHaveLength(1)
  })

  it('非 await 的 setTimeout 不算（排程自带句柄，不是实睡）', () => {
    expect(sleepIn('const timer = setTimeout(() => {}, 500)')).toEqual([])
    // 非字面量毫秒判不了 → 不猜（宁可漏也不误杀）
    expect(sleepIn('await new Promise((r) => setTimeout(r, MS))')).toEqual([])
  })
})

describe('findSleeps：正确形态不误杀', () => {
  it('循环内的轮询间隔不计（判据是 while 条件，不是那个时长）', () => {
    const body = [
      'const deadline = Date.now() + 5000',
      'while (!existsSync(marker) && Date.now() < deadline) {',
      '  await new Promise((r) => setTimeout(r, 100))',
      '}',
      'for (let i = 0; i < 3; i++) { await sleep(200) }',
      'do { await sleep(150) } while (pending)',
    ].join('\n')
    expect(sleepIn(body)).toEqual([])
  })

  it('竞速守卫不计：promise 由真实事件 resolve，定时器只是兜底', () => {
    const body = [
      'await new Promise<void>((resolve) => {',
      '  const timer = setTimeout(() => { proc.kill() }, 7000)',
      "  proc.on('exit', () => { clearTimeout(timer); resolve() })",
      '})',
    ].join('\n')
    // 事件回调 resolve → 另有一条出口 → 不是实睡
    expect(sleepIn(body)).toEqual([])
  })

  it('竞速守卫的另一种写法：resolve 在定时器外被直接调用', () => {
    const body = [
      'await new Promise<string>((resolve, reject) => {',
      "  const sock = net.connect(addr, '127.0.0.1')",
      "  const timer = setTimeout(() => reject(new Error('timeout')), 2000)",
      "  sock.on('data', (b) => { clearTimeout(timer); resolve(String(b)) })",
      '})',
    ].join('\n')
    expect(sleepIn(body)).toEqual([])
  })
})

describe('splitByBaseline：上锚双向', () => {
  const hit = (file: string, line: number) => ({ file, line, ms: 200, text: '' })

  it('存量内不红；超出即红', () => {
    const base = { 'a.test.ts': 2 }
    expect(splitByBaseline([hit('a.test.ts', 1)], base).excess).toEqual([])
    const over = splitByBaseline([hit('a.test.ts', 1), hit('a.test.ts', 5), hit('a.test.ts', 9)], base)
    expect(over.excess.map((h: SleepHit) => h.line)).toEqual([9])
  })

  it('未登记档的 baseline 视为 0（新档写实睡即红）', () => {
    expect(splitByBaseline([hit('new.test.ts', 3)], {}).excess).toHaveLength(1)
  })

  it('低于锚不追（清理后不下调锚也不红）', () => {
    expect(splitByBaseline([], { 'a.test.ts': 5 }).excess).toEqual([])
  })

  it('存量按行号靠前优先占位：同档新加一处落在尾部而非把存量挤成新增', () => {
    const base = { 'a.test.ts': 1 }
    const { excess } = splitByBaseline([hit('a.test.ts', 50), hit('a.test.ts', 10)], base)
    expect(excess.map((h: SleepHit) => h.line)).toEqual([50])
  })
})

describe('现行登记面', () => {
  it('baseline 每条都指向现存档，计数为正', () => {
    for (const [file, count] of Object.entries(SLEEP_BASELINE)) {
      expect(file, file).toMatch(/^test\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/)
      expect(count, file).toBeGreaterThan(0)
    }
  })

  it('登记理由必须是「负向断言」的观察窗（不收「等状态出现」的档）', () => {
    for (const [file, reason] of Object.entries(REGISTERED)) {
      expect(SLEEP_BASELINE[file], `理由指向未登记的档：${file}`).toBeGreaterThan(0)
      expect(reason, file).toContain('负向断言')
    }
  })
})
