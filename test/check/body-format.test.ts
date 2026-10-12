/**
 * 正文格式机检（src/check/body-format.ts）单测。
 *
 * 锚定对外可观察行为（产出的 CheckItem 面）：
 * 1) markdown 行内语法（加粗/行内代码/列表/引用/表格）报黄；标题按体裁分判；
 * 2) 行首缩进报黄；
 * 3) 写作工程词报黄；
 * 4) 套话词与套路句式报黄（与 check/ai-patterns.ts 单源）；
 * 5) 干净正文零项（不误报），front matter 不参与判定；
 * 6) 接线：走生产链路 runCheckForDocument，正文格式段确入报告（摘掉 runner 侧调用即红）。
 */
import { describe, it, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBodyFormat, ENGINEERING_WORDS } from '../../src/check/body-format.js'
import { CLICHE_WORDS, AI_PATTERN_RULES } from '../../src/check/ai-patterns.js'
import { runCheckForDocument } from '../../src/check/run.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 取某 checkId 的项 */
function itemsOf(body: string, id: string, opts?: { allowSectionHeadings?: boolean }): number {
  return checkBodyFormat(body, opts).items.filter((i) => i.checkId === id).length
}

const CLEAN = '雨点敲在铁皮上。他拉开门，把伞靠在墙角。\n\n「来一碗。」他说。\n\n老板点头，转身下面。'

describe('正文格式机检：markdown 与缩进', () => {
  it('干净正文（段落 + 空行）→ 零项', () => {
    expect(checkBodyFormat(CLEAN).items).toEqual([])
  })

  it('加粗/行内代码 → 报 body-markdown', () => {
    expect(itemsOf('他**猛地**回头。', 'body-markdown')).toBe(1)
    expect(itemsOf('他写下 `第三章` 三个字。', 'body-markdown')).toBe(1)
  })

  it('列表/引用/表格 → 报 body-markdown', () => {
    expect(itemsOf('他数了数：\n- 一把伞\n- 两件衣', 'body-markdown')).toBe(1)
    expect(itemsOf('他念道：\n> 天要下雨', 'body-markdown')).toBe(1)
    expect(itemsOf('| 项 | 值 |\n|---|---|\n| 一 | 二 |', 'body-markdown')).toBe(1)
  })

  it('行首缩进（半角空格/全角空格/制表符）→ 报 body-indent', () => {
    expect(itemsOf('　他拉开门。', 'body-indent')).toBe(1)
    expect(itemsOf('  他拉开门。', 'body-indent')).toBe(1)
    expect(itemsOf('\t他拉开门。', 'body-indent')).toBe(1)
    // 段中空格不算（只判行首）
    expect(itemsOf('他说了一句 很轻的话。', 'body-indent')).toBe(0)
  })

  it('front matter 不参与判定（fm 里的 markdown 不算正文）', () => {
    const body = '---\n章号: 1\n标题: **开篇**\n---\n\n' + CLEAN
    expect(checkBodyFormat(body).items).toEqual([])
  })
})

describe('正文格式机检：标题按体裁分判', () => {
  it('长篇（不放行标题）→ 任何标题行报 body-heading', () => {
    expect(itemsOf('## 开头钩子\n\n雨点敲在铁皮上。', 'body-heading')).toBe(1)
    expect(itemsOf('# 第一章\n\n雨点敲在铁皮上。', 'body-heading')).toBe(1)
  })

  it('短篇（放行五段标题）→ 五段标题不报，别的标题照报', () => {
    const five = ['## 开头钩子', '## 铺垫', '## 升级', '## 反转', '## 余韵'].join('\n\n正文。\n\n')
    expect(itemsOf(five, 'body-heading', { allowSectionHeadings: true })).toBe(0)
    // 五段以外（## 番外 / # 一级标题）仍报
    expect(itemsOf('## 番外\n正文。', 'body-heading', { allowSectionHeadings: true })).toBe(1)
    expect(itemsOf('# 一级\n正文。', 'body-heading', { allowSectionHeadings: true })).toBe(1)
  })

  it('放行的段标题不触发 markdown 项（标题行先剔除再判行内语法）', () => {
    const body = '## 开头钩子\n\n雨点敲在铁皮上。\n\n## 铺垫\n\n他拉开门。'
    expect(checkBodyFormat(body, { allowSectionHeadings: true }).items).toEqual([])
  })
})

