/**
 * R0916-5b（2026-09-16）：main.test.ts（kk-P2-8 主进程自动化，2800 行）按 describe
 * 域拆分件之一——「书库选择/落库/readStore」域：R44-14（pickLibrary git-ancestor
 * 防线）+ R52-A-1（嵌套书库防线）+ R47-9（readStore 内存缓存）+ R0912-A-P3-5
 * （bootstrap recent 过滤 await 窗并发写）+ R51-A-4（saveCurrent 抛错转 {ok,reason}
 * 契约）。
 * 用例自原文件 2183-2464 行整块原样搬移（describe/test 名称、断言、mock 行为零变化）；
 * mock 工厂/装置见 ./main-fixtures.js，④批 P2 监听器治理 harness 见
 * ./main-process-harness.js（R0915-P2 承重墙，逐件复刻）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  M,
  mkTmp,
  mkLibrary,
  tmpDirs,
  trustedEvent,
  captureMainTestEnvPrev,
  bootstrapMainFixture,
  restoreMainTestEnv,
  cleanupMainTmpDirs,
} from './main-fixtures.js'
import {
  installMainProcessListenerHarness,
  removeTrackedProcessListeners,
  restoreMainProcessListenerHarness,
} from './main-process-harness.js'

// ── ④批 P2 监听器治理 harness（R0915-P2 承重墙，R0916-5b 随拆分逐件复刻）───────────
// 模块级包装 process.on/once 透传记账 → afterEach 逐监听器拆除 → afterAll 兜底还原；
// 语义与原文详见 ./main-process-harness.js 头注。
installMainProcessListenerHarness()
const prevEnv = captureMainTestEnvPrev()

beforeAll(async () => {
  await bootstrapMainFixture()
})

afterAll(() => {
  // R0915-P2：末用例异步尾（重导入 whenReady 链迟到注册）兜底拆除 + 还原包装方法，
  // 零残留出文件（同 worker 后续测试文件不受影响）。
  removeTrackedProcessListeners()
  restoreMainProcessListenerHarness()
  restoreMainTestEnv(prevEnv)
  cleanupMainTmpDirs()
})

afterEach(() => {
  // R0915-P2：拆除本用例窗口内经包装注册的 process 监听器（含重导入 main.js 的
  // 六件套）——已 once 触发或调用方自拆的形态 removeListener 幂等无害；记账清空
  // 防单调增长。
  removeTrackedProcessListeners()
})

// R44-14（四十四轮）：书库接受面与 git-ancestor 防线合流——pickLibrary「在此新建」
// 原无 git 检查，git 仓库内落库的待建空书库到建第一本书才被 init 恒拒（空壳死胡同：
// 书架恒空、建书恒拒、recent 里的它无处可去）。修复后与 init 同源判定（findGitAncestor），
// 命中原生错误框反馈并留在选择循环。
describe('R44-14: pickLibrary「在此新建」的 git-ancestor 防线', () => {
  it('git 仓库内的目录 → 原生错误框拒绝，不落库不重启（选择循环内重选）', async () => {
    const gitRepo = mkdtempTracked(join(tmpdir(), 'clw-gitlib-'))
    mkdirSync(join(gitRepo, '.git'))
    writeFileSync(join(gitRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n') // isGitMarker 判定面
    const inner = join(gitRepo, '待建书库')
    mkdirSync(inner)
    tmpDirs.push(gitRepo)
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    M.dialogOpen = { canceled: false, filePaths: [inner] }
    M.msgResponse = 0 // 每轮都点「在此新建」→ 每轮都被 git 防线拦回
    const err0 = M.errorBox.length
    const relaunch0 = M.relaunchCalls
    const r = (await M.ipcHandle['desktop:open-library']!(trustedEvent(), {})) as { ok: boolean; canceled?: boolean }
    expect(r).toEqual({ ok: false, canceled: true }) // 封顶退出（E-9c），未选定
    const rejects = M.errorBox.slice(err0).filter(([t]) => String(t).includes('git'))
    expect(rejects.length).toBeGreaterThanOrEqual(1) // 原生错误框反馈（非静默 continue）
    expect(String(rejects[0]![1])).toContain('不能作为书库')
    expect(M.relaunchCalls).toBe(relaunch0) // 未落库未重启（saveCurrent/relaunch 未触）
  })
})

// R52-A-1（五十二轮）：pickLibrary「在此新建」的嵌套书库防线——目标位于既有书库
// 内部（findWorkDir 命中祖先而非自身）时此前放行：内层 .clwriting/ 建成后抢占
// workDir 判定，外层书库的 server 端口/锁根/task-gate 单进程单锁契约被篡改面。
// 修复后与 canSwitchLibraryDir（switch-library 侧同款防线）口径对齐：命中原生错误框
// 反馈并留在选择循环；书库外的普通目录放行不变。
describe('R52-A-1: pickLibrary「在此新建」的嵌套书库防线', () => {
  it('书库子目录点「在此新建」→ 原生错误框拒绝，不落库不重启（选择循环内重选至封顶）', async () => {
    const lib = mkLibrary() // 既有书库（.clwriting/ 在位）
    const inner = join(lib, '误建子目录')
    mkdirSync(inner)
    tmpDirs.push(lib)
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    M.dialogOpen = { canceled: false, filePaths: [inner] }
    M.msgResponse = 0 // 每轮都点「在此新建」→ 每轮被嵌套防线拦回
    const err0 = M.errorBox.length
    const relaunch0 = M.relaunchCalls
    const r = (await M.ipcHandle['desktop:open-library']!(trustedEvent(), {})) as { ok: boolean; canceled?: boolean }
    expect(r).toEqual({ ok: false, canceled: true }) // 封顶退出（E-9c），未选定
    const rejects = M.errorBox.slice(err0).filter(([t]) => String(t).includes('书库内部'))
    expect(rejects.length).toBeGreaterThanOrEqual(1) // 原生错误框反馈（非静默 continue）
    expect(String(rejects[0]![1])).toContain('嵌套书库')
    expect(M.relaunchCalls).toBe(relaunch0) // 未落库未重启（saveCurrent/relaunch 未触）
    M.dialogOpen = { canceled: true, filePaths: [] }
    vi.resetModules()
  })

  it('放行臂：书库外普通目录点「在此新建」照常落库重启（防线不误伤）', async () => {
    const plain = mkTmp('clw-r52a1-plain-') // 无 .clwriting、无 .git、非任何书库子目录
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    M.dialogOpen = { canceled: false, filePaths: [plain] }
    M.msgResponse = 0 // 点「在此新建」
    const err0 = M.errorBox.length
    const r = (await M.ipcHandle['desktop:open-library']!(trustedEvent(), {})) as { ok: boolean }
    expect(r).toEqual({ ok: true }) // 放行：落库成功
    // 放行铁证 = workdir.json current 已持久化为该目录（relaunch 系 R51-A-1 意图制、
    // 推迟到 before-quit 不可回头点，测试态不可达，不作断言面）
    const stored = JSON.parse(readFileSync(join(M.userData, 'workdir.json'), 'utf-8')) as { current: string | null }
    expect(stored.current).toBe(plain)
    expect(M.errorBox.length).toBe(err0) // 零错误框（防线未误伤）
    M.dialogOpen = { canceled: true, filePaths: [] }
    vi.resetModules()
  })
})

// ── R47-9（四十七轮）：readStore 内存缓存（写时失效）──────────────────────────

describe('R47-9：readStore 内存缓存——welcome/常态 IPC 不再逐调全量读盘', () => {
  it('get-recent 命中缓存：外部改写 workdir.json 不再被感知（应用管理文件语义），switch-library 后刷新', async () => {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const recent0 = M.ipcHandle['desktop:get-recent']!(trustedEvent(), {}) as Array<{ path: string }>
    // 外部手改 workdir.json（缓存语义下对 readStore 不可见——应用管理文件，重启可见）
    const fp = join(M.userData, 'workdir.json')
    const raw0 = JSON.parse(readFileSync(fp, 'utf-8')) as { current: string | null; recent: Array<{ path: string }> }
    writeFileSync(fp, JSON.stringify({ ...raw0, recent: [{ path: '/external/imposter' }] }))
    const recent1 = M.ipcHandle['desktop:get-recent']!(trustedEvent(), {}) as Array<{ path: string }>
    expect(recent1).toEqual(recent0) // 缓存命中，未读盘未重过滤
    expect(recent1.some((r) => r.path === '/external/imposter')).toBe(false)
    // 写路径（writeStore）刷新缓存：switch-library 合法目录后，currentWorkDir 的
    // ?? 兜底（welcome 态 bootstrappedWorkDir=null）经缓存读到新 current——零盘 IO
    const libNew = join(M.userData, 'r47-lib-new')
    mkdirSync(join(libNew, '.clwriting'), { recursive: true }) // isLibraryDir 判定面（同 libA 夹具）
    tmpDirs.push(libNew)
    const r2 = await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libNew)
    expect(r2).toBeTruthy()
    // relaunch 由 harness 拦截；get-current 走 M-3「bootstrap 实际值优先」仍回 libA
    //（语义不变），writeStore 刷新的缓存经 get-recent 可见——旧 current 已入 recent
    const recent2 = M.ipcHandle['desktop:get-recent']!(trustedEvent(), {}) as Array<{ path: string }>
    expect(recent2.some((r) => r.path === raw0.current)).toBe(true)
    // 还原 workdir.json（后续用例）
    writeFileSync(fp, JSON.stringify({ current: raw0.current, recent: raw0.recent }))
    vi.resetModules()
  })
})

// ── R0912-A-P3-5（2026-09-12 独立重评修复批）：bootstrap recent 过滤 await 窗并发写 ──
// filterValidRecentBudgeted 的 await 窗内（菜单/IPC 冷启动链）并发 saveCurrent→writeStore
// 换掉 storeCache 对象后，原「整对象赋值回填」会把旧 store 的 current 整体写回——内存面
// 回滚并发写、与盘面自此分叉。修复 = 仅回填 recent 字段（展开当下 storeCache）。
// 手法：doMock 受控 filterValidRecentBudgeted（手动闸拉宽 await 窗，其余导出透传
// actual）；并发写走「打开书库目录…」菜单链（菜单点击不经受信 sender 校验）；判别面
// = welcome 态（bootstrappedWorkDir=null）下 get-current 回落 readStore().current——
// 回潮（整对象赋值）时该值被旧 store 的 current=null 覆盖，断言红。
describe('R0912-A-P3-5: bootstrap recent 过滤 await 窗并发写不被内存面回滚', () => {
  it('过滤窗内的菜单切库落库后，storeCache.current 保留新值（仅 recent 被回填）', async () => {
    const fp = join(M.userData, 'workdir.json')
    const backup = readFileSync(fp, 'utf-8')
    // 夹具：current=null（welcome 态——判别面如上）、recent 1 条真实目录（过滤后保留）
    const recentDir = mkTmp('clw-main-recent-race-')
    writeFileSync(fp, JSON.stringify({ current: null, recent: [{ path: recentDir, label: '旧recent' }] }))
    const gates: Array<() => void> = []
    vi.resetModules()
    vi.doMock('../../src/desktop/workdir-store.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/desktop/workdir-store.js')>()
      return {
        ...actual,
        filterValidRecentBudgeted: async (
          store: Parameters<typeof actual.filterValidRecentBudgeted>[0],
          opts: Parameters<typeof actual.filterValidRecentBudgeted>[1],
        ) => {
          await new Promise<void>((r) => gates.push(r)) // 手动闸：bootstrap 停在过滤 await 上
          return actual.filterValidRecentBudgeted(store, opts)
        },
      }
    })
    try {
      await import('../../src/desktop/main.js')
      await new Promise((r) => setImmediate(r)) // whenReady 链（CSP→IPC→菜单→bootstrap）停闸上
      // await 窗内并发写：菜单「打开书库目录…」→ 选 libB → 落库 + storeCache 换新对象
      const libB = mkLibrary('书B', 'books/b')
      M.dialogOpen = { canceled: false, filePaths: [libB] }
      const findClick = (items: Array<Record<string, unknown>>): (() => void) | undefined => {
        for (const it of items) {
          if (it.label === '打开书库目录…' && typeof it.click === 'function') return it.click as () => void
          if (Array.isArray(it.submenu)) {
            const hit = findClick(it.submenu as Array<Record<string, unknown>>)
            if (hit) return hit
          }
        }
        return undefined
      }
      const click = findClick(M.menuTemplate!)
      expect(click, '菜单模板应含「打开书库目录…」项').toBeTruthy()
      click!()
      await new Promise((r) => setImmediate(r)) // 选库链（dialog→预探→落库）微任务冲刷
      // 并发写已落盘：文件 current=libB（此刻内存面同样指向 libB——writeStore 换对象）
      expect((JSON.parse(readFileSync(fp, 'utf-8')) as { current: string | null }).current).toBe(libB)
      gates.shift()!() // 放行过滤：基于旧 store 对象（current=null）算出 {current:null, recent:[kept]}
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r)) // bootstrap 收尾（welcome 态开窗 + fork）
      // 修复锚点：bootstrappedWorkDir=null（旧 store.current）→ get-current 回落
      // readStore().current——仅回填 recent 即 libB；整对象赋值回潮即 null（内存面回滚）
      expect(M.ipcHandle['desktop:get-current']!(trustedEvent())).toBe(libB)
      // recent 照常回填（过滤语义本身不变）
      expect(M.ipcHandle['desktop:get-recent']!(trustedEvent())).toEqual([
        { path: recentDir, label: '旧recent' },
      ])
    } finally {
      vi.doUnmock('../../src/desktop/workdir-store.js')
      vi.resetModules()
      writeFileSync(fp, backup)
      M.dialogOpen = { canceled: true, filePaths: [] }
    }
  })
})

// ── R51-A-4（五十一轮）：open/switch-library 落库失败转 {ok:false,reason} 契约 ──
// saveCurrent → atomicWriteFile 可抛（磁盘满/权限/EISDIR），原实现裸抛绕过 {ok,reason}
// 信封直达 invoke 异常通道，且 setTimeout(relaunch) 已排程——落库失败照常重启 = 带着
// 旧 current 重启、用户操作像被吞。修后 saveCurrentSafe 包装：失败回结构化 reason 且
// 不触发 relaunch/quit。
describe('R51-A-4: saveCurrent 抛错不再绕过 {ok,reason} 契约', () => {
  // fp 惰性求值：describe 收集期 M.userData 尚未由 beforeAll 赋值（模块级常量会得相对路径）
  const storeFp = (): string => join(M.userData, 'workdir.json')

  /** 重载模块 + 预热 readStore 缓存（真身文件仍在位时读一次——打断写路径后读盘全走缓存） */
  async function freshWithCache(): Promise<void> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    M.ipcHandle['desktop:get-recent']!(trustedEvent(), {})
    await drainCaptureSurface()
  }

  /**
   * R56-P2-1：捕获面排水——前序用例成功路径排程的 `setTimeout(relaunch, 100)`
   * （RELAUNCH_DELAY_MS 真实定时器）及其 before-quit 级联链（quit → shutdown →
   * finally 二次 quit）在 `vi.resetModules()` 后仍持旧模块闭包继续跑（M 捕获面
   * 模块级共享），win 慢盘时序下可漂入本组用例 quit0/rel0 捕获之后的窗口
   * （win 全量首跑实测 +1 quit；mac 快时序不显现）。此处排到「捕获面静止」：
   * 连续 3 拍（50ms 间隔）quit/relaunch 计数无新增即视为前序在途链清空，
   * 2s 上限防挂死。须在 quit0/rel0 基线捕获**之前**调用（freshWithCache 尾部）。
   */
  async function drainCaptureSurface(): Promise<void> {
    const deadline = Date.now() + 2000
    let lastQ = M.quitCalls
    let lastR = M.relaunchCalls
    let stable = 0
    while (stable < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      if (M.quitCalls === lastQ && M.relaunchCalls === lastR) {
        stable += 1
      } else {
        stable = 0
        lastQ = M.quitCalls
        lastR = M.relaunchCalls
      }
    }
  }

  /** 用同路径目录替换 workdir.json：writeStore 的 rename 目标是目录 → 必抛（EISDIR） */
  function breakStoreFile(): () => void {
    const fp = storeFp()
    const raw = readFileSync(fp, 'utf-8')
    rmSync(fp)
    mkdirSync(fp)
    return () => {
      rmSync(fp, { recursive: true })
      writeFileSync(fp, raw) // 还原真身（共享 M.userData，后续用例/批次依赖）
    }
  }

  it('switch-library：落库抛错 → {ok:false,reason}，不 relaunch 不退出', async () => {
    await freshWithCache()
    const restore = breakStoreFile()
    try {
      const rel0 = M.relaunchCalls
      const quit0 = M.quitCalls
      const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), mkTmp('clw-r51-a4-lib-'))) as {
        ok: boolean
        reason?: string
      }
      expect(r.ok).toBe(false)
      expect(String(r.reason)).toContain('workdir.json')
      // 给潜在误排程的 setTimeout(relaunch,100) 两拍机会——若触发即红
      await new Promise((r2) => setImmediate(r2))
      await new Promise((r2) => setImmediate(r2))
      expect(M.relaunchCalls).toBe(rel0) // 落库失败不重启（原实现已排程 relaunch）
      expect(M.quitCalls).toBe(quit0)
    } finally {
      restore()
    }
    vi.resetModules()
  })

  it('open-library：选中书库后落库抛错 → {ok:false,reason}（非裸异常）', async () => {
    await freshWithCache()
    const restore = breakStoreFile()
    try {
      const lib = mkLibrary('书B', 'books/b')
      M.dialogOpen = { canceled: false, filePaths: [lib] }
      const rel0 = M.relaunchCalls
      const r = (await M.ipcHandle['desktop:open-library']!(trustedEvent(), {})) as { ok: boolean; reason?: string }
      expect(r.ok).toBe(false)
      expect(String(r.reason)).toContain('workdir.json')
      await new Promise((r2) => setImmediate(r2))
      expect(M.relaunchCalls).toBe(rel0)
    } finally {
      restore()
      M.dialogOpen = { canceled: true, filePaths: [] }
    }
    vi.resetModules()
  })
})

