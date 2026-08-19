/**
 * draft-pipeline 单测（第十一轮 P1-TST-2）：
 * buildDraftPrompt 长短篇分支 + 上下文组装。
 *
 * snapshotBeforeOverwrite / saveDraft 涉及 manifest + tree + git 多模块交互，
 * 此处聚焦 buildDraftPrompt 的 prompt 组装正确性（AI 写稿质量根基）。
 *
 * C3（DSH-17）：设定注入改预算制——世界观/角色/境界共享 SETTINGS_BUDGET_CHARS，
 * 预算内世界观全文直入（B3 的 1200 阈值无差别 prune 在本链路被取代）。
 *
 * 场景水源三级回退（git 事故后重建）：文风样章场景 ① 章纲 fm「场景」→ ② 正文 fm「场景」
 * → ③ 细纲「## 场景声明」段（带章号门：细纲 fm 章号 === 被检章号才可信）→ 全空回落「通用」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDraftPrompt, SETTINGS_BUDGET_CHARS } from '../../src/process/draft-pipeline.js'
import type { BookConfig } from '../../src/format/types.js'

/** 最小合法 BookConfig（P1 接线测试用：字数目标 / 注入档按需叠加） */
function cfg(over: { chapterTarget?: number; injection?: 'light' | 'heavy' }): BookConfig {
  return {
    spec_version: 1,
    book: { title: '测试书', ...(over.chapterTarget !== undefined ? { chapter_target_words: over.chapterTarget } : {}) },
    leads: { enabled: [] },
    budget: {},
    growth: {},
    ...(over.injection !== undefined ? { style: { injection: over.injection } } : {}),
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-draft-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('buildDraftPrompt: 长篇', () => {
  it('基本结构 → 含任务/要求段', () => {
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('长篇')
    expect(p).toContain('2000-4000 字')
    expect(p).toContain('章尾留钩')
  })

  it('有细纲 → 含细纲段', () => {
    mkdirSync(join(dir, '工作区'), { recursive: true })
    writeFileSync(join(dir, '工作区', '细纲.md'), '细纲内容：主角登场')
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('细纲内容：主角登场')
  })

  it('无细纲 → 不含细纲段', () => {
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).not.toContain('本章细纲')
  })

  it('有世界观 → 含世界观段', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    writeFileSync(join(dir, '设定', '世界观.md'), '修仙世界，灵气复苏')
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('修仙世界')
    expect(p).toContain('## 世界观(本书设定,保持设定一致)')
  })
})

describe('buildDraftPrompt: 设定预算注入（C3 / DSH-17）', () => {
  it('世界观超 1200 但预算内 → 全文直入（B3 修剪在本链路被预算机制取代）', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    const long = '界'.repeat(3000)
    writeFileSync(join(dir, '设定', '世界观.md'), long)
    const p = buildDraftPrompt(dir, 1, 'long')
    // 3000 < SETTINGS_BUDGET_CHARS(6000)：全文注入，不再按 B3 的 1200 阈值头尾修剪
    expect(p).toContain(long)
    expect(p).not.toContain('[...中段已省略...]')
    expect(p).not.toContain('超预算')
  })

  it('世界观超预算 → 截断声明 + 注入量受控', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    writeFileSync(join(dir, '设定', '世界观.md'), '界'.repeat(8000))
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('## 世界观(本书设定,保持设定一致)')
    // in-band 声明指名截断了什么；prune 头尾保留 + 中段省略
    expect(p).toContain('（世界观超预算已截断）')
    expect(p).toContain('[...中段已省略...]')
    // '界' 出现次数受预算约束（8000 全文 → 远小于 8000，恒 ≤ 预算量级）
    expect(p.split('界').length - 1).toBeLessThan(SETTINGS_BUDGET_CHARS)
  })

  it('世界观 + 角色 + 境界 → 同一预算段注入（层序：世界观→角色→境界）', () => {
    mkdirSync(join(dir, '设定', '角色'), { recursive: true })
    writeFileSync(join(dir, '设定', '世界观.md'), '修仙世界，灵气复苏')
    writeFileSync(join(dir, '设定', '角色', '林远.md'), '---\n姓名: 林远\n身份: 清虚门弟子\n境界: 练气\n---\n正文')
    writeFileSync(
      join(dir, '设定', '境界体系.md'),
      '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基]\n---\n说明',
    )
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('## 世界观(本书设定,保持设定一致)')
    expect(p).toContain('## 角色设定(供参考,保持人物一致)')
    expect(p).toContain('## 境界体系(成长线机检依据)')
    expect(p).toContain('林远')
    expect(p).toContain('炼气')
    // 层序 = 传入序（世界观最前，境界最后），不按 specificity 重排
    expect(p.indexOf('## 世界观')).toBeLessThan(p.indexOf('## 角色设定'))
    expect(p.indexOf('## 角色设定')).toBeLessThan(p.indexOf('## 境界体系'))
  })
})

