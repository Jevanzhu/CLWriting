/**
 * 机检扩展词表数据源接线集成测（#10 项 7 高频意象 / 项 11 信息差）：
 * 走 runCheckForDocument 生产链路（book.yaml 解析 → runAllChecks），验证三级供给——
 * 入参显式 > book.yaml checks.imagery_words（整体覆盖内置）> 内置种子表（imagery-seed.ts）；
 * 信息差两级：入参 > book.yaml checks.leak_keywords > 空（静默不启用）。
 * 此前两词表无任何调用方供给 → 检查器恒静默（评审：功能性缺口）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCheckForDocument } from '../../src/check/run.js'

/** 造一本有布线的书（信息差检查在 hasWiring 分支内）；extraYaml 追加 book.yaml 尾部 */
function makeWiringBook(extraYaml = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'wordlist-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n' + extraYaml,
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-谜底.md'),
    '---\n编号: 悬念-001\n标题: 谜底\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  return root
}

/** 正文一章：seed 短语 n 次 + 自定义词 n 次 + 可选信息差关键词一次 */
function writeChapter(root: string, body: string): string {
  writeFileSync(
    join(root, '写作', '正文', '001-夜访.md'),
    '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n' + body + '\n',
    'utf-8',
  )
  return join(root, '写作', '正文', '001-夜访.md')
}

function imageryItems(root: string, path: string) {
  const outcome = runCheckForDocument(root, path)
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error('unreachable')
  const section = outcome.report.sections.find((s) => s.name === '高频意象')
  return (section?.items ?? []).filter((i) => i.checkId === 'imagery-overuse')
}

test('默认生效：正文 3× 种子短语 → 黄项（此前词表恒空、检查器恒静默）', () => {
  const root = makeWiringBook()
  try {
    const path = writeChapter(root, '空气仿佛凝固。空气仿佛凝固。空气仿佛凝固。')
    const items = imageryItems(root, path)
    expect(items.some((i) => i.message.includes('空气仿佛凝固'))).toBe(true)
    expect(items.every((i) => i.level === 'yellow')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('书级覆盖：checks.imagery_words 整体替换种子表（覆盖不合并）', () => {
  const root = makeWiringBook('checks:\n  imagery_words: [青铜灯]\n')
  try {
    // 青铜灯 3 次 + 种子短语 3 次：只报书级词，种子词已被替换不再检
    const path = writeChapter(root, '青铜灯。青铜灯。青铜灯。空气仿佛凝固。空气仿佛凝固。空气仿佛凝固。')
    const items = imageryItems(root, path)
    expect(items.some((i) => i.message.includes('青铜灯'))).toBe(true)
    expect(items.some((i) => i.message.includes('空气仿佛凝固'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('显式空数组 = 关：imagery_words: [] → 种子短语 3 次也不报', () => {
  const root = makeWiringBook('checks:\n  imagery_words: []\n')
  try {
    const path = writeChapter(root, '空气仿佛凝固。空气仿佛凝固。空气仿佛凝固。')
    expect(imageryItems(root, path)).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('信息差接线：book.yaml leak_keywords 命中 → 候选黄项；未配置 → 静默', () => {
  const root = makeWiringBook('checks:\n  leak_keywords: [身世之谜]\n')
  const bare = makeWiringBook()
  try {
    const path = writeChapter(root, '他终于说出了身世之谜的真相。')
    const outcome = runCheckForDocument(root, path)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const section = outcome.report.sections.find((s) => s.name === '信息差候选')
    const items = (section?.items ?? []).filter((i) => i.checkId === 'info-leak-candidate')
    expect(items.some((i) => i.message.includes('身世之谜'))).toBe(true)
    // 顺带核对 byproducts 候选清单（三审消费侧）
    expect(outcome.report.byproducts?.infoLeakCandidates?.length).toBeGreaterThan(0)

    // 对照组：同样正文、未配关键词 → 无候选
    const path2 = writeChapter(bare, '他终于说出了身世之谜的真相。')
    const outcome2 = runCheckForDocument(bare, path2)
    expect(outcome2.ok).toBe(true)
    if (!outcome2.ok) return
    const section2 = outcome2.report.sections.find((s) => s.name === '信息差候选')
    expect((section2?.items ?? []).filter((i) => i.checkId === 'info-leak-candidate')).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})
