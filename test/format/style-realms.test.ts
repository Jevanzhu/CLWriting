import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSample, writeSample, readSamplesByScene, parseSampleFileName } from '../../src/format/style.js'
import { readRealmDoc, writeRealmDoc, getRealmSequence, realmIndex, extractExactRealmFromEvidence } from '../../src/format/realms.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ── 文风样章（#5）──────────────────────────────

test('readSample + writeSample: 往返（含标签数组）', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境往事-'))
  const fp = join(dir, '战斗-001.md')
  const s = {
    场景: '战斗', 来源: '作者原作' as const,
    出处: '《北境往事》第12章', 标签: ['短句', '快节奏'],
    技法指令: '学它的停顿和短句压迫感',
    正文: '刀光没入雪雾的刹那，他听见自己心跳。',
  }
  writeSample(fp, s)
  const r = readSample(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.sample.场景).toBe('战斗')
    expect(r.sample.来源).toBe('作者原作')
    expect(r.sample.标签).toEqual(['短句', '快节奏'])
    expect(r.sample.技法指令).toBe('学它的停顿和短句压迫感')
    expect(r.sample.正文).toContain('刀光')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readSamplesByScene: 按场景取、容错', () => {
  const root = mkdtempTracked(join(tmpdir(), '北境往事-'))
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

// 低-3（第十轮）：readdir 与 stat 之间文件被删的竞态——等价造法是悬空 symlink
// （stat 跟随链接取目标，同样 ENOENT，与真实竞态同错误面）。此前裸 statSync 会把
// 整个场景读取抛穿，对齐 leads.ts readLeadDir 的守卫写法：单文件失败跳过不中断
// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('低-3（第十轮）：场景目录含已消失文件（悬空链接）不抛，其余样章照常读出', () => {
  const root = mkdtempTracked(join(tmpdir(), '北境往事-'))
  const dir = join(root, '文风', '样章库')
  mkdirSync(join(dir, '战斗'), { recursive: true })
  writeSample(join(dir, '战斗', '战斗-001.md'), {
    场景: '战斗', 来源: '作者原作', 正文: '战斗段一',
  })
  symlinkSync(join(dir, '战斗', 'no-such.md'), join(dir, '战斗', '战斗-002.md'))
  const { samples, errors } = readSamplesByScene(dir, '战斗')
  expect(samples).toHaveLength(1)
  expect(errors).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('parseSampleFileName', () => {
  expect(parseSampleFileName('战斗-001.md')).toEqual({ 场景: '战斗', 序号: 1 })
  expect(parseSampleFileName('对话-012.md')).toEqual({ 场景: '对话', 序号: 12 })
  expect(parseSampleFileName('乱.md')).toBeNull()
})

// ── 境界枚举（#6）──────────────────────────────

test('readRealmDoc + writeRealmDoc: 嵌套体系往返', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境往事-'))
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

// ── 二十六轮修复批 B 回归（R26-40 / R26-41）────────

// R26-40：境界命中前边界锚定——「伪金丹/九转金丹」不再把「金丹」当命中；
// 常规跃迁证据「突破至筑基」（连接语素「至」）不受影响
test('R26-40: extractExactRealmFromEvidence 前边界锚定——伪金丹/九转金丹 误配排除', () => {
  const seq = ['炼气', '筑基', '金丹', '元婴']
  // 既有语义不回归：连接语素（至/到/成/结）+ 行首/边界前缀照常命中
  expect(extractExactRealmFromEvidence('突破至筑基', seq)).toBe('筑基')
  expect(extractExactRealmFromEvidence('跌落至炼气', seq)).toBe('炼气')
  expect(extractExactRealmFromEvidence('林凡凝结金丹。', seq)).toBe('金丹')
  expect(extractExactRealmFromEvidence('晋入元婴', seq)).toBe('元婴')
  // R26-40 修复点：前邻汉字非连接语素 → 拒绝（修复前误配「金丹」）
  expect(extractExactRealmFromEvidence('林凡凝成的是伪金丹。', seq)).toBeNull()
  expect(extractExactRealmFromEvidence('服下九转金丹，气血翻涌。', seq)).toBeNull()
  // 「伪金丹」本身在序列中 → 整词命中正确胜出（修复前按最靠后错取子串「金丹」）
  const seq2 = ['筑基', '金丹', '伪金丹']
  expect(extractExactRealmFromEvidence('突破至伪金丹', seq2)).toBe('伪金丹')
})

// R26-41：来源三值白名单——非法值 warn + 按缺省「作者原作」处理（此前 as 直转污染消费侧）
test('R26-41: 来源非法值 warn 并按缺省处理；合法三值与缺省不 warn', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const dir = mkdtempTracked(join(tmpdir(), 'r2641-'))
  try {
    const fp = join(dir, '战斗-001.md')
    writeFileSync(fp, '---\n场景: 战斗\n来源: 网络摘抄\n---\n\n正文', 'utf-8')
    const r = readSample(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sample.来源).toBe('作者原作') // 非法值 → 缺省
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('来源值非法'))).toBe(true)

    // 合法值照常收；未写来源 = 缺省且不 warn（「未设」语义）
    warnSpy.mockClear()
    const fp2 = join(dir, '战斗-002.md')
    writeFileSync(fp2, '---\n场景: 战斗\n来源: 题材范文\n---\n\n正文', 'utf-8')
    const r2 = readSample(fp2)
    if (r2.ok) expect(r2.sample.来源).toBe('题材范文')
    const fp3 = join(dir, '战斗-003.md')
    writeSample(fp3, { 场景: '战斗', 来源: '作者原作', 正文: '正文' })
    const r3 = readSample(fp3)
    if (r3.ok) expect(r3.sample.来源).toBe('作者原作')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('来源值非法'))).toBe(false)
  } finally {
    warnSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})
