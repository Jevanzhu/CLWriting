/**
 * 短篇反转类型分类单测（format/reversal-types 共享版）。
 * 覆盖：8 类内置类型命中 / 「其他反转」兜底 / 「不是…而是」强信号 / 空文本。
 * 与 metrics/short-index 共用同一 classifyReversal（单一真相源）。
 */
import { describe, it, expect } from 'vitest'
import { classifyReversal } from '../../src/format/reversal-types.js'

describe('classifyReversal 反转类型归类', () => {
  it('死者反转：含死/亡/遗言等死亡词', () => {
    expect(classifyReversal('按门铃的来客就是三年前死在七号公寓的人')).toBe('死者反转')
    expect(classifyReversal('外婆留下的旧收音机里藏着外公的遗言')).toBe('死者反转')
  })

  it('真凶反转：设局/真凶/凶手', () => {
    expect(classifyReversal('主角不是中奖者而是替真正中奖者设局的调查员')).toBe('真凶反转')
    expect(classifyReversal('看起来温顺的邻居才是当年灭门的真凶')).toBe('真凶反转')
  })

  it('身份反转：亲生/血缘/替身/假扮', () => {
    expect(classifyReversal('一直照顾她的老管家其实是她的亲生父亲')).toBe('身份反转')
    expect(classifyReversal('主角是冒牌神明的替身')).toBe('身份反转')
  })

  it('时间/记忆反转：循环/记忆/重试', () => {
    expect(classifyReversal('主角以为困在循环里，每次醒来都是自己删除记忆后的重试')).toBe('时间/记忆反转')
  })

  it('现实层反转：虚拟/游戏/梦', () => {
    expect(classifyReversal('所谓修真界其实是一场全息虚拟游戏')).toBe('现实层反转')
  })

  it('亲密关系反转：恋人/亲人', () => {
    expect(classifyReversal('那个一直监视他的男人竟是失散多年的亲弟弟')).toBe('亲密关系反转')
  })

  it('自我反转：自己/主角（无更强信号时）', () => {
    expect(classifyReversal('主角发现自己一直活在别人的计划里')).toBe('自我反转')
  })

  it('「其他反转」兜底：无关键词', () => {
    expect(classifyReversal('她决定离开这个城市，去远方重新开始')).toBe('其他反转')
  })

  it('空文本 → 其他反转', () => {
    expect(classifyReversal('')).toBe('其他反转')
    expect(classifyReversal('   ')).toBe('其他反转')
  })

  it('「不是…而是」强信号：真凶后半句', () => {
    expect(classifyReversal('主角不是凶手而是被栽赃的替罪羊')).toBe('真凶反转')
  })

  it('「不是…而是」强信号：身份后半句', () => {
    expect(classifyReversal('她不是保姆而是老爷失散多年的亲生女儿')).toBe('身份反转')
  })

  it('顺序敏感：时间/记忆 优先于 现实层（共享「醒来」先命中循环）', () => {
    expect(classifyReversal('每次醒来都在循环里')).toBe('时间/记忆反转')
  })
})