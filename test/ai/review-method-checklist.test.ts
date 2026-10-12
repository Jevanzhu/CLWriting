/**
 * 三审技法段(统一批):prompt 只留审查契约与审计基线,视角对口技法改为
 * 运行时从知识层注入(书级 > 随包,src/knowledge/review-method.ts)。
 *
 * 本件锁两条:
 * 1) prompt 里「必须保留」的契约/基线仍在(只报问题/evidence/S1-S4/章级判断/连载连续性);
 * 2) 视角对口技法从注入段产出(按 lens 选篇、随包兜底、书级覆盖),且不再残留于 prompt——
 *    技法回归 prompt(双份)或注入断链(技法丢失)都即红。
 *
 * 记档:`vitest list --json <档>` 是**陷阱命令**——`--json` 收可选**文件路径**
 * (help 原文 `--json [true/path]`),故 <档> 被当成输出目标,全量枚举结果覆写该档
 * (本文件与 test/ai/provider/adapter-reasoning-echo-family.test.ts 各中过一次)。
 * 要枚举单档用 `npx vitest list <档>`(不加 --json),或 `--json` 后只跟输出路径。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REVIEW_SYSTEMS, REVIEW_COMMON } from '../../src/ai/prompts/review.js'
import { buildReviewMethodInjection, REVIEW_METHOD_FILE_CAP } from '../../src/knowledge/review-method.js'
import {
  METHOD_FILE_HOOKS,
  METHOD_FILE_REVERSAL,
  METHOD_FILE_RHYTHM,
  METHOD_FILE_CHARACTER,
} from '../../src/knowledge/select.js'

const ALL = ['reader', 'editor', 'continuity', 'hook', 'emotion_peak', 'payoff'] as const
const ALL_TEXTS: Array<[string, string]> = [
  ['review-common', REVIEW_COMMON],
  ...ALL.map((lens) => [`review-${lens}`, REVIEW_SYSTEMS[lens]!] as [string, string]),
]

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-rm-'))
  dirs.push(root)
  return root
}

describe('三审 prompt:契约与审计基线必须保留(全 7 文件)', () => {
  it('章级判断条恒定在位(删掉即红)', () => {
    for (const [name, text] of ALL_TEXTS) {
      expect(text, name).toContain('章级判断（逐条核对）')
      expect(text, name).toContain('删掉无影响 ＝ 水章')
      expect(text, name).toContain('总结式结尾即问题')
    }
  })

  it('审查契约恒定在位(只报问题 / evidence / severity / 输出工具)', () => {
    for (const [name, text] of ALL_TEXTS) {
      expect(text, name).toContain('只报问题')
      expect(text, name).toContain('evidence')
      expect(text, name).toContain('S1（致命）')
    }
    expect(REVIEW_SYSTEMS['hook']).toContain('钩子不替代推进')
    expect(REVIEW_SYSTEMS['continuity']).toContain('连载连续性')
    expect(REVIEW_SYSTEMS['continuity']).toContain('故事引擎是否仍在运转')
  })
})

describe('三审 prompt:视角对口技法已抽出,不再残留 prompt(防双份回归)', () => {
  it('技法要点不在任何 prompt 文本里(抽到知识层注入)', () => {
    const allPromptText = ALL_TEXTS.map(([, t]) => t).join('\n')
    for (const moved of [
      '回声 / 留白',
      '埋线是否 ≥2-3 处',
      '挤牙膏',
      '升级感三步',
      '对话质量',
      '人物活人度',
      '关系变化是否有事件驱动',
    ]) {
      expect(allPromptText, `技法「${moved}」应已抽出 prompt`).not.toContain(moved)
    }
  })
})

describe('三审技法注入(随包兜底)', () => {
  // 同族参数化一表:lens → 对口篇 + 该篇正文里的锚词。全 6 视角恒覆盖
  // (此前登记名只断言了 3 个 lens,另 3 个的映射改动可漏网)
  const FALLBACK: Array<[lens: string, file: string, marker: string]> = [
    ['hook', METHOD_FILE_HOOKS, '章尾钩子'],
    ['emotion_peak', METHOD_FILE_REVERSAL, '埋线'],
    ['payoff', METHOD_FILE_REVERSAL, '打脸节奏'],
    ['reader', METHOD_FILE_RHYTHM, '升级感三步法'],
    ['editor', METHOD_FILE_CHARACTER, '潜台词'],
    ['continuity', METHOD_FILE_CHARACTER, '关系网'],
  ]
  it.each(FALLBACK)('%s → 对口技法篇注入(随包兜底)且登记名走内置前缀', (lens, file, marker) => {
    const inj = buildReviewMethodInjection(lens)
    expect(inj.text).toContain(marker)
    expect(inj.sources).toEqual([`知识层(内置)/${file}`])
  })

  it('钩子篇的第二种手法也可检出;未知 lens 空段', () => {
    expect(buildReviewMethodInjection('hook').text).toContain('回声钩子')
    expect(buildReviewMethodInjection('unknown-lens')).toEqual({ text: '', sources: [] })
  })
})

describe('三审技法注入(书级覆盖随包)', () => {
  it('书级同名篇覆盖随包,登记名走书根相对路径', () => {
    const root = makeBook()
    const rel = METHOD_FILE_HOOKS
    const abs = join(root, '知识层', ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '# 本书钩子口径\n只认本社章尾五式。')
    const inj = buildReviewMethodInjection('hook', root)
    expect(inj.text).toContain('本书钩子口径')
    expect(inj.text).not.toContain('回声钩子')
    expect(inj.sources).toEqual([`知识层/${rel}`])
  })

  it('bookRoot 无对应篇 → 回落随包(不因书级缺篇而丢技法)', () => {
    const root = makeBook()
    const inj = buildReviewMethodInjection('emotion_peak', root)
    expect(inj.text).toContain('埋线')
    expect(inj.sources).toEqual([`知识层(内置)/${METHOD_FILE_REVERSAL}`])
  })

  it('书级篇超单篇帽 → 保头截断并标注(不整段丢弃)', () => {
    const root = makeBook()
    const rel = METHOD_FILE_HOOKS
    const abs = join(root, '知识层', ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '甲'.repeat(REVIEW_METHOD_FILE_CAP + 500))
    const inj = buildReviewMethodInjection('hook', root)
    expect(inj.text).toContain('…（超长截断）')
    expect(inj.text).not.toContain('甲'.repeat(REVIEW_METHOD_FILE_CAP + 1))
    // 截断后仍登记为书级源(注入确有其实,非「截没了却报已注入」)
    expect(inj.sources).toEqual([`知识层/${rel}`])
  })
})