describe('buildDraftPrompt: 短篇', () => {
  it('基本结构 → 含短篇要求', () => {
    const p = buildDraftPrompt(dir, 1, 'short')
    expect(p).toContain('短篇')
    expect(p).toContain('8000-20000 字')
    expect(p).toContain('铺垫→反转→收尾')
  })

  it('CC-P2-22: 要求五段 ## 标题（与节数机检同口径），不再「禁 markdown 标题」', () => {
    // 节数守恒机检按 ## 标题计数（checkSectionCount），守规稿不应再因无标题被报项
    const p = buildDraftPrompt(dir, 1, 'short')
    expect(p).toContain('## 开头钩子')
    expect(p).toContain('## 余韵')
    expect(p).not.toContain('禁 markdown 标题')
  })

  it('CC-P2-22: 长篇维持纯叙事文本（禁 markdown 标题——长篇无节数机检）', () => {
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('禁 markdown 标题')
    expect(p).not.toContain('## 开头钩子')
  })

  it('有细纲+章纲+备料 → 全部拼入', () => {
    mkdirSync(join(dir, '工作区'), { recursive: true })
    writeFileSync(join(dir, '工作区', '细纲.md'), '短篇细纲')
    writeFileSync(join(dir, '工作区', '本章写作材料.md'), '参考材料')
    mkdirSync(join(dir, '大纲', '章纲'), { recursive: true })
    writeFileSync(join(dir, '大纲', '章纲', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n章纲详情')
    const p = buildDraftPrompt(dir, 1, 'short')
    expect(p).toContain('短篇细纲')
    expect(p).toContain('参考材料')
    expect(p).toContain('章纲详情')
  })
})

describe('buildDraftPrompt: 章号注入', () => {
  it('长篇 → 正确章号', () => {
    const p = buildDraftPrompt(dir, 7, 'long')
    expect(p).toContain('第 7 章')
  })

  it('短篇 → 正确章号', () => {
    const p = buildDraftPrompt(dir, 3, 'short')
    expect(p).toContain('第 3 章')
  })
})

describe('buildDraftPrompt: 每章字数区间（P1 接线 chapter_target_words）', () => {
  it('config 带字数目标 → 任务行用目标 ±20%（取整到百）', () => {
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ chapterTarget: 3000 }))
    expect(p).toContain('2400-3600 字')
    expect(p).not.toContain('2000-4000 字')
  })

  it('短篇同链', () => {
    const p = buildDraftPrompt(dir, 1, 'short', cfg({ chapterTarget: 10000 }))
    expect(p).toContain('8000-12000 字')
    expect(p).not.toContain('8000-20000 字')
  })

  it('未传 config → 硬编码区间不变（直调/测试路径回落）', () => {
    expect(buildDraftPrompt(dir, 1, 'long')).toContain('2000-4000 字')
    expect(buildDraftPrompt(dir, 1, 'short')).toContain('8000-20000 字')
  })

  it('目标 0 = 未设 → 硬编码区间', () => {
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ chapterTarget: 0 }))
    expect(p).toContain('2000-4000 字')
  })
})

