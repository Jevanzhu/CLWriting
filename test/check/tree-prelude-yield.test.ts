/**
 * 阶段 52 批 1（P3-12）切片验收：机检聚合「前奏段」让出计数（A2）与前奏段心跳（A3）。
 *
 * 背景：R37-3 的异步孪生把让出点铺在「逐章机检」段（每 25 章一次），而聚合前奏段
 *（纪元指纹递归 walk → rebuild/开库 → 正文目录整扫 → 账本预扫）在慢盘（网络盘/机械盘
 * 冷缓存）上恰是单次请求里最长的一段，其间事件循环零让出——「禁止同步长段」的热路径
 * 纪律在慢盘上被前奏段击穿。本套证明让出真落在三个目标段：心跳只能证明「有让出」，
 * 分不出是哪一段，故用隔离夹具按计数器定位。
 *
 * A2 隔离口径：目标段喂大（N 个 .md 项）、其余段喂小（章数 < TREE_ISSUES_YIELD_EVERY
 * 不触发逐章让出点），断言对应计数器 ≥ ⌊N/K⌋ 且**其余计数器为 0**。
 * A3：前奏重（100 个布线 .md）而章轻（2 章）的书上跑 collectTreeIssuesAsync，心跳至少
 * 插队一次且 dirFp 计数 > 0（让出确由前奏段产生）；同步驱动同夹具下零让出窗口 ⇒ 心跳
 * 恒 0（负对照：证明正例的 beats > 0 不是探针自走）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { yieldToEventLoop } from '../../src/async.js'
import {
  collectTreeIssues,
  collectTreeIssuesAsync,
  scanChapterUpdatesByChapter,
  scanChapterUpdatesByChapterCore,
} from '../../src/check/run.js'
import { computeTreeIssuesGlobalFpCore } from '../../src/check/tree-issues-cache.js'
import { LEAD_UPDATES_ARCHIVE_DIR } from '../../src/check/lead-updates.js'
import { scanChapterDirCore } from '../../src/format/chapters.js'
import { preludeYieldStats, __resetPreludeYieldStatsForTest } from '../../src/shared/yield-stats.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** async 驱动（测试本地复刻生产口径）：每个悬停点 await 让出事件循环。 */
async function driveAsync<T>(it: Generator<unknown, T, unknown>): Promise<T> {
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
    await yieldToEventLoop()
  }
}

/**
 * 造「前奏重、章轻」的书：布线/悬念 下 1 个基础线索 + extraWiring 个额外线索
 *（喂 dirFp 段；每章 25 项的让出点由 chapterCount 控制），chapterCount 章正文
 *（各含禁词「玉佩」→ 树红点确定，证明逐章机检真跑了）。
 * 额外线索文件用与基础线索同形的合法账本（rebuild ingest 零错误——测试 4 走树链，
 * rebuild 报错会降级成 rebuildFailed 使红点为空，断言会假失败）。
 */
