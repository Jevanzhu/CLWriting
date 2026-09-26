/**
 * 0918四轮修复批（C401）回归：workdir.json 读失败 fail-open 后不得被空历史覆写。
 *
 * 缺陷形态：readStore 对非 ENOENT 读失败 warn 后缓存 emptyStore 且不再重读（R61-B-2
 * 降级语义），此后 saveCurrent → writeStore 原子覆写——磁盘上完好的库指针与 recent
 * 列表被「读失败的空 store」整体抹掉，与 install/books.ts readBooksStrict 的 DA-3
 * 「读失败拒绝重写」纪律不对称。
 *
 * 修复语义（workdir-controller.ts writeStore 写前对账闸）：
 * - 读失败期置 workdirReadFailed 闸（ENOENT 不置——首启常态合法）；
 * - 写前清缓存重读：重读成功 → 以盘上内容为基底重放本次变更（setCurrent 语义：旧
 *   current 移入 recent，再写新 current，历史不丢）；重读仍失败 → 拒绝覆写并抛错
 *   （saveCurrentSafe 契约面呈现「已阻止写入」人话文案）；
 * - 读失败期的回滚基线快照置 null（取消退出不得把合并结果回写回空）。
 *
 * 手法：electron/windows.js/log 假件 + node:fs 选择性 readFileSync 假件（仅 workdir.json
 * 注入 EACCES，读写不对称才能区分「闸拒绝」与「物理写失败」），每用例 resetModules 取
 * 全新模块态（storeCache/workdirReadFailed 归零）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 假件开关（vi.hoisted 保证 vi.mock 工厂可见）：仅对 workdir.json 注入 EACCES 读失败 */
const F = vi.hoisted(() => ({ failRead: false }))
/** log 捕获面 */
const M = vi.hoisted(() => ({
  userData: '',
  warns: [] as unknown[][],
  errors: [] as unknown[][],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (F.failRead && String(path).endsWith('workdir.json')) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'（假件）`), {
          code: 'EACCES',
        })
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    },
  }
})
vi.mock('electron', () => ({
  app: { getPath: (): string => M.userData },
  dialog: {},
}))
vi.mock('../../src/desktop/windows.js', () => ({ wins: {} }))
vi.mock('../../src/log/index.js', () => ({
  // 复审-0914-优化修复批同款同语义假件（errMsg 收编面保持 mock 完整）
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  initLogging: (): void => undefined,
  log: {
    error: (...a: unknown[]) => {
      M.errors.push(a)
    },
    warn: (...a: unknown[]) => {
      M.warns.push(a)
    },
    info: (): void => {},
  },
}))

const tmpDirs: string[] = []
let fp = ''
const libA = '/libs/A'
const libB = '/libs/B'
const libC = '/libs/C'

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/** 每用例全新 userData：storeCache/workdirReadFailed 与盘面同时归零（用例间零串扰） */
function freshUserDir(): void {
  const d = mkdtempSync(join(tmpdir(), 'clw-c401-ud-'))
  tmpDirs.push(d)
  M.userData = d
  fp = join(d, 'workdir.json')
}

/** 每用例全新模块：storeCache / workdirReadFailed 随 resetModules 归零 */
async function freshController(): Promise<typeof import('../../src/desktop/workdir-controller.js')> {
  vi.resetModules()
  return await import('../../src/desktop/workdir-controller.js')
}

function seed(content: unknown): void {
  writeFileSync(fp, JSON.stringify(content))
}

describe('C401: workdir.json 读失败防覆写闸', () => {
  it('读失败（EACCES）后 setCurrent 拒写：契约错误含「已阻止写入」且盘上原文件字节未动', async () => {
    freshUserDir()
    const ctl = await freshController()
    const c0 = JSON.stringify({ current: libA, recent: [{ path: libB, label: 'B' }] })
    writeFileSync(fp, c0)
    F.failRead = true
    // 首读失败 → 无存储降级（R61-B-2 原语义）+ warn 留痕
    const degraded = ctl.readStore()
    expect(degraded.current).toBeNull()
    expect(degraded.recent).toEqual([])
    expect(M.warns.some((w) => String(w[1]).includes('workdir.json 读取失败'))).toBe(true)
    // 重读仍失败 → 拒绝覆写（saveCurrentSafe 契约面返回人话 reason，不裸抛）
    const err = ctl.saveCurrentArmingRollback(libC)
    expect(err).toContain('已阻止写入')
    expect(err).toContain('工作目录记录读取失败')
    // 盘上原文件未被触碰（写盘动作整体未发生）
    F.failRead = false
    expect(readFileSync(fp, 'utf-8')).toBe(c0)
  })

  it('瞬时读失败恢复后 setCurrent 以盘上内容为基底合并写入：旧 current 入 recent 头部、既有 recent 不丢', async () => {
    freshUserDir()
    const ctl = await freshController()
    seed({ current: libA, recent: [{ path: libB, label: 'B' }] })
    F.failRead = true
    expect(ctl.readStore().current).toBeNull() // 读失败降级（置闸）
    F.failRead = false // 瞬时故障恢复（杀毒/同步盘锁消散）
    expect(ctl.saveCurrentArmingRollback(libC)).toBeNull()
    const disk = JSON.parse(readFileSync(fp, 'utf-8')) as { current: string; recent: { path: string }[] }
    expect(disk.current).toBe(libC)
    const paths = disk.recent.map((r) => r.path)
    expect(paths[0], '盘上旧 current 移入 recent 头部（setCurrent 语义）').toBe(libA)
    expect(paths, '既有 recent 历史不被失败空 store 抹掉').toContain(libB)
  })

  it('ENOENT 路径行为不变：首启读空（静默无 warn）→ setCurrent 正常落盘', async () => {
    freshUserDir()
    const ctl = await freshController()
    // 不 seed：首启常态 workdir.json 不存在（ENOENT 不置闸）
    const warns0 = M.warns.length
    expect(ctl.readStore()).toEqual({ current: null, recent: [] })
    expect(M.warns.length, 'ENOENT 静默（首启合法常态）').toBe(warns0)
    expect(ctl.saveCurrentArmingRollback(libA)).toBeNull()
    const disk = JSON.parse(readFileSync(fp, 'utf-8')) as { current: string; recent: unknown[] }
    expect(disk.current).toBe(libA)
    expect(disk.recent).toEqual([])
  })

  it('读失败期落库成功（恢复后合并写）→ 取消退出回滚不取失败空快照：合并结果原样保留', async () => {
    freshUserDir()
    const ctl = await freshController()
    seed({ current: libA, recent: [] })
    F.failRead = true
    ctl.readStore() // 读失败降级（置闸）——此刻 readStore 快照若作回滚基线即空 store
    F.failRead = false
    expect(ctl.saveCurrentArmingRollback(libC)).toBeNull() // 恢复后合并写 {current:libC, recent:[libA]}
    ctl.rollbackCancelledSwitch() // 作者取消退出：无基线（失败空快照不作基线）→ 不回写
    const disk = JSON.parse(readFileSync(fp, 'utf-8')) as { current: string; recent: { path: string }[] }
    expect(disk.current, '取消回滚不得把合并结果覆盖回空').toBe(libC)
    expect(disk.recent.map((r) => r.path)).toContain(libA)
  })
})