describe('buildDraftPrompt: 文风样章（P1 接线 style.injection）', () => {
  /** 建旧样章库（战斗场景 3 段）——条目库路径由 materials 测试覆盖，此处验证生产链接线 */
  function makeSampleLibrary(): void {
    mkdirSync(join(dir, '文风', '样章库', '战斗'), { recursive: true })
    for (const [i, text] of ['样章正文甲', '样章正文乙', '样章正文丙'].entries()) {
      writeFileSync(
        join(dir, '文风', '样章库', '战斗', `战斗-00${i + 1}.md`),
        `---\n场景: 战斗\n来源: 作者原作\n---\n${text}`,
      )
    }
  }

  /** 建第 1 章章纲（fm 场景声明——文风样章选取的场景水源） */
  function makeChapterOutline(scene: string | string[]): void {
    mkdirSync(join(dir, '大纲', '章纲'), { recursive: true })
    const fmScene = Array.isArray(scene) ? `[${scene.join(', ')}]` : scene
    writeFileSync(
      join(dir, '大纲', '章纲', '0001-开篇.md'),
      `---\n章号: 1\n标题: 开篇\n场景: ${fmScene}\n---\n\n本章情节要点。`,
    )
  }

  it('无样章库 → 跳段（不出现文风样章标题）', () => {
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).not.toContain('## 文风样章')
  })

  it('默认/轻档 → 注入 1 段（注入档接线的核心行为）', () => {
    makeSampleLibrary()
    makeChapterOutline('战斗')
    for (const c of [undefined, cfg({}), cfg({ injection: 'light' })]) {
      const p = buildDraftPrompt(dir, 1, 'long', c)
      expect(p).toContain('## 文风样章(模仿其叙事语感与节奏,不抄情节)')
      // readdirSync 顺序不作假设：轻档恒 3 选 1
      const present = ['样章正文甲', '样章正文乙', '样章正文丙'].filter((s) => p.includes(s))
      expect(present).toHaveLength(1)
    }
  })

  it('重档 → 注入 3 段', () => {
    makeSampleLibrary()
    makeChapterOutline('战斗')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('样章正文甲')
    expect(p).toContain('样章正文乙')
    expect(p).toContain('样章正文丙')
  })

  it('短篇分支同链注入', () => {
    makeSampleLibrary()
    makeChapterOutline('战斗')
    const p = buildDraftPrompt(dir, 1, 'short', cfg({ injection: 'heavy' }))
    expect(p).toContain('## 文风样章')
    expect(p).toContain('样章正文丙')
  })

  it('章纲场景与样章库不符 → 跳段（不再硬编码「战斗」无条件选中）', () => {
    makeSampleLibrary()
    makeChapterOutline('对话')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).not.toContain('## 文风样章')
  })

  it('无章纲场景声明 → 仅「通用」场景候选（战斗库不入选）', () => {
    makeSampleLibrary()
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).not.toContain('## 文风样章')
  })

  it('无章纲 + 通用样章 → 仍注入（通用场景恒候选）', () => {
    mkdirSync(join(dir, '文风', '样章库', '通用'), { recursive: true })
    writeFileSync(join(dir, '文风', '样章库', '通用', '通用-001.md'), `---\n场景: 通用\n---\n通用样章正文`)
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('## 文风样章')
    expect(p).toContain('通用样章正文')
  })

  it('章纲多场景声明 → 场景命中各取代表', () => {
    mkdirSync(join(dir, '文风', '样章库', '战斗'), { recursive: true })
    writeFileSync(join(dir, '文风', '样章库', '战斗', '战斗-001.md'), `---\n场景: 战斗\n---\n战斗样章`)
    mkdirSync(join(dir, '文风', '样章库', '对话'), { recursive: true })
    writeFileSync(join(dir, '文风', '样章库', '对话', '对话-001.md'), `---\n场景: 对话\n---\n对话样章`)
    makeChapterOutline(['战斗', '对话'])
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('战斗样章')
    expect(p).toContain('对话样章')
  })
})

