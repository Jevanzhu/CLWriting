/**
 * 0918独立重评修复批（D001）回归门：settings / completion-names 缓存壳的 in-flight
 * 去重。
 *
 * 缺陷：两壳创建 options 此前缺 `inFlight: true`，而 getSettingsCachedAsync 注释
 * （R0917-6-P3-1）宣称「并发 MISS 经 in-flight 去重只扫一次」——去重在 ttl-cache.ts
 * 只挂 opts.inFlight 分支生效（同族 search.ts/rhythm.ts/foreshadows.ts 均有），缺项
 * 时并发 MISS 各起一个 job 全量重扫（settings = 全书同步链 + 让出；completion-names
 * = 两目录 fm 读 ×2），宣称与实现相悖。
 *
 * 测试面取舍：settingsLongAsync 是 settings.ts 模块内引用（创建 options 处直接传函数
 * 值），vi.mock 模块自引用不可行、为可 spy 而重构生产行不改（收益低搅动面大）；退而
 * 以既有观测钩子 __settingsScanCountForTest / __completionNamesScanCountForTest 断言
 * 「MISS → 实际计算」计数——并发双调只扫一次即 in-flight 生效的充要观测面（r0912-ds41
 * TTL 门同款钩子）。书根用空临时目录（settings/completion-names 读面对缺失目录全容错：
 * readRealmDoc/readCharacterCards/readLeadDir/readdir 均回空）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSettingsCachedAsync,
  getCompletionNamesCached,
  forgetSettingsCache,
  __settingsScanCountForTest,
  __resetSettingsScanCountForTest,
  __completionNamesScanCountForTest,
  __resetCompletionNamesScanCountForTest,
} from '../../src/studio/server/api/settings.js'

let roots: string[] = []

/** 造空书根（读面全容错，指纹恒「-,-,-,-,-,-」一致——MISS 判定成立且不涉真实扫描面）。 */
function freshBookRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-d001-inflight-'))
  roots.push(d)
  return d
}

beforeEach(() => {
  __resetSettingsScanCountForTest()
  __resetCompletionNamesScanCountForTest()
})

afterEach(() => {
  for (const r of roots) forgetSettingsCache(r) // 双壳同清（books.ts forgetBookKeyedCaches 生产挂点同款）
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
  __resetSettingsScanCountForTest()
  __resetCompletionNamesScanCountForTest()
})

describe('0918独立重评修复批 D001：settings/completion-names 并发 MISS 单飞', () => {
  it('settings：并发两次 getSettingsCachedAsync 只扫一次且结果同源；随后命中不重扫', async () => {
    const root = freshBookRoot()
    const [a, b] = await Promise.all([getSettingsCachedAsync(root), getSettingsCachedAsync(root)])
    expect(__settingsScanCountForTest()).toBe(1) // 修复前 = 2（各起一个 job 全量重扫）
    expect(a).toEqual(b)
    // 落缓存后命中：仍只 1 次扫描（命中不计数，且 in-flight 收尾自清不残留）
    await getSettingsCachedAsync(root)
    expect(__settingsScanCountForTest()).toBe(1)
  })

  it('completion-names：并发两次 getCompletionNamesCached 只扫一次且结果同源', async () => {
    const root = freshBookRoot()
    const [a, b] = await Promise.all([getCompletionNamesCached(root), getCompletionNamesCached(root)])
    expect(__completionNamesScanCountForTest()).toBe(1) // 修复前 = 2
    expect(a).toEqual(b)
    await getCompletionNamesCached(root)
    expect(__completionNamesScanCountForTest()).toBe(1)
  })

  it('去重不跨键：不同书根并发各算各的（in-flight 按键合并，非全局单飞）', async () => {
    const r1 = freshBookRoot()
    const r2 = freshBookRoot()
    await Promise.all([getSettingsCachedAsync(r1), getSettingsCachedAsync(r2)])
    expect(__settingsScanCountForTest()).toBe(2)
    expect(__completionNamesScanCountForTest()).toBe(0) // settings 壳与 completion-names 壳计数互不串
  })

  it('真实读面不回归：有材料的书根并发双调结果完整（角色/物品名单来自真实 fm 读）', async () => {
    const root = freshBookRoot()
    mkdirSync(join(root, '设定', '角色'), { recursive: true })
    mkdirSync(join(root, '设定', '物品'), { recursive: true })
    writeFileSync(
      join(root, '设定', '角色', '林远.md'),
      '---\n姓名: 林远\n身份: 主角\n---\n正文。',
    )
    writeFileSync(
      join(root, '设定', '物品', '红伞.md'),
      '---\n名称: 红伞\n---\n道具。',
    )
    const [a, b] = await Promise.all([getCompletionNamesCached(root), getCompletionNamesCached(root)])
    expect(__completionNamesScanCountForTest()).toBe(1)
    expect(a).toEqual({ characters: ['林远'], items: ['红伞'] })
    expect(b).toEqual(a)
  })
})
