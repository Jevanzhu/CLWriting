/**
 * 写稿面方法选材（src/knowledge/select.ts）单测。
 *
 * 本件只锚**本面策略**：①基础篇按体裁（长篇＝长篇章节钩子速查 / 短篇＝短篇反转机制速查）；
 * ②信号追加篇按**本档候选表**的固定优先级（含篇数帽）；③书级 > 随包两级 rank（书级同名篇
 * 覆盖随包、书级缺篇/空篇回落随包）；④候选取材不跨档。
 * 装配面（单篇截断 / 合计即止 / 缺失 / 开关关 / 空候选 / 多篇序 / 标题提取）单源在
 * test/knowledge/inject.test.ts 面表；此处不再重复同一族断言。
 * 后两条用 CLWRITING_RESOURCES_DIR 注入临时资源根造受限语料。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { buildMethodInjection, pickMethodFiles, METHOD_MAX_FILES } from '../../src/knowledge/select.js'
import {
  GENERAL_FILE_CHARACTER,
  GENERAL_FILE_DIALOGUE,
  LONG_FILE_HOOKS,
  LONG_FILE_RHYTHM,
  SHORT_FILE_EMOTION,
  SHORT_FILE_REVERSAL,
} from '../../src/knowledge/catalog.js'

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
  it('长篇恒选长篇钩子速查；短篇恒选短篇反转机制速查（无信号时各 1 篇）', () => {
    expect(pickMethodFiles('long', '')).toEqual([LONG_FILE_HOOKS])
    expect(pickMethodFiles('short', '')).toEqual([SHORT_FILE_REVERSAL])
  })

  it('信号命中追加篇：节奏词（高潮/升级/期待）→ 长篇节奏篇；情绪词 → 短篇情绪释放篇', () => {
    expect(pickMethodFiles('long', '本章高潮爆发')).toEqual([LONG_FILE_HOOKS, LONG_FILE_RHYTHM])
    expect(pickMethodFiles('short', '本章情绪释放到位')).toEqual([SHORT_FILE_REVERSAL, SHORT_FILE_EMOTION])
  })

  it('人物/对话词在两档都命中通用追加篇（跨档共用判断类知识）', () => {
    expect(pickMethodFiles('long', '本章人物戏吃重')).toEqual([LONG_FILE_HOOKS, GENERAL_FILE_CHARACTER])
    expect(pickMethodFiles('short', '人物弧线要走完')).toEqual([SHORT_FILE_REVERSAL, GENERAL_FILE_CHARACTER])
    expect(pickMethodFiles('long', '台词密度高')).toEqual([LONG_FILE_HOOKS, GENERAL_FILE_DIALOGUE])
  })

  it('追加篇按表序取首个命中（人物表序先于对话，同现时取人物）', () => {
    expect(pickMethodFiles('long', '人物与对话并重')).toEqual([LONG_FILE_HOOKS, GENERAL_FILE_CHARACTER])
  })

  it('候选取材不跨档：同一信号在两档取不同篇（长篇候选表不含短篇篇，反之亦然）', () => {
    const longHit = pickMethodFiles('long', '情绪释放')
    const shortHit = pickMethodFiles('short', '情绪释放')
    expect(longHit[1]).toMatch(/^长篇\//)
    expect(shortHit[1]).toMatch(/^短篇\//)
  })

  it('两篇同命中 → 按固定优先级取先命中者，合计不超篇数帽', () => {
    const picks = pickMethodFiles('short', '情绪与段落都在')
    expect(picks).toEqual([SHORT_FILE_REVERSAL, SHORT_FILE_EMOTION])
    expect(picks.length).toBeLessThanOrEqual(METHOD_MAX_FILES)
  })
})

describe('buildMethodInjection：真实随包语料（仓内 resources/knowledge）', () => {
  it('长篇注入长篇章节钩子速查正文；段头/篇题/登记名齐备，front matter 不进 prompt', () => {
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '' })
    expect(text).toContain('## 写作方法参考(按本章自动选取,冲突时以本书设定为准)')
    expect(text).toContain('### 章节钩子速查')
    expect(text).toContain('章尾') // 篇内正文要点
    expect(text).not.toContain('source:')
    expect(text).not.toContain('adaptation:')
    expect(sources).toEqual([`知识层(内置)/${LONG_FILE_HOOKS}`])
  })

  it('短篇注入短篇反转机制速查；章纲信号命中情绪篇 → 两篇两源（注入序）', () => {
    const { text, sources } = buildMethodInjection({ kind: 'short', signals: '情绪定位: 转折\n本章情绪释放' })
    expect(text).toContain('### 反转机制速查')
    expect(text).toContain('### 情绪释放速查')
    expect(sources).toEqual([`知识层(内置)/${SHORT_FILE_REVERSAL}`, `知识层(内置)/${SHORT_FILE_EMOTION}`])
  })

  it('通用人物篇可被信号选中（两档共用）', () => {
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '本章人物戏吃重' })
    expect(text).toContain('### 人物设计速查')
    expect(sources).toContain(`知识层(内置)/${GENERAL_FILE_CHARACTER}`)
  })
})

describe('buildMethodInjection：书级 > 随包（两 level rank）', () => {
  it('书级同名篇覆盖随包，登记名走书根相对路径', () => {
    stubCorpus({ [LONG_FILE_HOOKS]: '随包钩子正文。' })
    const bookRoot = join(dir, 'book')
    const abs = join(bookRoot, '知识层', ...LONG_FILE_HOOKS.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '本书钩子口径：只认章尾五式。')
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '', bookRoot })
    expect(text).toContain('本书钩子口径')
    expect(text).not.toContain('随包钩子正文')
    expect(sources).toEqual([`知识层/${LONG_FILE_HOOKS}`])
  })

  it('书级无该篇 → 回落随包（不因书级缺篇而丢方法参考）', () => {
    stubCorpus({ [LONG_FILE_HOOKS]: '随包钩子正文。' })
    const bookRoot = join(dir, 'book') // 书根存在但无 知识层/
    mkdirSync(bookRoot, { recursive: true })
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '', bookRoot })
    expect(text).toContain('随包钩子正文')
    expect(sources).toEqual([`知识层(内置)/${LONG_FILE_HOOKS}`])
  })

  it('书级篇为空白 → 回落随包（空文件不算覆盖，不静默丢技法）', () => {
    stubCorpus({ [LONG_FILE_HOOKS]: '随包钩子正文。' })
    const bookRoot = join(dir, 'book')
    const abs = join(bookRoot, '知识层', ...LONG_FILE_HOOKS.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '\n \n') // 作者清空但忘了删文件
    const { text } = buildMethodInjection({ kind: 'long', signals: '', bookRoot })
    expect(text).toContain('随包钩子正文')
  })

  it('书级残留旧 rel 不进注入（取篇按 catalog，与磁盘面解耦）', () => {
    stubCorpus({ [LONG_FILE_HOOKS]: '随包钩子正文。' })
    const bookRoot = join(dir, 'book')
    const abs = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '作者书根残留的旧版钩子篇正文。')
    const { text, sources } = buildMethodInjection({ kind: 'long', signals: '', bookRoot })
    expect(text).not.toContain('作者书根残留')
    expect(sources).toEqual([`知识层(内置)/${LONG_FILE_HOOKS}`])
  })
})
