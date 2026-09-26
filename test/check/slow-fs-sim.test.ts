/**
 * 阶段 52 批 1（P3-12）收口证据：慢盘仿真下两条驱动的存活与停顿度量。
 *
 * 口径：`vi.mock('node:fs')` 给链上三支重 IO（readdirSync/statSync/readFileSync，即
 * walk 族 + 整读族）各注一段**墙钟阻塞**——模拟网络盘/机械盘冷缓存上「每次目录列举/
 * stat/整读都要等盘」的形态（实核：`Atomics.wait(ms)` 在 win 上被计时器粒度抬到 ~15ms，
 * 故用 `performance.now()` 自旋卡到目标墙钟时长，量级可预期、跨平台一致）。真网络盘不
 * 进 CI，故此套只断言「存活 + 功能等价」，数值（最长单次停顿/请求总时长）打印留档 §六，
 * **不做数值断言**（机器负载/计时器粒度会让阈值脆）。
 *
 * 度量法：自续期 setImmediate 探针记相邻回调的 Date.now 间隔——同步长段期间探针无插队
 * 机会，间隔即该段时长；间隔超阈值时同时打印段计数快照（定位停顿落在哪一段，故探针
 * 观测前先复位计数）。计时对比须同态：逐场景**新造同形书各跑一次冷启动**（同书重跑会
 * 命中章目录/md 文本/rebuild 增量缓存，比的是热路径）。
 *
 * 探针尾段纪律：驱动完成时其 promise 决议的续体是微任务，先于计时器相位跑——探针那枚
 * 「已到期」的回调还没轮到就被 `stop()` 掐掉，末尾大块会被整段漏记（① 的 rebuild 块恰在
 * 末尾：曾见块前 maxGap 31 → 块后仍 31，而块实测 349ms）。故每次驱动后先 `settleProbe()`
 * 让出一拍（探针到期回调在计时器相位先跑并记上真实间隔）再 stop()。
 *
 * 场景（四个数字说明四件事：切片生效 → 剩余大块恰是 rebuild → rebuild 搬 worker 后大块消失
 * → 单章链同样被切片接管）：
 *   ① 同执行档切片对比（前奏段单独的书：重布线 + 零章，逐章残余为空）：注入桩让两驱动
 *      都走同步 openCheckDb，唯一变量 = 让出点 ⇒ 同步一条长段 vs async 只剩 rebuild 块。
 *   ② 真 worker 档（同形书）：async 经 openCheckDbAsync → runRebuildAsync，rebuild 出
 *      主线程 ⇒ 停顿回落到让出粒度量级。
 *   ③ 真实混合书（重布线 + 5 章）：如实留档**未切片残余**——逐章机检按 25 章粒度让出
 *      （R37-3 既有常量，刀 2 面）+ 单文件/单句柄粒度 D4 残余，与本批切片无关但同现于
 *      真实请求，不混进 ①/② 的结论里。
 *   ④ 单章链（重布线 + 30 章 + 60 章纲 + 30 条履历；刀 2 S7 并入）：`runCheckForDocument`
 *      同步一条长段 vs `runCheckForDocumentAsync`（rebuild 走 worker + 履历段/章纲整扫
 *      分段让出）——停顿时长与「同步总时长」，加结果等价锚。
 *
 * 覆盖面（如实记账）：本仿真只注同步 fs——链上前奏/整扫/逐章机检全走同步 fs；rebuild 的
 * worker 档在另一线程上下文，注入不可达（其路数由 rebuild-worker-effect.test.ts 的注入
 * 桩锁，单章链侧由 check-chain-source-probe-ttl.test.ts 的 runRebuildAsync 桩计数锁）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SIM = vi.hoisted(() => ({ delayMs: 1, readdir: 0, stat: 0, readFile: 0 }))

/** 履历引文：故意不写进任何正文 → 每条履历产一条 lead-evidence-miss 红（核验真的逐条跑）。 */
const EVIDENCE = '密室尽头的青铜灯'