function makeBook(extraWiring: number, chapterCount: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'tree-prelude-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  const lead = (id: string, title: string): string =>
    `---\n编号: ${id}\n标题: ${title}\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n`
  writeFileSync(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'), lead('悬念-001', '灭门真凶'), 'utf-8')
  for (let i = 2; i <= extraWiring; i++) {
    const no = String(i).padStart(3, '0')
    writeFileSync(join(root, '布线', '悬念', `悬念-${no}-线索${no}.md`), lead(`悬念-${no}`, `线索${no}`), 'utf-8')
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

beforeEach(() => __resetPreludeYieldStatsForTest())

describe('机检前奏段让出计数（A2，三段隔离夹具）', () => {
  it('纪元指纹段：布线喂 60 项 → dirFp 计数达标，其余段计数为 0', async () => {
    const root = makeBook(60, 2)
    const fp = await driveAsync(computeTreeIssuesGlobalFpCore(root, null))
    expect(fp).toContain(':') // 指纹形态自检（六段 dirFp 拼接）
    expect(preludeYieldStats.dirFp).toBeGreaterThanOrEqual(Math.floor(60 / 25))
    expect(preludeYieldStats.chapterScan).toBe(0)
    expect(preludeYieldStats.leadUpdatesScan).toBe(0)
    expect(preludeYieldStats.leadsBook).toBe(0)
  })

  it('正文目录整扫段：60 章 → chapterScan 计数达标，其余段计数为 0', async () => {
    const root = makeBook(0, 60)
    const r = await driveAsync(scanChapterDirCore(join(root, '写作', '正文')))
    expect(r.chapters).toHaveLength(60)
    expect(preludeYieldStats.chapterScan).toBeGreaterThanOrEqual(Math.floor(60 / 25))
    expect(preludeYieldStats.dirFp).toBe(0)
    expect(preludeYieldStats.leadUpdatesScan).toBe(0)
    expect(preludeYieldStats.leadsBook).toBe(0)
  })

  it('账本预扫段：归档 60 个配对章 → leadUpdatesScan 计数达标，其余段计数为 0', async () => {
    const root = makeBook(0, 2)
    const archiveDir = join(root, LEAD_UPDATES_ARCHIVE_DIR)
    mkdirSync(archiveDir, { recursive: true })
    for (let no = 1; no <= 60; no++) {
      writeFileSync(join(archiveDir, `第${no}章.md`), `- 悬念-001 埋下：「第${no}章的归档推进证据」\n`, 'utf-8')
    }
    const updatesOf = await driveAsync(scanChapterUpdatesByChapterCore(root))
    expect(updatesOf(1).updates).toHaveLength(1) // 配对成功（证明真读到并解析了归档文件）
    expect(preludeYieldStats.leadUpdatesScan).toBeGreaterThanOrEqual(Math.floor(60 / 25))
    expect(preludeYieldStats.dirFp).toBe(0)
    expect(preludeYieldStats.chapterScan).toBe(0)
    expect(preludeYieldStats.leadsBook).toBe(0)
  })

  // 阶段 52 附批（coverage 修账）：同步包装 `scanChapterUpdatesByChapter` 与生成器异步驱动
  // 逐位同结果——设计 §1.2 的「生成器核心 + 同步包装」单源承诺在此钉住（域级阈值门抓到该
  // 包装零覆盖：run-tree-issues 的调用点随批改 `yield*` 核心，包装失去既有消费方）。
  it('账本预扫段：同步包装与生成器异步驱动逐位同结果（单源双驱动）', async () => {
    const root = makeBook(0, 2)
    const archiveDir = join(root, LEAD_UPDATES_ARCHIVE_DIR)
    mkdirSync(archiveDir, { recursive: true })
    for (let no = 1; no <= 3; no++) {
      writeFileSync(join(archiveDir, `第${no}章.md`), `- 悬念-001 埋下：「第${no}章的归档推进证据」\n`, 'utf-8')
    }
    const syncOf = scanChapterUpdatesByChapter(root)
    const asyncOf = await driveAsync(scanChapterUpdatesByChapterCore(root))
    for (const no of [1, 2, 3, 99]) {
      expect(syncOf(no)).toEqual(asyncOf(no))
    }
    expect(syncOf(1).updates).toHaveLength(1) // 非空自证：两侧都不是「都没读到」的等价
  })
})

describe('前奏段心跳（A3）', () => {
  it('前奏重章轻的书：聚合期间 setImmediate 心跳至少插队一次，且让出来自前奏段', async () => {
    const root = makeBook(100, 2)
    let beats = 0
    const probe = (): void => {
      if (beats < 64) {
        beats++
        setImmediate(probe) // 心跳链续期（cap 防挂尾泄漏）
      }
    }
    const p = collectTreeIssuesAsync(root, () => undefined)
    setImmediate(probe) // 首个让出已在纪元指纹段排队：探针须能插到生成器续跑之前
    const r = await p
    expect(Object.keys(r.issues).length).toBe(2) // 两章各命中禁词「玉佩」
    expect(r.rebuildFailed).toBe(false)
    expect(beats).toBeGreaterThan(0) // 「至少一次」：不脆断言次数
    // 2 章 < TREE_ISSUES_YIELD_EVERY(25) ⇒ 逐章段零让出点，本次心跳只可能由前奏段产生
    expect(preludeYieldStats.dirFp).toBeGreaterThan(0)
  })

  it('负对照：同一夹具走同步驱动时心跳恒 0（无 await ⇒ 无插队窗口）', () => {
    const root = makeBook(100, 2)
    let beats = 0
    const probe = (): void => {
      if (beats < 64) {
        beats++
        setImmediate(probe)
      }
    }
    setImmediate(probe)
    const r = collectTreeIssues(root, () => undefined)
    // 同步驱动整体跑在同一个脚本帧内，探针无插队时机——上例 beats > 0 确由让出产生
    expect(beats).toBe(0)
    expect(Object.keys(r.issues).length).toBe(2)
    expect(preludeYieldStats.dirFp).toBeGreaterThan(0) // 计数器照常递增（只增不读口径）
  })
})
