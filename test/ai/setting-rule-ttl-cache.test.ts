/**
 * R36-12（三十六轮批 D）：setting-rule 设定目录 TTL 缓存回归。
 *
 * 机理：settingConsistencyRule 挂在 AI 热路径（self-heal/spawn-write/rewrite 每章
 * 反复 toPrompt/check），此前每次全量 readdirSync+readFileSync 读设定目录。修复后
 * 书键 Map + TTL（缺省 5s）+ 目录 mtime 结构探针缓存（手法对齐 R35-7 search）；
 * 名册.md 内容改写不触碰目录 mtime，经单独文件 mtime 探针即时失效——规则变更后
 * 不缓存陈旧。
 *
 * 覆盖：
 * - 两次读取第二次命中缓存（底层读目录计数不增，结果一致）
 * - 目录结构变更（新增角色卡/物品卡）→ 探针失效重读，新数据可见
 * - 名册内容改写（目录 mtime 不动）→ 文件 mtime 探针失效重读，新数据可见
 * - TTL 过期 → 重读；forgetSettingCache → 立即失效；不同书库互不串
 *
 * P3-5 确定性化：mtime 沉淀用 sleep(20) 实睡改 utimesSync 钉 mtime（探针信号
 * 确定性——签名只比 mtimeMs 字符串，钉固定时点后与真实调度/卷精度无关）；TTL 过期
 * 臂改 vi 假时钟 advanceTimersByTime（TTL 判定走 Date.now，缓存链无定时器消费）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  settingConsistencyRule,
  __setSettingCacheTtlForTest,
  __settingLoadCountForTest,
  __resetSettingLoadCountForTest,
  forgetSettingCache,
} from '../../src/ai/rules/setting-rule.js'

/** 探针钉点：签名路径（设定目录/角色/物品/名册.md）mtime 钉到 T1/T2 两个固定时点 */
const T1 = 1_000_000_000_000
const T2 = T1 + 60_000

/** 造设定目录：角色卡(姓名 林远) + 名册.md(A 版内容)。返回 bookRoot。 */
function makeSettingBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'clwriting-r36-12-setting-'))
  const roleDir = join(root, '设定', '角色')
  mkdirSync(roleDir, { recursive: true })
  writeFileSync(join(roleDir, '角色-001.md'), '---\n姓名: 林远\n---\n角色正文', 'utf-8')
  writeFileSync(join(root, '设定', '名册.md'), '阿黄\n', 'utf-8')
  return root
}

/** 初载前钉 mtime：设定/角色/名册 → T1（物品目录不存在，签名记 '-'） */
function pinMtimesT1(root: string): void {
  const t = new Date(T1)
  utimesSync(join(root, '设定'), t, t)
  utimesSync(join(root, '设定', '角色'), t, t)
  utimesSync(join(root, '设定', '名册.md'), t, t)
}

let roots: string[] = []

beforeEach(() => {
  __resetSettingLoadCountForTest()
})

afterEach(() => {
  __setSettingCacheTtlForTest(null)
  __resetSettingLoadCountForTest()
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  roots = []
})