/** 墙钟阻塞（自旋卡时）：见头注——Atomics.wait 在 win 被计时器粒度抬到 ~15ms。 */
function blockMs(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    /* 模拟盘等待：本线程确实在等（真慢盘上同样是这个线程在等） */
  }
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const source = actual as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...source }
  const wrapped: Record<string, keyof typeof SIM> = {
    readdirSync: 'readdir',
    statSync: 'stat',
    readFileSync: 'readFile',
  }
  for (const [name, counter] of Object.entries(wrapped)) {
    const orig = source[name]
    if (typeof orig !== 'function') continue
    out[name] = (...args: unknown[]): unknown => {
      SIM[counter]++
      if (SIM.delayMs > 0) blockMs(SIM.delayMs)
      return (orig as (...a: unknown[]) => unknown)(...args)
    }
  }
  return out as unknown as typeof actual
})

import {
  collectTreeIssues,
  collectTreeIssuesAsync,
  openCheckDb,
  runCheckForDocument,
  runCheckForDocumentAsync,
  __setOpenCheckDbAsyncForTest,
  __setOpenCheckDbTtlForTest,
  __resetRebuildDoneAtForTest,
  type CheckOutcome,
} from '../../src/check/run.js'
import { preludeYieldStats, __resetPreludeYieldStatsForTest } from '../../src/shared/yield-stats.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造书：布线喂养到 wiringCount 条（前奏段重）+ chapterCount 章正文（含禁词「玉佩」）。
 *  leads.enabled 置「悬念」——rebuild 只扫已启用类（rebuild.ts:393），不启用则账本整段
 *  不进 rebuild（重前奏夹具就白造了：rebuild 块小到量不出来）。
 *  opts（全部缺省 = 批 1 各场景的原始夹具，逐字节不变）：historyEntries = 首条账本喂多少
 *  条履历（单章链场景用：履历段是刀 2 的切片目标之一；引文故意不进正文 → 逐条产红项，
 *  核验真的逐条跑）；outlineCount = 大纲/章纲 份数（单章链的章纲整扫段输入）。 */