describe('readChapterScenes: 场景水源三级回退（① 章纲 fm → ② 正文 fm → ③ 细纲场景声明段）', () => {
  /** 建旧样章库（按需建场景目录，各 1 段——命中与否用「<场景>样章正文」是否出现判定） */
  function makeSampleLibrary(scenes: string[]): void {
    for (const sc of scenes) {
      mkdirSync(join(dir, '文风', '样章库', sc), { recursive: true })
      writeFileSync(join(dir, '文风', '样章库', sc, `${sc}-001.md`), `---\n场景: ${sc}\n来源: 作者原作\n---\n${sc}样章正文`)
    }
  }

  /** 建第 1 章章纲（scene 传 null → 不写「场景」字段，模拟水源①无声明） */
  function makeChapterOutline(scene: string | null): void {
    mkdirSync(join(dir, '大纲', '章纲'), { recursive: true })
    const fmScene = scene === null ? '' : `场景: ${scene}\n`
    writeFileSync(join(dir, '大纲', '章纲', '0001-开篇.md'), `---\n章号: 1\n标题: 开篇\n${fmScene}---\n\n本章情节要点。`)
  }

  /** 建第 1 章正文（scene 传 null → 不写「场景」字段，模拟水源②无声明；写作/正文/ 与生产同位） */
  function makeChapterBody(scene: string | null): void {
    mkdirSync(join(dir, '写作', '正文'), { recursive: true })
    const fmScene = scene === null ? '' : `场景: ${scene}\n`
    writeFileSync(join(dir, '写作', '正文', '0001-开篇.md'), `---\n章号: 1\n标题: 开篇\n${fmScene}---\n\n本章正文。`)
  }

  /** 建细纲（outline 端点同构：确定性 fm 章号 + 可选「## 场景声明」段——水源③与章号门的载体） */
  function makeDetailedOutline(chapterNo: number, sceneSection?: string): void {
    mkdirSync(join(dir, '工作区'), { recursive: true })
    const section = sceneSection ? `\n${sceneSection}\n` : ''
    writeFileSync(join(dir, '工作区', '细纲.md'), `---\n章号: ${chapterNo}\n---\n\n## 情节骨架\n开篇/发展/收尾。${section}`)
  }

  it('水源①命中：章纲 fm「场景」→ 样章按它选', () => {
    makeSampleLibrary(['战斗'])
    makeChapterOutline('战斗')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('## 文风样章')
    expect(p).toContain('战斗样章正文')
  })

  it('水源①优先于②：章纲场景与正文场景冲突 → 用章纲的（一级命中即止）', () => {
    makeSampleLibrary(['战斗', '对话'])
    makeChapterOutline('对话')
    makeChapterBody('战斗')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('对话样章正文')
    expect(p).not.toContain('战斗样章正文')
  })

  it('水源②回退：章纲无场景声明，正文 fm「场景」→ 用正文场景（重写/续写时场景跟随实稿）', () => {
    makeSampleLibrary(['战斗'])
    makeChapterOutline(null)
    makeChapterBody('战斗')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('## 文风样章')
    expect(p).toContain('战斗样章正文')
  })

  it('水源②优先于③：正文场景与细纲声明冲突 → 用正文的', () => {
    makeSampleLibrary(['战斗', '对话'])
    makeChapterOutline(null)
    makeChapterBody('对话')
    makeDetailedOutline(1, '## 场景声明\n本章主场景:「战斗」。')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('对话样章正文')
    expect(p).not.toContain('战斗样章正文')
  })

  it('水源③回退：章纲与正文都无场景，细纲(fm 章号=本章)「## 场景声明」→ 用之；段外引号词不收', () => {
    makeSampleLibrary(['战斗', '对话'])
    makeChapterOutline(null)
    makeChapterBody(null)
    // 场景声明段夹在两个 ## 标题之间：「## 伏笔回收」后的「对话」在段外，不得入选
    makeDetailedOutline(1, '## 场景声明\n本章主场景:「战斗」。\n## 伏笔回收\n- 「对话」级伏笔 → 回收于余韵')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('## 文风样章')
    expect(p).toContain('战斗样章正文')
    expect(p).not.toContain('对话样章正文')
  })

  it('水源③段内无引号 → 「主场景」行冒号后取词（AI 漏写「」时的回落解析）', () => {
    makeSampleLibrary(['战斗'])
    makeChapterOutline(null)
    makeChapterBody(null)
    makeDetailedOutline(1, '## 场景声明\n主场景: 战斗。')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).toContain('战斗样章正文')
  })

  it('章号门：细纲 fm 章号 ≠ 本章 → 不用细纲场景（别章陈旧细纲不串场，回落通用、战斗库不入选）', () => {
    makeSampleLibrary(['战斗'])
    makeChapterOutline(null)
    makeChapterBody(null)
    makeDetailedOutline(2, '## 场景声明\n本章主场景:「战斗」。')
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).not.toContain('## 文风样章')
  })

  it('章号门通过但细纲无「## 场景声明」段 → 回落通用', () => {
    makeSampleLibrary(['战斗'])
    makeChapterOutline(null)
    makeChapterBody(null)
    makeDetailedOutline(1)
    const p = buildDraftPrompt(dir, 1, 'long', cfg({ injection: 'heavy' }))
    expect(p).not.toContain('## 文风样章')
  })
})
