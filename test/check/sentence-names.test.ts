import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSentenceLength, checkNewNames } from '../../src/check/count.js'

// ── checkSentenceLength（#10 项 8，🟡 黄）──────────
// 分句按 [。！？\n] 切；超 maxLen（默认 60）为超长句；
// 超长句占比 > 20% 才报黄。

test('checkSentenceLength: 全短句通过', () => {
  const body = '他推开门。雪落了下来。夜很安静。'
  const r = checkSentenceLength(body)
  expect(r.name).toBe('句式体检')
  expect(r.items).toHaveLength(0)
})

test('checkSentenceLength: 超长句占比 >20% 报黄', () => {
  // 5 句中 2 句超 60 字（占比 40% > 20%）
  const long = '风'.repeat(65) // 65 > 60
  const body = `${long}。${long}。短句一。短句二。短句三。`
  const r = checkSentenceLength(body)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('sentence-length')
  expect(r.items[0]!.level).toBe('yellow')
  expect(r.items[0]!.message).toContain('40%')
})

test('checkSentenceLength: 超长但占比 ≤20% 不报', () => {
  // 5 句中仅 1 句超长（占比 20%，不大于 20% 阈值）
  const long = '风'.repeat(65)
  const body = `${long}。短句一。短句二。短句三。短句四。`
  const r = checkSentenceLength(body)
  expect(r.items).toHaveLength(0)
})

test('checkSentenceLength: 自定义 maxLen', () => {
  // maxLen=5；两句均超长 → 占比 100%
  const body = '这是一句很长很长的句子。又是一句很长很长的句子。'
  const r = checkSentenceLength(body, 5)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('>5字')
  expect(r.items[0]!.message).toContain('100%')
})

// ── checkNewNames（#10 项 10，🟡 黄）──────────────
// 从正文引号（「」『』"")内抽 2-4 字候选，
// 对照名册文件（文本 includes 判定），未登记 → 报黄候选。

test('checkNewNames: 名册中已登记 → 通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  const roster = join(dir, '名册.md')
  writeFileSync(roster, '已有角色：云澈、萧破军', 'utf-8')
  try {
    const r = checkNewNames('「云澈」拔剑而出。', roster)
    expect(r.name).toBe('新专名候选')
    expect(r.items).toHaveLength(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkNewNames: 正文含未登记专名 → 报黄', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  const roster = join(dir, '名册.md')
  writeFileSync(roster, '已登记：云澈', 'utf-8')
  try {
    const r = checkNewNames('「云澈」看向「萧破军」。', roster)
    // 萧破军未登记 → 报
    expect(r.items.some((i) => i.checkId === 'new-name' && i.message.includes('萧破军'))).toBe(true)
    expect(r.items.every((i) => i.level === 'yellow')).toBe(true)
    // 云澈已登记 → 不出现在告警里
    expect(r.items.every((i) => !i.message.includes('云澈'))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkNewNames: 名册文件不存在 → 空结果（不崩）', () => {
  const r = checkNewNames('「任意」内容', join(tmpdir(), '不存在-' + Date.now() + '.md'))
  expect(r.items).toHaveLength(0)
})

test('checkNewNames: 引号内仅 1 字或超 4 字不候选', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  const roster = join(dir, '名册.md')
  writeFileSync(roster, '空名册', 'utf-8')
  try {
    // 「风」= 1 字（< 2 不候选）；「这是一个很长的名字」= 9 字（> 4 不候选）
    const body = '「风」吹过。「这是一个很长的名字」结束了。'
    const r = checkNewNames(body, roster)
    expect(r.items).toHaveLength(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
