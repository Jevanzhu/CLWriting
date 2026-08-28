/**
 * 书级设定全局托底单测：readGlobalBookDefaults 四重容错 + 逐键校验，
 * applyGlobalDefaults 的「书级优先 → global → 硬编码回落」合并语义。
 */
import { test, expect } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GLOBAL_FALLBACK_DEFAULTS,
  readGlobalBookDefaults,
  applyGlobalDefaults,
} from '../../src/format/global-defaults.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function mkUserData(): string {
  return mkdtempTracked(join(tmpdir(), 'clwriting-global-'))
}

function writeGlobal(userDataPath: string, json: unknown): void {
  writeFileSync(join(userDataPath, 'global.json'), JSON.stringify(json), 'utf-8')
}

/** 未设任何 13 键的裸书配置（新 scaffold 产物形态） */
function bareConfig(): BookConfig {
  return structuredClone(DEFAULT_CONFIG)
}

// ── readGlobalBookDefaults：四重容错 + 逐键校验 ──────────────

test('readGlobalBookDefaults: userDataPath 为 null → 空（目录未定位）', () => {
  expect(readGlobalBookDefaults(null)).toEqual({})
})

test('readGlobalBookDefaults: 目录存在但无 global.json → 空（文件不存在）', () => {
  const ud = mkUserData()
  expect(readGlobalBookDefaults(ud)).toEqual({})
  rmSync(ud, { recursive: true, force: true })
})

test('readGlobalBookDefaults: JSON 损坏 → 空（不抛错）', () => {
  const ud = mkUserData()
  writeFileSync(join(ud, 'global.json'), '{oops', 'utf-8')
  expect(readGlobalBookDefaults(ud)).toEqual({})
  rmSync(ud, { recursive: true, force: true })
})

test('readGlobalBookDefaults: 逐键校验——非法值剔除、合法键保留、单键坏不拖垮其余', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    defaultGenre: '玄幻',
    defaultVolumeSize: 30,
    defaultShortStrict: 'yes', // boolean 期望 → 剔除
    styleInjection: 'medium', // 枚举外 → 剔除
    autoBatchSize: 0, // 越下界 → 剔除
    callsPerChapter: 51, // 越上界 → 剔除
    relationMineThreshold: 21, // 越上界 → 剔除
    ragProvider: '', // 空串 → 剔除
    defaultTargetWords: -5, // 非正整数 → 剔除
    defaultChapterTargetWords: 1.5, // 非整数 → 剔除
    relationAutoMine: 1, // 非 boolean → 剔除
    ragEnabled: 'true', // 非 boolean → 剔除
    autoConfirmOutline: true, // 合法键夹在坏键之间——不应被连坐
  })
  expect(readGlobalBookDefaults(ud)).toEqual({
    defaultGenre: '玄幻',
    defaultVolumeSize: 30,
    autoConfirmOutline: true,
  })
  rmSync(ud, { recursive: true, force: true })
})

test('readGlobalBookDefaults: 合法全景含边界值（5/1-20/1-50 的上下界）', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    defaultGenre: '玄幻',
    defaultVolumeSize: 5, // 下边界
    defaultTargetWords: 2000000,
    defaultChapterTargetWords: 2500,
    defaultShortStrict: true,
    styleInjection: 'heavy',
    autoConfirmOutline: true,
    autoBatchSize: 20, // 上边界
    callsPerChapter: 50, // 上边界
    relationAutoMine: true,
    relationMineThreshold: 20, // 上边界
    ragEnabled: true,
    ragProvider: 'rag-abc',
  })
  expect(readGlobalBookDefaults(ud)).toEqual({
    defaultGenre: '玄幻',
    defaultVolumeSize: 5,
    defaultTargetWords: 2000000,
    defaultChapterTargetWords: 2500,
    defaultShortStrict: true,
    styleInjection: 'heavy',
    autoConfirmOutline: true,
    autoBatchSize: 20,
    callsPerChapter: 50,
    relationAutoMine: true,
    relationMineThreshold: 20,
    ragEnabled: true,
    ragProvider: 'rag-abc',
  })
  rmSync(ud, { recursive: true, force: true })
})

// ── GLOBAL_FALLBACK_DEFAULTS：硬编码回落值 ──────────────

test('GLOBAL_FALLBACK_DEFAULTS: 契约值 + 三键不回落（不在对象里）', () => {
  expect(GLOBAL_FALLBACK_DEFAULTS).toEqual({
    defaultGenre: '',
    defaultVolumeSize: 50,
    defaultShortStrict: false,
    styleInjection: 'light',
    autoConfirmOutline: false,
    autoBatchSize: 8,
    callsPerChapter: 8,
    relationAutoMine: false,
    relationMineThreshold: 3,
    ragEnabled: false,
  })
  // defaultTargetWords / defaultChapterTargetWords / ragProvider 刻意无回落
  expect('defaultTargetWords' in GLOBAL_FALLBACK_DEFAULTS).toBe(false)
  expect('defaultChapterTargetWords' in GLOBAL_FALLBACK_DEFAULTS).toBe(false)
  expect('ragProvider' in GLOBAL_FALLBACK_DEFAULTS).toBe(false)
})

// ── applyGlobalDefaults：三层合并语义 ──────────────

test('applyGlobalDefaults: 全未设 + 无 global.json → 硬编码回落值（genre 归一空串）', () => {
  const cfg = bareConfig()
  const eff = applyGlobalDefaults(cfg, null)
  expect(eff.book.genre).toBe('')
  expect(eff.book.volume_size).toBe(50)
  expect(eff.book.target_words).toBeUndefined() // 无回落键
  expect(eff.book.chapter_target_words).toBeUndefined()
  expect(eff.budget.calls_per_chapter).toBe(8)
  expect(eff.style.injection).toBe('light')
  expect(eff.auto.confirm_outline).toBe(false)
  expect(eff.auto.batch_size).toBe(8)
  expect(eff.auto.relation_auto_mine).toBe(false)
  expect(eff.auto.relation_mine_threshold).toBe(3)
  expect(eff.rag?.enabled).toBe(false)
})