function makeBook(
  wiringCount: number,
  chapterCount: number,
  opts: { historyEntries?: number; outlineCount?: number } = {},
): string {
  const { historyEntries = 0, outlineCount = 0 } = opts
  const root = mkdtempTracked(join(tmpdir(), 'slow-fs-sim-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: [悬念]\n',
    'utf-8',
  )
  const history =
    historyEntries > 0
      ? Array.from({ length: historyEntries }, () => `- 第1章 埋下：「${EVIDENCE}」`).join('\n') + '\n'
      : ''
  for (let i = 1; i <= wiringCount; i++) {
    const no = String(i).padStart(3, '0')
    // 履历只喂首条账本（其余留空）：单章链履历段的输入集中一处，条目数 = historyEntries
    writeFileSync(
      join(root, '布线', '悬念', `悬念-${no}-线索${no}.md`),
      `---\n编号: 悬念-${no}\n标题: 线索${no}\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n${i === 1 ? history : ''}`,
      'utf-8',
    )
  }
  for (let no = 1; no <= outlineCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '大纲', '章纲', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n字数目标: 3000\n---\n\n章纲 ${no}。\n`,
      'utf-8',
    )
  }
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, {
      id: generateDocId(),
      nodeType: 'document',
      path: `写作/正文/${pad}-第${no}章.md`,
      parentId: null,
    })
  }
  writeManifest(manifestPath, m)
  return root
}

interface ProbeResult {
  maxGapMs: number
  beats: number
}

/** 自续期 setImmediate 探针：记录最长相邻间隔（= 最长同步段）与心跳次数；
 *  间隔超阈值时打印当时的段计数快照（定位停顿落在哪一段）。见头注「探针尾段纪律」。 */
function startPauseProbe(label: string): { stop(): ProbeResult } {
  let last = Date.now()
  let maxGapMs = 0
  let beats = 0
  let stopped = false
  const tick = (): void => {
    if (stopped) return
    const now = Date.now()
    const gap = now - last
    if (gap > maxGapMs) maxGapMs = gap
    if (gap >= 100) console.log(`[slow-fs-sim] ${label} gap ${gap}ms 段计数 ${JSON.stringify(preludeYieldStats)}`)
    last = now
    beats++
    setImmediate(tick)
  }
  setImmediate(tick)
  return {
    stop(): ProbeResult {
      stopped = true
      return { maxGapMs, beats }
    },
  }
}

/** 驱动结束后让出一拍再停探针：见头注「探针尾段纪律」。 */
async function settleProbe(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
}

/** 去绝对路径的结果面：单章链两档各造同形书（临时目录名不同），只比内容不比路径。 */
function normOutcome(o: CheckOutcome): unknown {
  if (!o.ok) return o
  const { _path: _ignored, ...chapterRest } = o.chapter
  return { ...o, chapter: chapterRest }
}

const counters = (): [number, number, number] => [SIM.readdir, SIM.stat, SIM.readFile]

afterEach(() => {
  __setOpenCheckDbAsyncForTest(null)
  __setOpenCheckDbTtlForTest(null)
  __resetRebuildDoneAtForTest()
})

describe('慢盘仿真：前奏段停顿与存活（收口证据）', () => {
  it('① 同执行档切片对比 + ② 真 worker 档：同步长段 → 只剩 rebuild 块 → 大块消失', async () => {
    // 前奏段单独的书：重布线（喂 fp walk 与 rebuild）+ 零章（逐章残余为空，度量只反映前奏）
    // ① 单变量对比：注入桩让 async 档也走同步 openCheckDb——唯一差异 = 让出点
    __setOpenCheckDbAsyncForTest(async (eff) => openCheckDb(eff.bookRoot, eff.hasWiring, eff.opts))

    const rootSync = makeBook(80, 0)
    __resetPreludeYieldStatsForTest()
    const c0 = counters()
    const t0 = Date.now()
    const sync = collectTreeIssues(rootSync, () => undefined)
    const syncMs = Date.now() - t0
    const syncCalls = counters().map((v, i) => v - c0[i]!)
    expect(sync.rebuildFailed).toBe(false)

    const rootStub = makeBook(80, 0)
    __resetPreludeYieldStatsForTest()
    const stubProbe = startPauseProbe('① async(同档)')
    const c1 = counters()
    const t1 = Date.now()
    const stubResult = await collectTreeIssuesAsync(rootStub, () => undefined)
    await settleProbe()
    const stubMs = Date.now() - t1
    const stubProbeResult = stubProbe.stop()
    const stubCalls = counters().map((v, i) => v - c1[i]!)

    expect(stubProbeResult.beats).toBeGreaterThan(0) // 存活
    expect(stubResult.rebuildFailed).toBe(false)
    // 同态自检：同形书上两档 fs 调用规模应逐数一致（缓存态、执行档都相同）
    expect(stubCalls).toEqual(syncCalls)

    // ② 真 worker 档：rebuild 出主线程（① 的剩余大块正是它）
    __setOpenCheckDbAsyncForTest(null)
    const rootReal = makeBook(80, 0)
    __resetPreludeYieldStatsForTest()
    const realProbe = startPauseProbe('② async(worker)')
    const t2 = Date.now()
    const realResult = await collectTreeIssuesAsync(rootReal, () => undefined)
    await settleProbe()
    const realMs = Date.now() - t2
    const realProbeResult = realProbe.stop()
    expect(realResult.rebuildFailed).toBe(false)
    expect(realResult.issues).toEqual({})
    expect(realProbeResult.beats).toBeGreaterThan(0)

    console.log(
      `[slow-fs-sim] 前奏段单独（重布线 80 条 + 零章，注入 ${SIM.delayMs}ms/次）：\n` +
        `  ① 同执行档：同步 总时长 ${syncMs}ms（= 最长单次停顿，全程无让出） vs async 总时长 ${stubMs}ms / 最长单次停顿 ${stubProbeResult.maxGapMs}ms\n` +
        `  ② 真 worker 档：async 总时长 ${realMs}ms / 最长单次停顿 ${realProbeResult.maxGapMs}ms / 心跳 ${realProbeResult.beats}\n` +
        `  fs 调用数（readdir/stat/readFile）同步 [${syncCalls.join('/')}] 同档 async [${stubCalls.join('/')}]`,
    )
  }, 90_000)

  it('③ 真实混合书（重布线 + 5 章）：真 worker 档度量 + 结果等价（残余如实留档）', async () => {
    const root = makeBook(80, 5)
    __resetPreludeYieldStatsForTest()
    const probe = startPauseProbe('③ async(worker,混合)')
    const t0 = Date.now()
    const r = await collectTreeIssuesAsync(root, () => undefined)
    await settleProbe()
    const ms = Date.now() - t0
    const probeResult = probe.stop()

    expect(Object.keys(r.issues).length).toBe(5) // 5 章各命中禁词「玉佩」
    expect(probeResult.beats).toBeGreaterThan(0) // 存活
    expect(collectTreeIssues(root, () => undefined)).toEqual(r) // 函数等价

    console.log(
      `[slow-fs-sim] 真实混合书（重布线 + 5 章）：async(worker) 总时长 ${ms}ms / 最长单次停顿 ${probeResult.maxGapMs}ms / 心跳 ${probeResult.beats}\n` +
        `  （残余 = 逐章机检段 25 章粒度 + 单文件/单句柄 D4 残余——刀 2 面，非同批切片目标）`,
    )
  }, 90_000)

  it('④ 单章链：runCheckForDocument 一条长段 vs Async（worker + 分段让出）停顿塌落 + 结果等价', async () => {
    // 夹具：重布线 40 + 30 章正文 + 60 章纲 + 30 条履历（链上四类段都喂到让出阈值以上：
    // 正文整扫（含 maxWrittenChapterOf 的未来章基准现扫）/章纲整扫/章目建表/履历逐条核验）
    const rootSync = makeBook(40, 30, { historyEntries: 30, outlineCount: 60 })
    const draftSync = join(rootSync, '写作', '正文', '001-第1章.md')
    __resetPreludeYieldStatsForTest()
    const c0 = counters()
    const t0 = Date.now()
    const sync = runCheckForDocument(rootSync, draftSync, null)
    const syncMs = Date.now() - t0
    const syncCalls = counters().map((v, i) => v - c0[i]!)
    expect(sync.ok).toBe(true)

    const rootAsync = makeBook(40, 30, { historyEntries: 30, outlineCount: 60 })
    const draftAsync = join(rootAsync, '写作', '正文', '001-第1章.md')
    __resetPreludeYieldStatsForTest()
    const probe = startPauseProbe('④ async(单章链)')
    const t1 = Date.now()
    const asyncOutcome = await runCheckForDocumentAsync(rootAsync, draftAsync, null)
    await settleProbe()
    const asyncMs = Date.now() - t1
    const probeResult = probe.stop()
    const asyncCalls = counters().map((v, i) => v - c0[i]! - syncCalls[i]!)

    expect(probeResult.beats).toBeGreaterThan(0) // 存活
    expect(normOutcome(asyncOutcome)).toEqual(normOutcome(sync)) // 结果等价（切片只改悬停点）
    // 注：两档 fs 调用数**不应**相等——async 档的 rebuild 在 worker 线程，本进程注入
    // 打不到（这正是「搬出主线程」的证据面之一），故此处只留档不比较。

    // 热态复跑（同书第二遍，窗关掉以保持「照常重建」的单变量）：余下那段停顿若主要来自
    // 冷缓存首扫（布线派生词表/名册/铁律等单文件与小目录读），热态应显著回落——本条即
    // 「残余归因」的证据锚，不作为门槛断言。
    __resetRebuildDoneAtForTest()
    __setOpenCheckDbTtlForTest(0)
    const warmProbe = startPauseProbe('④ async(单章链,热)')
    const t2 = Date.now()
    const warmOutcome = await runCheckForDocumentAsync(rootAsync, draftAsync, null)
    await settleProbe()
    const warmMs = Date.now() - t2
    const warmProbeResult = warmProbe.stop()
    expect(normOutcome(warmOutcome)).toEqual(normOutcome(sync))

    console.log(
      `[slow-fs-sim] 单章链（重布线 40 + 30 章 + 60 章纲 + 30 条履历，注入 ${SIM.delayMs}ms/次）：\n` +
        `  ④ 同步 总时长 ${syncMs}ms（= 最长单次停顿，全程无让出） vs async(worker) 总时长 ${asyncMs}ms / 最长单次停顿 ${probeResult.maxGapMs}ms / 心跳 ${probeResult.beats}\n` +
        `     热态复跑（同书第二遍）：总时长 ${warmMs}ms / 最长单次停顿 ${warmProbeResult.maxGapMs}ms（残余归因锚：冷缓存首扫段）\n` +
        `  fs 调用数（readdir/stat/readFile）同步 [${syncCalls.join('/')}] async(worker) [${asyncCalls.join('/')}]（不同档：rebuild 走 worker，注入不可达）`,
    )
  }, 90_000)
})
