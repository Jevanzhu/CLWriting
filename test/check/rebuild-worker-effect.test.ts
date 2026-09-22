/**
 * 阶段 52 批 1（P3-12）切片验收：rebuild/开库段「效应让出」的 worker 路数（A4）。
 *
 * 背景：前奏段里唯一无法用悬停点切的是 rebuild/开库（块内零悬停，且异步实现要换线程
 * 跑）——核改为 yield 效应对象，两驱动各自解释：同步驱动 `openCheckDb` 现执行现回填
 *（行为与切片前逐位一致），async 驱动 `openCheckDbAsync`（rebuild 内核经 runRebuildAsync
 * 走 worker）。本套不开真 worker（真 worker 在 vitest 下的加载面由 r57/r55 系专测），
 * 按 A4 口径用注入桩断言「async 驱动确实走异步档」。
 *
 * 用例：
 * 1. 路数（A4 主锁）：async 驱动经注入桩恰一次，入参 = 树聚合口径（hasWiring=true /
 *    throttleSourceProbe=false / failMode='fail-open'），且 preludeYieldStats.rebuild
 *    计数递增（效应真执行）。
 * 2. 等价：桩委托同步 openCheckDb（不开 worker 的确定性替身）时，async 版结果与同步版
 *    deep equal——「换执行档不换语义」。
 * 3. 降级分支：桩返回 fail-open 信封（{db:null, rebuildFailed:true}）时 async 版照常
 *    返回、不抛、rebuildFailed 透出（fail-open 不拦树）。
 * 4. 负对照：同步驱动不走异步档（注入桩零调用，仍由 execEffectSync 执行并计数）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectTreeIssues,
  collectTreeIssuesAsync,
  __setOpenCheckDbAsyncForTest,
  openCheckDb,
  type OpenCheckDbOpts,
  type OpenCheckDbResult,
} from '../../src/check/run.js'
import { preludeYieldStats, __resetPreludeYieldStatsForTest } from '../../src/shared/yield-stats.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造书：chapterCount 章正文（banned 时每章含禁词「玉佩」制造确定红源）+ 布线（hasWiring）。 */
function makeBook(chapterCount: number, banned: boolean): string {
  const root = mkdtempTracked(join(tmpdir(), 'rebuild-effect-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    const sep = banned ? '，玉佩，' : '，'
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里${sep}连响了三下。\n`,
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

interface EffectCall {
  bookRoot: string
  hasWiring: boolean
  opts: OpenCheckDbOpts
}

/** 装注入桩：记录调用 + 返回指定结果（缺省委托同步 openCheckDb——不开 worker 的替身）。 */
function installStub(respond?: (call: EffectCall) => OpenCheckDbResult): EffectCall[] {
  const calls: EffectCall[] = []
  __setOpenCheckDbAsyncForTest(async (eff) => {
    calls.push({ bookRoot: eff.bookRoot, hasWiring: eff.hasWiring, opts: eff.opts })
    if (respond) return respond(eff)
    return openCheckDb(eff.bookRoot, eff.hasWiring, eff.opts)
  })
  return calls
}

beforeEach(() => __resetPreludeYieldStatsForTest())
afterEach(() => __setOpenCheckDbAsyncForTest(null))

describe('rebuild/开库段效应让出：async 驱动走 worker 档（A4）', () => {
  it('路数：async 驱动经异步档恰一次，入参为树聚合口径，效应计数递增', async () => {
    const root = makeBook(2, true)
    const calls = installStub()
    const r = await collectTreeIssuesAsync(root, () => undefined)
    expect(Object.keys(r.issues).length).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.bookRoot).toBe(root)
    expect(calls[0]!.hasWiring).toBe(true)
    expect(calls[0]!.opts).toEqual({ throttleSourceProbe: false, failMode: 'fail-open' })
    expect(preludeYieldStats.rebuild).toBe(1)
  })

  it('等价：桩委托同步实现时 async 版结果与同步版 deep equal（同书双跑，冷/热两态）', async () => {
    const root = makeBook(2, true)
    installStub()
    const sync = collectTreeIssues(root, () => undefined) // 同步驱动：execEffectSync，不经注入桩
    const asyncResult = await collectTreeIssuesAsync(root, () => undefined)
    expect(asyncResult).toEqual(sync)
    expect(preludeYieldStats.rebuild).toBe(2) // 两驱动各执行一次效应
  })

  it('降级分支：桩返回 fail-open 信封时 async 版照常返回、不抛、rebuildFailed 透出', async () => {
    const root = makeBook(2, false) // 正文无禁词 → 章作用域无红（db 缺席时树红点为空）
    installStub(() => ({ db: null, rebuildFailed: true }))
    const r = await collectTreeIssuesAsync(root, () => undefined)
    expect(r.rebuildFailed).toBe(true)
    expect(r.issues).toEqual({})
    expect(preludeYieldStats.rebuild).toBe(1)
  })

  it('负对照：同步驱动不经异步档（注入桩零调用，仍由同步效应执行并计数）', () => {
    const root = makeBook(2, true)
    const calls = installStub()
    const r = collectTreeIssues(root, () => undefined)
    expect(Object.keys(r.issues).length).toBe(2)
    expect(calls).toHaveLength(0)
    expect(preludeYieldStats.rebuild).toBe(1)
  })
})
