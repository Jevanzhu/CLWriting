/**
 * 阶段 52 批 2（P3-13）S5：worker 档的 R47-11 节流承接（设计 §1.4-2 备选 (a)）验收。
 *
 * 背景：R47-11 的 3s 探测节流状态（cache/rebuild.ts 模块内存表）在 worker 档随新线程失效
 * ——承接法 = 主线程自记「最近一次 async 重建完成时刻」，窗内跳重建只开库。本套锁四件事：
 * ① 窗内真的跳（`runRebuildAsync` 桩零增量调用）且结果面不变（与同步基准 deep equal）；
 * ② 窗外照常重建（桩每次调用 +1）；
 * ③ 库不在盘时窗内也重建（自愈面不被节流吃掉——窗只是省一次重建，不是省掉建库）；
 * ④ 非节流档（树聚合 throttleSourceProbe=false）永不入窗（两窗口径互不干扰）。
 *
 * 桩手法：mock `cache/run-rebuild-async.js` 计数并委托同步 `rebuild`（同一内核、同一 db
 * 结果）——本套比的是「窗语义」，不是 worker 线程本身（线程路数由批 1 的
 * rebuild-worker-effect.test.ts 与 check-chain-async-parity.test.ts 把守）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REBUILD = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../../src/cache/run-rebuild-async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cache/run-rebuild-async.js')>()
  const { rebuild } = await import('../../src/cache/rebuild.js')
  return {
    ...actual,
    runRebuildAsync: async (job: Parameters<typeof actual.runRebuildAsync>[0]) => {
      REBUILD.calls++
      return rebuild(job.bookRoot, job.cachePath, job.opts)
    },
  }
})

import {
  runCheckForDocument,
  runCheckForDocumentAsync,
  openCheckDbAsync,
  __setOpenCheckDbTtlForTest,
  __resetRebuildDoneAtForTest,
} from '../../src/check/run.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造书：3 章正文（含禁词「玉佩」）+ 1 条悬念账本（引文不进正文 → 全书性红项）。 */
function makeBook(short = false): string {
  const root = mkdtempTracked(join(tmpdir(), 'chain-ttl-'))
  mkdirSync(join(root, '文风'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    `spec_version: 1\nkind: ${short ? 'short' : 'long'}\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n`,
    'utf-8',
  )
  if (!short) {
    mkdirSync(join(root, '布线', '悬念'), { recursive: true })
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-密室之主.md'),
      '---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第1章 埋下：「密室尽头的青铜灯」\n',
      'utf-8',
    )
  }
  for (let no = 1; no <= 3; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n`,
      'utf-8',
    )
  }
  return root
}

const draftOf = (root: string): string => join(root, '写作', '正文', '001-第1章.md')
const dbPathOf = (root: string): string => join(root, '.cache', 'index.db')

beforeEach(() => {
  REBUILD.calls = 0
  __resetRebuildDoneAtForTest()
  __setOpenCheckDbTtlForTest(null) // 生产窗宽（SOURCE_PROBE_TTL_MS 同源值）
})

afterEach(() => __setOpenCheckDbTtlForTest(null))

describe('worker 档 TTL 承接（备选 (a)）', () => {
  it('窗内：第二次调用跳重建（桩不增）且结果面不变', async () => {
    const root = makeBook()
    const first = await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(REBUILD.calls).toBe(1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.report.sections.flatMap((s) => s.items).map((i) => i.checkId)).toContain('banned-word')

    const second = await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(REBUILD.calls).toBe(1) // 窗内跳重建：桩零增量调用
    expect(second).toEqual(first) // 跳重建不改结果面

    // 同步基准同书同稿：窗内结果与「每次都重建」的同步档逐位一致
    const baseline = runCheckForDocument(root, draftOf(root), null)
    expect(second).toEqual(baseline)
  })

  it('窗外（TTL=0）：每次调用都重建，结果仍与同步基准等价', async () => {
    const root = makeBook()
    __setOpenCheckDbTtlForTest(0)
    const first = await runCheckForDocumentAsync(root, draftOf(root), null)
    const second = await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(REBUILD.calls).toBe(2)
    expect(second).toEqual(first)
    expect(second).toEqual(runCheckForDocument(root, draftOf(root), null))
  })

  it('窗内库不在盘：走重建自愈（窗不吞建库）', async () => {
    const root = makeBook()
    await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(REBUILD.calls).toBe(1)
    rmSync(dbPathOf(root), { force: true })
    const again = await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(REBUILD.calls).toBe(2) // existsSync 守卫：库缺 → 不跳，重建自愈
    expect(again.ok).toBe(true)
  })

  it('非节流档（树聚合口径）：窗内同样重建——两窗口径互不干扰', async () => {
    const root = makeBook()
    const opts = { throttleSourceProbe: false, failMode: 'fail-open' as const }
    const one = await openCheckDbAsync(root, true, opts)
    const two = await openCheckDbAsync(root, true, opts)
    expect(REBUILD.calls).toBe(2) // 树聚合不节流：不入窗
    expect(one.db).not.toBeNull()
    expect(two.db).not.toBeNull()
    one.db?.close()
    two.db?.close()
  })

  it('无布线短篇：不重建（桩零调用）且机检照跑', async () => {
    const root = makeBook(true)
    const outcome = await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(REBUILD.calls).toBe(0)
    expect(outcome.ok).toBe(true)
  })
})
