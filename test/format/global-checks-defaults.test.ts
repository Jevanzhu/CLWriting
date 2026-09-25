/**
 * R52-E-2（五十二轮）回归：机检阈值五键的全局托底——
 * readGlobalBookDefaults 逐键校验（global.json flat 键 checkRepeat* / checkMaxSentenceLen /
 * checkImageryThreshold / checkWordCountTolerance）+ applyGlobalDefaults 合并语义
 * （书级 checks.* 优先 → global 托底 → 引擎默认〔undefined 不强填〕；无硬编码回落）。
 */
import { test, expect } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readGlobalBookDefaults,
  applyGlobalDefaults,
} from '../../src/format/global-defaults.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function mkUserData(): string {
  return mkdtempTracked(join(tmpdir(), 'clwriting-global-checks-'))
}

function writeGlobal(userDataPath: string, json: unknown): void {
  writeFileSync(join(userDataPath, 'global.json'), JSON.stringify(json), 'utf-8')
}

test('readGlobalBookDefaults: 机检五键合法值保留', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    checkRepeatThreshold: 0.2,
    checkRepeatCharsThreshold: 300,
    checkMaxSentenceLen: 80,
    checkImageryThreshold: 5,
    checkWordCountTolerance: 40,
  })
  expect(readGlobalBookDefaults(ud)).toEqual({
    checkRepeatThreshold: 0.2,
    checkRepeatCharsThreshold: 300,
    checkMaxSentenceLen: 80,
    checkImageryThreshold: 5,
    checkWordCountTolerance: 40,
  })
  rmSync(ud, { recursive: true, force: true })
})

test('readGlobalBookDefaults: 机检五键逐键校验——占比限 (0,1]、计数类正整数、容差正数', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    checkRepeatThreshold: 1.5, // 占比 >1 → 剔除（比率口径永不命中的死值）
    checkRepeatThreshold2: 'x', // 未知键不影响（伪键防误删对照）
    checkRepeatCharsThreshold: 0, // 非正数 → 剔除
    checkMaxSentenceLen: 80.5, // 非整数 → 剔除
    checkImageryThreshold: -3, // 负数 → 剔除
    checkWordCountTolerance: '40', // 非数字类型 → 剔除
  })
  const got = readGlobalBookDefaults(ud)
  expect(got.checkRepeatThreshold).toBeUndefined()
  expect(got.checkRepeatCharsThreshold).toBeUndefined()
  expect(got.checkMaxSentenceLen).toBeUndefined()
  expect(got.checkImageryThreshold).toBeUndefined()
  expect(got.checkWordCountTolerance).toBeUndefined()
  rmSync(ud, { recursive: true, force: true })
})

test('applyGlobalDefaults: 书级 checks 全未设 + global 五键 → 托底进 cfg.checks', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    checkRepeatThreshold: 0.25,
    checkRepeatCharsThreshold: 250,
    checkMaxSentenceLen: 90,
    checkImageryThreshold: 6,
    checkWordCountTolerance: 45,
  })
  const eff = applyGlobalDefaults(structuredClone(DEFAULT_CONFIG), ud)
  expect(eff.checks).toEqual({
    repeat_threshold: 0.25,
    repeat_chars_threshold: 250,
    max_sentence_len: 90,
    imagery_threshold: 6,
    word_count_tolerance: 45,
  })
  rmSync(ud, { recursive: true, force: true })
})

test('applyGlobalDefaults: 书级已设键优先，只补未设键（逐键合并非整段翻案）', () => {
  const ud = mkUserData()
  writeGlobal(ud, {
    checkRepeatThreshold: 0.25,
    checkMaxSentenceLen: 90,
  })
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.checks = { imagery_words: ['空气'], max_sentence_len: 70 }
  const eff = applyGlobalDefaults(cfg, ud)
  // 书级显式 max_sentence_len 保留；词表原样保留（不参与托底）；缺的键补 global
  expect(eff.checks).toEqual({
    imagery_words: ['空气'],
    max_sentence_len: 70,
    repeat_threshold: 0.25,
  })
  rmSync(ud, { recursive: true, force: true })
})

test('applyGlobalDefaults: global 未托底且书级未设 → checks 段不凭空造（undefined 落引擎默认）', () => {
  const ud = mkUserData()
  writeGlobal(ud, { defaultGenre: '玄幻' }) // 有 global.json 但无机检键
  const eff = applyGlobalDefaults(structuredClone(DEFAULT_CONFIG), ud)
  expect(eff.checks).toBeUndefined()
  rmSync(ud, { recursive: true, force: true })

  // 连 global.json 都没有 → 同样不造段
  const eff2 = applyGlobalDefaults(structuredClone(DEFAULT_CONFIG), null)
  expect(eff2.checks).toBeUndefined()
})

test('applyGlobalDefaults: global 部分托底 → 书级无 checks 段时补建段只含托底键', () => {
  const ud = mkUserData()
  writeGlobal(ud, { checkImageryThreshold: 8 })
  const eff = applyGlobalDefaults(structuredClone(DEFAULT_CONFIG), ud)
  expect(eff.checks).toEqual({ imagery_threshold: 8 })
  rmSync(ud, { recursive: true, force: true })
})
