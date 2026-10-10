/**
 * 写稿面方法选材（src/knowledge/select.ts）单测。
 *
 * 锚定四条对外可观察行为：①基础篇按体裁（长篇＝章节钩子速查 / 短篇＝反转设计速查）；
 * ②信号追加篇与固定优先级；③front matter 不进 prompt、双帽（单篇/合计）与超帽跳过；
 * ④随包语料缺失/受限 → 空段降级（写稿不阻断）。
 * 后两条用 CLWRITING_RESOURCES_DIR 注入临时资源根造受限/超长语料（真实语料体量够不到帽）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  buildMethodInjection,
  pickMethodFiles,
  METHOD_FILE_CAP,
  METHOD_FILE_CHARACTER,
  METHOD_FILE_HOOKS,
  METHOD_FILE_REVERSAL,
  METHOD_FILE_RHYTHM,
  METHOD_MAX_FILES,
  METHOD_TOTAL_CAP,
} from '../../src/knowledge/select.js'

let dir: string
let prevResourcesDir: string | undefined

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-know-select-'))
  prevResourcesDir = process.env['CLWRITING_RESOURCES_DIR']
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (prevResourcesDir === undefined) delete process.env['CLWRITING_RESOURCES_DIR']
  else process.env['CLWRITING_RESOURCES_DIR'] = prevResourcesDir
})

/** 造受限资源根：knowledge/<rel> 写指定正文（无 front matter，bodyOf 原样） */
function stubCorpus(files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, 'knowledge', ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  process.env['CLWRITING_RESOURCES_DIR'] = dir
}

describe('pickMethodFiles：基础篇与信号追加（纯函数）', () => {
  it('长篇恒选钩子速查；短篇恒选反转速查（无信号时各 1 篇）', () => {
    expect(pickMethodFiles('long', '')).toEqual([METHOD_FILE_HOOKS])
    expect(pickMethodFiles('short', '')).toEqual([METHOD_FILE_REVERSAL])
  })

  it('信号命中追加篇：节奏词（高潮/升级/期待）→ 节奏篇；对话词 → 人物篇', () => {
    expect(pickMethodFiles('long', '本章高潮爆发')).toEqual([METHOD_FILE_HOOKS, METHOD_FILE_RHYTHM])
    expect(pickMethodFiles('long', '以对话推进关系')).toEqual([METHOD_FILE_HOOKS, METHOD_FILE_CHARACTER])
  })

  it('两篇同命中 → 按固定优先级取节奏（先命中者），合计不超篇数帽', () => {
    const picks = pickMethodFiles('short', '高潮与对话同时出现')
    expect(picks).toEqual([METHOD_FILE_REVERSAL, METHOD_FILE_RHYTHM])
    expect(picks.length).toBeLessThanOrEqual(METHOD_MAX_FILES)
  })
})

describe('buildMethodInjection：真实随包语料（仓内 resources/knowledge）', () => {
  it('长篇注入钩子速查正文；段头/篇题/登记名齐备，front matter 不进 prompt', () => {
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '' })
    expect(text).toContain('## 写作方法参考(按本章自动选取,冲突时以本书设定为准)')
    expect(text).toContain('### 章节钩子速查')
    expect(text).toContain('章尾钩子') // 篇内正文要点
    expect(text).not.toContain('source:')
    expect(text).not.toContain('adaptation:')
    expect(sources).toEqual([`知识层(内置)/${METHOD_FILE_HOOKS}`])
  })

  it('短篇注入反转速查；章纲信号命中节奏篇 → 两篇两源（注入序）', () => {
    const { text, sources } = buildMethodInjection({ kind: 'short', signals: '情绪定位: 转折\n本章为卷末高潮' })
    expect(text).toContain('### 反转设计速查')
    expect(text).toContain('### 节奏与升级感速查')
    expect(sources).toEqual([`知识层(内置)/${METHOD_FILE_REVERSAL}`, `知识层(内置)/${METHOD_FILE_RHYTHM}`])
  })

  it('人物篇可被信号选中（对话/关系词）', () => {
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '场景: 对话' })
    expect(text).toContain('### 人物与对话技法速查')
    expect(sources).toContain(`知识层(内置)/${METHOD_FILE_CHARACTER}`)
  })
})

describe('buildMethodInjection：帽与降级（受限资源根）', () => {
  it('单篇超单篇帽 → 保头截断并标注', () => {
    stubCorpus({ [METHOD_FILE_HOOKS]: '甲'.repeat(METHOD_FILE_CAP + 500) })
    const { text } = buildMethodInjection({ kind: 'long', signals: '' })
    expect(text).toContain('…（超长截断）')
    // 截断后正文部分不含第 METHOD_FILE_CAP+1 个码点
    expect(text).not.toContain('甲'.repeat(METHOD_FILE_CAP + 1))
  })

  it('合计超合计帽 → 后篇整篇跳过（不留半段）', () => {
    stubCorpus({
      [METHOD_FILE_HOOKS]: '乙'.repeat(METHOD_FILE_CAP + 500), // 截断后 ≈2000
      [METHOD_FILE_RHYTHM]: '丙'.repeat(1200), // 2000+1200 > 3000 → 跳过
    })
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '高潮' })
    expect(text).toContain('### 章节钩子速查')
    expect(text).not.toContain('### 节奏与升级感速查')
    expect(sources).toEqual([`知识层(内置)/${METHOD_FILE_HOOKS}`])
    expect(METHOD_FILE_CAP + 1200).toBeGreaterThan(METHOD_TOTAL_CAP - 100) // 前提自检：该组合确超帽
  })

  it('随包语料缺失（资源根无 knowledge/）→ 空段降级不抛', () => {
    process.env['CLWRITING_RESOURCES_DIR'] = dir
    expect(buildMethodInjection({ kind: 'long', signals: '高潮' })).toEqual({ text: '', sources: [] })
  })

  it('篇文件为空/仅空白 → 该篇跳过（空段不注入）', () => {
    stubCorpus({ [METHOD_FILE_HOOKS]: '\n  \n' })
    expect(buildMethodInjection({ kind: 'long', signals: '' }).text).toBe('')
  })
})
