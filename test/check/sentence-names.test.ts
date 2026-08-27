import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSentenceLength, checkNewNames, checkImagery, checkInfoLeak } from '../../src/check/count.js'

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

// R65-16（十三轮）：名册在盘但读取失败（existsSync→readFileSync 间隙瞬删/占用——
// 此处用同名目录占位：existsSync 真、readFileSync EISDIR）→ 不再 ENOENT 直穿炸
// 整次机检，照 R62-9 同款降级为黄项提示本轮未跑
test('R65-16: 名册在盘但读取失败 → 黄 roster-unreadable 降级（不炸机检）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  mkdirSync(join(dir, '名册.md'), { recursive: true }) // 目录占位触发读失败
  try {
    const r = checkNewNames('「云澈」拔剑而出。', join(dir, '名册.md'))
    expect(r.name).toBe('新专名候选')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.checkId).toBe('roster-unreadable')
    expect(r.items[0]!.level).toBe('yellow')
    expect(r.items[0]!.message).toContain('新专名检查本轮未跑')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test('X-P2-9: 人名+说话动词的对白归属行不报新专名（说话人不在提示语词表）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  const roster = join(dir, '名册.md')
  writeFileSync(roster, '空名册', 'utf-8')
  try {
    // 网文最高频对白行式：引号外是「人名+说/道/喊」——引号内是对白内容，不是专名
    const body = ['「快走。」林晚说。', '「站住。」萧破军喊道。', '「别管我。」白衣女子喊了。'].join('\n')
    const r = checkNewNames(body, roster)
    expect(r.items).toHaveLength(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('X-P2-9: 引号外非归属结构照报（叙述行不豁免）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  const roster = join(dir, '名册.md')
  writeFileSync(roster, '空名册', 'utf-8')
  try {
    // 引号外是完整叙述（人名+动作，非说话动词收尾）→ 引号内仍按专名候选报
    const body = '「玄天宗」林晚远远望着那座山。'
    const r = checkNewNames(body, roster)
    expect(r.items.some((i) => i.checkId === 'new-name' && i.message.includes('玄天宗'))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── X-P2-22：词表未配置静默跳过（不再产恒久「未启用」黄项）────

test('X-P2-22: checkImagery 无词表 → 零项（不产 source-disabled 黄）', () => {
  const r = checkImagery('空气仿佛凝固了。')
  expect(r.items).toHaveLength(0)
})

test('X-P2-22: checkInfoLeak 无关键词 → 零项（不产 source-disabled 黄）', () => {
  const r = checkInfoLeak('他知道了血脉的秘密。')
  expect(r.items).toHaveLength(0)
})

// R62-29：SPEECH_ATTRIBUTION_RE 汉字段与全文件 HANZI（基本区+扩展 A）同源——
// 此前字面 \u4e00-\u9fa5 漏扩展 A 区，生僻字人名的归属行不豁免、对白被当专名误报。
test('checkNewNames: 扩展 A 区生僻字人名的对白归属行豁免（䜣 U+4723 + 说）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  try {
    const roster = join(dir, '名册.md')
    writeFileSync(roster, '已有角色：云澈', 'utf-8')
    const r = checkNewNames('「快走。」䜣说。', roster)
    expect(r.items).toHaveLength(0) // 归属行整行是对白，「快走」不进专名候选
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
