import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSample, writeSample, readSamplesByScene, parseSampleFileName } from '../../src/format/style.js'
import { readRealmDoc, writeRealmDoc, getRealmSequence, realmIndex } from '../../src/format/realms.js'

// ── 文风样章（#5）──────────────────────────────

test('readSample + writeSample: 往返（含标签数组）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, '战斗-001.md')
  const s = {
    场景: '战斗', 来源: '作者原作' as const,
    出处: '《北境往事》第12章', 标签: ['短句', '快节奏'],
    正文: '刀光没入雪雾的刹那，他听见自己心跳。',
  }
  writeSample(fp, s)
  const r = readSample(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.sample.场景).toBe('战斗')
    expect(r.sample.来源).toBe('作者原作')
    expect(r.sample.标签).toEqual(['短句', '快节奏'])
    expect(r.sample.正文).toContain('刀光')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readSamplesByScene: 按场景取、容错', () => {
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))
  const dir = join(root, '文风', '样章库')
  mkdirSync(join(dir, '战斗'), { recursive: true })
  writeSample(join(dir, '战斗', '战斗-001.md'), {
    场景: '战斗', 来源: '作者原作', 正文: '战斗段一',
  })
  writeSample(join(dir, '战斗', '战斗-002.md'), {
    场景: '战斗', 来源: '题材范文', 正文: '战斗段二',
  })
  const { samples, errors } = readSamplesByScene(dir, '战斗')
  expect(samples).toHaveLength(2)
  expect(errors).toHaveLength(0)
  // 来源区分
  const sources = samples.map((s) => s.来源).sort()
  expect(sources).toEqual(['作者原作', '题材范文'])
  rmSync(root, { recursive: true, force: true })
})

test('readSamplesByScene: 场景目录不存在返回空', () => {
  const { samples } = readSamplesByScene(join(tmpdir(), '不存在-' + Date.now()), '战斗')
  expect(samples).toHaveLength(0)
})

test('parseSampleFileName', () => {
  expect(parseSampleFileName('战斗-001.md')).toEqual({ 场景: '战斗', 序号: 1 })
  expect(parseSampleFileName('对话-012.md')).toEqual({ 场景: '对话', 序号: 12 })
  expect(parseSampleFileName('乱.md')).toBeNull()
})

// ── 境界枚举（#6）──────────────────────────────

test('readRealmDoc + writeRealmDoc: 嵌套体系往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, '境界体系.md')
  const doc = {
    体系: [
      { 名称: '修真境界', 序列: ['炼气', '筑基', '金丹', '元婴'] },
      { 名称: '武者等级', 序列: ['后天', '先天', '宗师'] },
    ],
    正文: '修真境界各有特征。',
  }
  writeRealmDoc(fp, doc)
  const r = readRealmDoc(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.doc.体系).toHaveLength(2)
    expect(r.doc.体系[0]!.序列).toEqual(['炼气', '筑基', '金丹', '元婴'])
    expect(r.doc.正文).toContain('修真境界')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('getRealmSequence + realmIndex: 成长线机检数据源（#6 第 4 节）', () => {
  const doc = {
    体系: [{ 名称: '修真境界', 序列: ['炼气', '筑基', '金丹', '元婴', '化神'] }],
  }
  const seq = getRealmSequence(doc, '修真境界')!
  expect(seq).toEqual(['炼气', '筑基', '金丹', '元婴', '化神'])
  // 索引即高低（0 最低）
  expect(realmIndex(seq, '炼气')).toBe(0)
  expect(realmIndex(seq, '金丹')).toBe(2)
  expect(realmIndex(seq, '化神')).toBe(4)
  // 未命中
  expect(realmIndex(seq, '渡劫')).toBe(-1)
  expect(getRealmSequence(doc, '不存在的体系')).toBeNull()
})