describe('正文格式机检：工程词与套话', () => {
  it('写作工程词 → 报 body-engineering-word（逐词表全覆盖）', () => {
    for (const w of ENGINEERING_WORDS) {
      expect(itemsOf(`他忽然想起${w}的安排。`, 'body-engineering-word'), w).toBe(1)
    }
    expect(itemsOf(CLEAN, 'body-engineering-word')).toBe(0)
  })

  it('成串工程词合成一条（不逐词刷屏）', () => {
    const r = checkBodyFormat('细纲写了伏笔，读者知道。').items.filter((i) => i.checkId === 'body-engineering-word')
    expect(r.length).toBe(1)
    expect(r[0]!.message).toContain('细纲')
    expect(r[0]!.message).toContain('读者')
  })

  it('套话词 → 报 body-cliche-word（词表单源 check/ai-patterns.ts）', () => {
    for (const w of CLICHE_WORDS) {
      expect(itemsOf(`他${w}停下脚步。`, 'body-cliche-word'), w).toBe(1)
    }
  })

  it('套路句式 → 报 body-ai-pattern（每条句式都有用例）', () => {
    const samples = [
      '他不是冷漠，而是绝望。',
      '他笑了一下，带着一丝不易察觉的嘲讽。',
      '她声音不大，却带着不容置疑的力量。',
      '他知道这一切都来不及了。',
      '他这才意识到事情不对。',
      '这一刻，他终于明白了。',
      '属于他的反击才刚刚开始。',
    ]
    expect(samples.length).toBe(AI_PATTERN_RULES.length)
    for (const s of samples) {
      expect(itemsOf(s, 'body-ai-pattern'), s).toBe(1)
    }
  })

  it('对白里的套话同样命中（判定不吃引号豁免——正文含对白同为文本）', () => {
    expect(itemsOf('「众所周知，这事不该问。」他说。', 'body-cliche-word')).toBe(1)
  })
})

describe('正文格式机检：与规则面同源', () => {
  /** 规则面 check 的 ctx——内置静态规则不读书级数据源，喂最小空壳即可 */
  const CTX = { bookRoot: '' }

  it('checkBodyFormat 与 aiClicheRule 对同一正文给出一致的套话/句式命中数', async () => {
    const { aiClicheRule } = await import('../../src/ai/rules/builtin.js')
    const body = '他**不禁**笑了，带着一丝嘲讽。\n\n这一刻，他终于明白。'
    const violations = aiClicheRule.check(body, CTX)
    const clicheHits = violations.filter((v) => v.message.startsWith('AI高频套话')).length
    const patternHits = violations.filter((v) => v.message.startsWith('套路句式')).length
    expect(itemsOf(body, 'body-cliche-word')).toBe(1)
    expect(itemsOf(body, 'body-ai-pattern')).toBe(2)
    expect(clicheHits).toBe(1) // 「不禁」
    expect(patternHits).toBe(2) // 「，带着…」与「这一刻，他终于…」
  })

  it('干净正文在规则面同样零命中（两面同口径）', async () => {
    const { aiClicheRule } = await import('../../src/ai/rules/builtin.js')
    expect(aiClicheRule.check(CLEAN, CTX)).toEqual([])
    expect(checkBodyFormat(CLEAN).items).toEqual([])
  })
})

describe('正文格式机检：接线（生产链路）', () => {
  /** 造一本最小可检书（正文格式段不依赖布线/账本，故只给 book.yaml 与正文） */
  function makeBook(): string {
    const root = mkdtempTracked(join(tmpdir(), 'body-format-wiring-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测书\nhost: cc\n', 'utf-8')
    return root
  }

  it('生产链路里正文含 markdown/工程词/套路句式 → 正文格式段带对应黄项', () => {
    const root = makeBook()
    try {
      const path = join(root, '写作', '正文', '001-夜访.md')
      writeFileSync(
        path,
        '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n' +
          '他**不是冷漠，而是绝望**。\n\n细纲写的伏笔，读者都知道。\n',
        'utf-8',
      )
      const outcome = runCheckForDocument(root, path)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const section = outcome.report.sections.find((s) => s.name === '正文格式')
      expect(section, '正文格式段未入生产链路报告（runner 侧调用缺失）').toBeDefined()
      const ids = (section?.items ?? []).map((i) => i.checkId)
      for (const id of ['body-markdown', 'body-engineering-word', 'body-ai-pattern']) {
        expect(ids, `正文格式段缺「${id}」项`).toContain(id)
      }
      expect((section?.items ?? []).every((i) => i.level === 'yellow')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('干净正文走生产链路 → 正文格式段零项（不误报回灌机检面板）', () => {
    const root = makeBook()
    try {
      const path = join(root, '写作', '正文', '001-夜访.md')
      writeFileSync(
        path,
        '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n' + CLEAN + '\n',
        'utf-8',
      )
      const outcome = runCheckForDocument(root, path)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.report.sections.find((s) => s.name === '正文格式')?.items ?? []).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
