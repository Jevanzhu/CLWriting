/**
 * R0911b-P2④ / R0911b-F-P3-1 回归：机检剥引号口径统一。
 *
 * 同文件禁词（R29-1①）/意象（R51-E-N5）/开头（R29-4）均先 stripQuotedSpans 再匹配，
 * 唯 checkBodyParts / checkSimile / checkStyleMetrics 对话提示语堆叠项吃 raw body——
 * 对白里「眼睛×6」「像…一样」「不耐烦地说」是角色嘴里的话，不是作者叙述堆砌，
 * 对白密集章虚黄，短篇 strict（runner STRICT_SHORT_CHECK_IDS）升红会误打回重写。
 * 修复：三处对齐 stripQuotedSpans 单源（quotes.ts）。SIMILE_RE 正则本体不动——
 * scripts/harvest-corpus.ts 语料收割（R51-J-1）复用本正则直扫原文，剥引号只在
 * checkSimile 调用点做（约束见 count.ts checkSimile 注释）。
 */
import { describe, it, expect } from 'vitest'
import { checkBodyParts, checkSimile, checkStyleMetrics } from '../../src/check/count.js'
import type { IronRules } from '../../src/format/iron-rules.js'

/** 空铁律：只激活堆叠项路径，不叠加其他阈值项的噪声 */
const RULES: IronRules = {}

describe('R0911b-P2④: checkBodyParts 剥对白', () => {
  it('对白内堆砌不计数（对白密集章不再虚黄）', () => {
    // 「眼睛」×6 全在引号内（角色对白），叙述面 0 次 → 不报
    const body = [
      '「你看着我的眼睛。」他说。',
      '「你的眼睛里有雪。」她说。',
      '「我讨厌那双眼睛。」',
      '「别盯着我眼睛看。」',
    ].join('\n')
    expect(checkBodyParts(body).items).toEqual([])
  })

  it('对白外命中照常计数（修复不弱化检测面）', () => {
    // 叙述 6 次「眼睛」> 阈 5 → 照报；引号内 2 次不计
    const body = [
      '她的眼睛望着他，眼睛里映着火光。',
      '他不敢看那双眼睛，只觉得自己的眼睛发烫。',
      '多年后他仍记得那双眼睛，眼睛深处藏着没说完的话。',
      '「你的眼睛真亮。」她说。',
      '「我讨厌眼睛发红的样子。」',
    ].join('\n')
    const r = checkBodyParts(body)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.message).toContain('眼睛×6')
  })

  it('「手」动作语境路径同口径：对白内伸手不计数，对白外照计', () => {
    // 全部动作「手」在引号内 → 不报
    expect(checkBodyParts('「他伸手接住。」「她握住手不放。」「抬手示意。」「抓手要紧。」「挥手作别。」「摊手无奈。」').items).toEqual([])
    // 对白外 6 处动作「手」> 阈 5 → 照报
    const r = checkBodyParts('他伸手接住。她握住手不放。抬手示意。抓手要紧。挥手作别。摊手无奈。')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.message).toContain('手×6')
  })
})

describe('R0911b-P2④: checkSimile 剥对白', () => {
  it('对白内「像…一样」不计数', () => {
    // 12 处明喻全在对白内（角色嘴里的话）：剥对白后叙述 0 次 → 不报
    const body = [
      '「他的手像冰一样凉。」',
      '「人群像潮水一样涌来。」',
      '「心像鼓一样撞着胸口。」',
      '「夜像一辈子一样长。」',
    ].join('\n')
    expect(checkSimile(body, 3).items).toEqual([])
  })

  it('对白外命中照常计数', () => {
    // 叙述 4 处明喻 > 阈 3 → 照报；引号内 1 处不计
    const body = '月光像水一样漫过桌角。他的手指像枯枝般蜷着。心却像刀割一样疼。影子像风筝一样摇晃。「你的手像冰一样凉。」她说。'
    const r = checkSimile(body, 3)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.message).toContain('4 次')
  })
})

describe('R0911b-F-P3-1: 对话提示语堆叠项剥对白（与占比项同族对齐）', () => {
  it('对白内容里的「X地说」不计堆叠', () => {
    // 3 处「X地说」全在引号内（角色转述他人说话方式）：剥对白后叙述 0 处 → 不报
    const body = [
      '「他不耐烦地说了什么。」她回忆道。',
      '「母亲焦急地说了好几遍。」',
      '「车夫也催促地说了第三遍。」',
    ].join('\n')
    const r = checkStyleMetrics(body, RULES)
    expect(r.items.filter((i) => i.checkId === 'style-dialogue-tag')).toEqual([])
  })

  it('对白外提示语堆叠照常报黄（修复不弱化检测面）', () => {
    // 叙述面 3 处「X地说」→ 照报；引号内「焦急地说」不计
    const body = '他不耐烦地说着，挥手催促。母亲在一旁焦急地说：「求你再等一天。」门外的车夫也催促地说了第三遍。'
    const r = checkStyleMetrics(body, RULES)
    const tags = r.items.filter((i) => i.checkId === 'style-dialogue-tag')
    expect(tags).toHaveLength(3)
  })
})