describe('R36-12 setting-rule TTL 缓存', () => {
  it('两次读取第二次命中缓存：底层读目录计数不增，结果一致', () => {
    const root = makeSettingBook()
    roots.push(root)
    expect(settingConsistencyRule.toPrompt({ bookRoot: root })).toContain('设定一致')
    expect(__settingLoadCountForTest()).toBe(1)
    // check 与 toPrompt 共用同一缓存（不再全量重读）
    expect(settingConsistencyRule.check('「林远」走了过来', { bookRoot: root })).toEqual([])
    expect(settingConsistencyRule.toPrompt({ bookRoot: root })).toContain('设定一致')
    expect(__settingLoadCountForTest()).toBe(1)
  })

  it('目录结构变更（新增物品卡）→ mtime 探针失效重读，新名称可见（不缓存陈旧）', () => {
    const root = makeSettingBook()
    roots.push(root)
    pinMtimesT1(root)
    // 初载：「玄铁」未登记 → 报黄
    expect(
      settingConsistencyRule.check('「玄铁」现身', { bookRoot: root }).some((v) => v.message.includes('玄铁')),
    ).toBe(true)
    expect(__settingLoadCountForTest()).toBe(1)

    mkdirSync(join(root, '设定', '物品'), { recursive: true })
    writeFileSync(join(root, '设定', '物品', '物品-001.md'), '---\n名称: 玄铁\n---\n物品正文', 'utf-8')
    // 结构变更臂：设定目录 + 物品目录 mtime 钉到 T2（≠T1，探针必翻转）
    const t2 = new Date(T2)
    utimesSync(join(root, '设定'), t2, t2)
    utimesSync(join(root, '设定', '物品'), t2, t2)
    // 修复前：缓存/无缓存但陈旧——重读后「玄铁」已登记 → 不再报
    expect(
      settingConsistencyRule.check('「玄铁」现身', { bookRoot: root }).some((v) => v.message.includes('玄铁')),
    ).toBe(false)
    expect(__settingLoadCountForTest()).toBe(2) // 结构变更触发失效重读
  })

  it('名册内容改写（不触碰目录 mtime）→ 文件 mtime 探针失效重读，新内容可见', () => {
    const root = makeSettingBook()
    roots.push(root)
    pinMtimesT1(root)
    // 初载：名册 A 版含「阿黄」，不含「阿花」
    expect(
      settingConsistencyRule.check('「阿黄」在旁', { bookRoot: root }).some((v) => v.message.includes('阿黄')),
    ).toBe(false)
    expect(
      settingConsistencyRule.check('「阿花」在旁', { bookRoot: root }).some((v) => v.message.includes('阿花')),
    ).toBe(true)
    expect(__settingLoadCountForTest()).toBe(1)

    // 只改内容不改目录条目（名册.md 已存在，writeFileSync 原地覆写——目录 mtime 不动）
    writeFileSync(join(root, '设定', '名册.md'), '阿花\n', 'utf-8')
    // 文件探针臂：仅名册.md mtime 钉到 T2（目录保持 T1——隔离证明失效来自文件探针）
    utimesSync(join(root, '设定', '名册.md'), new Date(T2), new Date(T2))
    expect(
      settingConsistencyRule.check('「阿花」在旁', { bookRoot: root }).some((v) => v.message.includes('阿花')),
    ).toBe(false)
    expect(__settingLoadCountForTest()).toBe(2) // 文件 mtime 探针触发失效（不靠 TTL）
  })

  it('TTL 过期 → 重读（内容未变也重读）', () => {
    const root = makeSettingBook()
    roots.push(root)
    pinMtimesT1(root)
    __setSettingCacheTtlForTest(30)
    // 假时钟：TTL 判定走 Date.now——ts 与过期判定同域，推进 80ms 必越 30ms TTL
    vi.useFakeTimers({ now: new Date() })
    try {
      settingConsistencyRule.toPrompt({ bookRoot: root })
      expect(__settingLoadCountForTest()).toBe(1)
      vi.advanceTimersByTime(80)
      settingConsistencyRule.toPrompt({ bookRoot: root })
      expect(__settingLoadCountForTest()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgetSettingCache → 立即失效（删书/改名挂点同款语义）；不同书库互不串', () => {
    const rootA = makeSettingBook()
    const rootB = makeSettingBook()
    roots.push(rootA, rootB)
    settingConsistencyRule.toPrompt({ bookRoot: rootA })
    settingConsistencyRule.toPrompt({ bookRoot: rootB })
    expect(__settingLoadCountForTest()).toBe(2) // 各自首载

    // forget 只清 A——A 重读，B 仍命中
    forgetSettingCache(rootA)
    settingConsistencyRule.toPrompt({ bookRoot: rootA })
    settingConsistencyRule.toPrompt({ bookRoot: rootB })
    expect(__settingLoadCountForTest()).toBe(3)
  })
})
