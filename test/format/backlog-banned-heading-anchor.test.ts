/**
 * R59 清偿批（R57-D-3）回归：禁词段标题读取侧整行精确锚定。
 *
 * 原实现：parseAntiReconciliationWords 两处 extractSection 用子串匹配（/反和解/、
 * /硬禁词|禁词清单/）判段——作者自建的同关键词标题段（「## 反和解心得」「## 硬禁词
 * 拾遗」等）被当禁词段，段内笔记行经 parseBannedWordsLine 拆词（引号抽取/顿号劈分
 * 全认）混进 bannedWords 红闸误伤正文。与 style-migrate.ts R49-13 删除侧的整行精确
 * 锚定不对称。修复后对齐删除侧口径：标题须整行为关键词短语本身（可带模板/清单后缀），
 * 只收窄作者自建标题误伤面；旧模板/清单标准标题与裸关键词标题照常解析，真禁词段
 * 检出不放宽。
 */
import { describe, expect, it } from 'vitest'
import { parseIronRules } from '../../src/format/iron-rules.js'

describe('R57-D-3: 禁词段标题整行精确锚定（作者同关键词段不再拆词进红闸）', () => {
  it('作者自建同关键词标题段不入禁词表；旧模板段照常解析', () => {
    const rules = parseIronRules(
      [
        '# 文风铁律',
        '',
        '## 反和解段（AI 味防御）',
        '',
        '- 「势不两立」',
        '',
        '## 反和解心得',
        '',
        '- 参考「暖场」「破冰」的写法',
        '',
        '## 硬禁词拾遗',
        '',
        '- 前期对立、中期试探、后期坦诚',
        '',
      ].join('\n'),
    )
    // 修复前：作者两段被当禁词段，笔记行拆词混入（暖场/破冰/前期对立/中期试探/后期坦诚）
    expect(rules.bannedWords).toEqual(['势不两立'])
  })

  it('旧模板两段 + 清单标准标题照常解析（真禁词检出不放宽）', () => {
    // fixture 与 test/check/checks.test.ts「反和解段解析为硬禁词」同源（契约不回退）
    const rules = parseIronRules(
      [
        '## 反和解段（AI 味防御）',
        '- 禁止：轰动体、倒吸凉气、时间静止',
        '- 「蝼蚁」',
        '',
        '## 硬禁词清单',
        '- 禁词：不知死活的东西 / 天命所归',
        '- 「会让你们后悔」',
      ].join('\n'),
    )
    expect(rules.bannedWords).toEqual([
      '轰动体',
      '倒吸凉气',
      '时间静止',
      '蝼蚁',
      '不知死活的东西',
      '天命所归',
      '会让你们后悔',
    ])
  })

  it('裸关键词标题（## 硬禁词）仍是禁词段', () => {
    const rules = parseIronRules(
      ['## 硬禁词', '- 禁词：不知死活的东西 / 天命所归'].join('\n'),
    )
    expect(rules.bannedWords).toEqual(['不知死活的东西', '天命所归'])
  })

  it('裸形「## 反和解段」（无模板后缀）仍是禁词段——主审复核批修正回归', () => {
    // style-inject.test.ts S5 合并契约 fixture 同源：旧子串时代裸形即在野合法形态，
    // 删除侧 R49-13 不删裸形段（只锚全形），读取侧是该书禁词唯一解析面——初版
    // ANTI_RECON_HEADING_RE 锚死全形令其静默丢失，后缀改可选后须两形皆收。
    // 同锚仍排除作者自建段：「## 反和解心得」不入表。
    const rules = parseIronRules(
      [
        '## 反和解段',
        '- 「势不两立」',
        '',
        '## 反和解心得',
        '',
        '- 参考「暖场」的写法',
      ].join('\n'),
    )
    expect(rules.bannedWords).toEqual(['势不两立'])
  })
})