test('applyGlobalDefaults: global 有值 → 未设键用 global（global 覆盖硬编码）', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    defaultGenre: '悬疑',
    defaultVolumeSize: 30,
    defaultTargetWords: 1200000,
    defaultChapterTargetWords: 2200,
    defaultShortStrict: true,
    styleInjection: 'heavy',
    autoConfirmOutline: true,
    autoBatchSize: 4,
    callsPerChapter: 12,
    relationAutoMine: true,
    relationMineThreshold: 6,
    ragEnabled: true,
    ragProvider: 'rag-xyz',
  })
  const eff = applyGlobalDefaults(bareConfig(), ud)
  expect(eff.book.genre).toBe('悬疑')
  expect(eff.book.volume_size).toBe(30)
  expect(eff.book.target_words).toBe(1200000)
  expect(eff.book.chapter_target_words).toBe(2200)
  expect(eff.budget.calls_per_chapter).toBe(12)
  expect(eff.style.injection).toBe('heavy')
  expect(eff.auto.confirm_outline).toBe(true)
  expect(eff.auto.batch_size).toBe(4)
  expect(eff.auto.relation_auto_mine).toBe(true)
  expect(eff.auto.relation_mine_threshold).toBe(6)
  expect(eff.rag?.enabled).toBe(true)
  expect(eff.rag?.provider).toBe('rag-xyz')
  // short 段存在时 strict 也回落 global
  const withShort = applyGlobalDefaults({ ...bareConfig(), short: { word_min: 8000 } }, ud)
  expect(withShort.short?.strict).toBe(true)
  rmSync(ud, { recursive: true, force: true })
})

test('applyGlobalDefaults: 书级优先——已设键不被 global/fallback 翻案', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    defaultGenre: '悬疑',
    defaultVolumeSize: 30,
    defaultTargetWords: 1200000,
    styleInjection: 'heavy',
    autoBatchSize: 4,
    callsPerChapter: 12,
    ragEnabled: true,
    ragProvider: 'rag-global',
  })
  const cfg: BookConfig = {
    ...bareConfig(),
    book: { title: '书名', genre: '玄幻', volume_size: 40, target_words: 888888 },
    budget: { ...bareConfig().budget, calls_per_chapter: 6 },
    style: { injection: 'light' },
    auto: { batch_size: 1, relation_mine_threshold: 9 },
    rag: { enabled: false, provider: 'rag-book' },
  }
  const eff = applyGlobalDefaults(cfg, ud)
  expect(eff.book.genre).toBe('玄幻') // 书级覆盖 global
  expect(eff.book.volume_size).toBe(40)
  expect(eff.book.target_words).toBe(888888)
  // budget.calls_per_chapter（2026-08-19 起全局固定）：书级旧值 6 被忽略，只认全局 12
  expect(eff.budget.calls_per_chapter).toBe(12)
  // 文风注入（2026-08-19 起不参与书级覆盖）：书级 style.injection 被忽略，只认全局 heavy
  expect(eff.style.injection).toBe('heavy')
  // auto.batch_size（2026-08-19 起全局固定）：书级旧值 1 被忽略，只认全局 4
  expect(eff.auto.batch_size).toBe(4)
  // 关系图阈值仍保留书级覆盖：书级 9 赢过 global（global 无此键 → fallback 3）
  expect(eff.auto.relation_mine_threshold).toBe(9)
  expect(eff.auto.confirm_outline).toBe(false) // 全局无此键 → fallback
  expect(eff.auto.relation_auto_mine).toBe(false)
  // rag：书级显式关闭赢过 global ragEnabled；书级 provider 赢过 global provider
  expect(eff.rag?.enabled).toBe(false)
  expect(eff.rag?.provider).toBe('rag-book')
  rmSync(ud, { recursive: true, force: true })
})

test('applyGlobalDefaults: rag provider 书级未设时回落 global（无硬编码回落）', () => {
  const ud = mkUserData()
  writeGlobal(ud, { ragProvider: 'rag-global' })
  // 书里无 rag 段：enabled 回落 fallback false，provider 用 global
  const eff = applyGlobalDefaults(bareConfig(), ud)
  expect(eff.rag?.enabled).toBe(false)
  expect(eff.rag?.provider).toBe('rag-global')
  // 无 global.json：provider 保持缺省（不回落）
  const eff2 = applyGlobalDefaults({ ...bareConfig(), rag: { enabled: true } }, null)
  expect(eff2.rag?.provider).toBeUndefined()
  rmSync(ud, { recursive: true, force: true })
})

test('applyGlobalDefaults: 损坏 global.json 容错为全空（回落硬编码）', () => {
  const ud = mkUserData()
  writeFileSync(join(ud, 'global.json'), 'not-json', 'utf-8')
  const eff = applyGlobalDefaults(bareConfig(), ud)
  expect(eff.book.genre).toBe('')
  expect(eff.book.volume_size).toBe(50)
  expect(eff.budget.calls_per_chapter).toBe(8)
  rmSync(ud, { recursive: true, force: true })
})

test('applyGlobalDefaults: 就地 mutate 入参并返回同引用（运行时副本语义）', () => {
  const cfg = bareConfig()
  const eff = applyGlobalDefaults(cfg, null)
  expect(eff).toBe(cfg) // 同一对象——调用方拿返回值拿到的就是合并后的副本本身
  expect(cfg.budget.calls_per_chapter).toBe(8)
})