// ── 0918二轮修复批（C102）：switch-library 相对路径拒收 ──────────────────────
// handler 原只验 typeof string——'./foo' 类相对路径恰存在于主进程 cwd 时可过
// probeDirReachable/canSwitchLibraryDir 守卫（statSync/findWorkDir 均按 cwd 解析）并
// 原样落库 workdir.json，下次经不同 cwd 启动书库定位漂移。入口加 path.isAbsolute
// 校验，BAD_INPUT 人话错误。
describe('switch-library 相对路径拒收（C102）', () => {
  it('./foo 相对路径 → {ok:false} 绝对路径人话错误；不落库不重启', async () => {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const rel0 = M.relaunchCalls
    const raw0 = readFileSync(join(M.userData, 'workdir.json'), 'utf-8')
    const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), './foo')) as {
      ok: boolean
      reason?: string
    }
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toContain('必须是绝对路径') // 人话错误（修复前：'目录无效…'守卫文案）
    expect(M.relaunchCalls).toBe(rel0) // 未触重启链
    expect(readFileSync(join(M.userData, 'workdir.json'), 'utf-8')).toBe(raw0) // workdir.json 未被改写
  })

  it('绝对路径照常走可达性/守卫链（不被新校验误伤）', async () => {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const r = (await M.ipcHandle['desktop:switch-library']!(
      trustedEvent(),
      join(M.userData, 'c102-abs-not-exist'),
    )) as { ok: boolean; reason?: string }
    expect(r.ok).toBe(false)
    // 走的是既有守卫文案（目录无效/暂不可达），非新校验的「绝对路径」错误
    expect(String(r.reason)).not.toContain('必须是绝对路径')
  })
})
