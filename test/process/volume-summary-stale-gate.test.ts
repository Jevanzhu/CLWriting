/**
 * R27-107（二十七轮）回归——卷摘要「已过期但链不全」交集路径留痕 + 备料陈旧闸：
 * 根因：① selfHealVolumeSummary 的「链不全」与「fresh」合用一个静默 return——交集路径
 * （程序生成 + 链不全，新鲜度无从判定）放弃重生成却无任何留痕；② prepare 弹性#3 注入
 * 卷摘要只判文件存在——可证明过期（fm 指纹落后于当前章摘要链）的材料照进 prompt。
 * 语义：①链不全分支补 log.warn（取舍不变：不强行生成是二阶误差红线，只补留痕）；
 * ②备料入口加陈旧闸——「可证明过期」仅指程序生成 + 当前链完整非空 + 指纹不匹配，
 * 手写/链不全/空链/读失败一律放行（宁窄勿误杀），判据收在
 * summary.volumeSummaryProvablyStale 单一真相源，放弃注入即 warn 留痕。
 * 测法：夹具书（清单 60 章定稿 + 章摘要在位）× 卷摘要文件四种形态——旧指纹（闸拦+留痕）、
 * 真指纹（放行）、手写（放行）、链不全/空链（放行）；交集路径直调 selfHealVolumeSummary
 * 断言 null + warn。prepare 传 writingChapter=150（卷 3）定位第 2 卷摘要（L-P3 口径）。
 */
import { describe, test, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { prepare } from '../../src/process/prepare.js'
import { selfHealVolumeSummary, generateVolumeSummary, volumeSummaryPath } from '../../src/process/summary.js'
import { computeRevision } from '../../src/document/revision.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

// runSpec 桩（仅「新鲜卷摘要」用例的按需生成触达；立即返回，制造不了并发窗口也不需要）
vi.mock('../../src/ai/tasks/spec.js', () => ({
  runSpec: vi.fn(async () => ({ ok: true, data: { text: '第二卷内容提要。' }, model: 'mock' })),
}))

/** 夹具书：缓存表 + 清单登记第 60 章定稿 + 章摘要在位（卷 2 = 章 51~100 链完整非空）。 */
function makeGateBook(): { root: string; db: DatabaseSync } {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r27-stalegate-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
  const body = join(root, '写作', '正文', '060-第60章.md')
  writeFileSync(
    body,
    '---\n章号: 60\n标题: 第60章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第60章正文。\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const id = generateDocId()
  upsertEntry(m, { id, nodeType: 'document', path: '写作/正文/060-第60章.md', parentId: null })
  const e = m.entries.get(id)!
  e.finalizedRevision = computeRevision(body)
  e.finalizedAt = new Date().toISOString()
  writeManifest(manifestPath, m)
  writeFileSync(join(root, '定稿', '摘要', '章摘要', '60.md'), '第60章摘要：主角夺回玉佩。', 'utf-8')
  return { root, db }
}

/** 写程序生成形态的卷摘要（fm 带 sourceHash；值控制「新鲜/过期」形态）。 */
function writeVolumeSummary(root: string, sourceHash: string): void {
  writeFileSync(
    volumeSummaryPath(root, 2),
    `---\nvolume: 2\ngeneratedAt: 2026-08-01T00:00:00.000Z\nmodel: mock\nsourceHash: ${sourceHash}\n---\n\n第二卷剧情回顾正文。`,
    'utf-8',
  )
}

/** 备料（writingChapter=150 → 卷 3 → 注入第 2 卷摘要，L-P3 写作章推卷口径）。 */
function prepareOf(root: string, db: DatabaseSync): ReturnType<typeof prepare> {
  return prepare(db, DEFAULT_CONFIG, root, [], undefined, '战斗', undefined, 150)
}

describe('R27-107: 卷摘要备料陈旧闸', () => {
  test('程序生成且指纹落后（可证明过期）→ 不注入 prompt + warn 留痕', () => {
    const { root, db } = makeGateBook()
    try {
      writeVolumeSummary(root, 'sha256:old') // 真实链指纹是 H('60:…')，sha256:old 必不匹配
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const r = prepareOf(root, db)
        // 修复前：只判文件存在 → 可证明过期的材料照进 prompt
        expect(r.sections.find((s) => s.title === '第2卷摘要')).toBeUndefined()
        expect(r.injectedSummaryFiles).not.toContain('定稿/摘要/卷摘要/2.md')
        // 放弃注入即留痕（对齐全库 warn 风格）
        expect(warn.mock.calls.some((c) => String(c[0]).includes('[prepare]') && String(c[0]).includes('已过期'))).toBe(true)
      } finally {
        warn.mockRestore()
      }
    } finally {
      db.close()
    }
  })

  test('指纹匹配（新鲜，按需生成产物）→ 照常注入（闸不误杀）', async () => {
    const { root, db } = makeGateBook()
    try {
      // 走真实生成链写 fm（sourceHash = 当前链指纹）——闸按同一指纹复算应放行
      const g = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 2 })
      expect(g.ok && !g.skipped).toBe(true)
      const r = prepareOf(root, db)
      const sec = r.sections.find((s) => s.title === '第2卷摘要')
      expect(sec).toBeTruthy()
      expect(sec!.content).toContain('第二卷内容提要。') // M-7：剥 fm 只注入正文
      expect(r.injectedSummaryFiles).toContain('定稿/摘要/卷摘要/2.md')
    } finally {
      db.close()
    }
  })

  test('手写产物（无 sourceHash）→ 放行注入（M-7 作者优先，不按程序指纹判旧）', () => {
    const { root, db } = makeGateBook()
    try {
      writeFileSync(volumeSummaryPath(root, 2), '# 第二卷\n\n作者手写的卷摘要，一字不动。', 'utf-8')
      const r = prepareOf(root, db)
      expect(r.sections.find((s) => s.title === '第2卷摘要')).toBeTruthy()
      expect(r.injectedSummaryFiles).toContain('定稿/摘要/卷摘要/2.md')
    } finally {
      db.close()
    }
  })

  test('链不全（章摘要缺失）→ 无法证明过期 → 放行注入（宁窄勿误杀）', () => {
    const { root, db } = makeGateBook()
    try {
      rmSync(join(root, '定稿', '摘要', '章摘要', '60.md')) // 链不全：指纹无从计算
      writeVolumeSummary(root, 'sha256:old')
      const r = prepareOf(root, db)
      expect(r.sections.find((s) => s.title === '第2卷摘要')).toBeTruthy()
      expect(r.injectedSummaryFiles).toContain('定稿/摘要/卷摘要/2.md')
    } finally {
      db.close()
    }
  })

  test('空链（清单整档不在的 legacy 书）→ 退化指纹无比较意义 → 放行注入', () => {
    const { root, db } = makeGateBook()
    try {
      rmSync(join(root, '项目', '文档清单.jsonl')) // 无定稿登记 → 空链
      writeVolumeSummary(root, 'sha256:old')
      const r = prepareOf(root, db)
      expect(r.sections.find((s) => s.title === '第2卷摘要')).toBeTruthy()
      expect(r.injectedSummaryFiles).toContain('定稿/摘要/卷摘要/2.md')
    } finally {
      db.close()
    }
  })
})

describe('R27-107: 「已过期但链不全」交集路径留痕', () => {
  test('selfHealVolumeSummary：程序生成 + 链不全 → null 且 warn 留痕（不再静默放弃），文件原样保留', async () => {
    const { root, db } = makeGateBook()
    try {
      rmSync(join(root, '定稿', '摘要', '章摘要', '60.md')) // 链不全：新鲜度无从判定
      writeVolumeSummary(root, 'sha256:old')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // 修复前：chain null 与 fresh 合用一个 return——静默放弃无留痕
        const vol = await selfHealVolumeSummary(root, null, DEFAULT_CONFIG, 150) // 卷 3 写作中 → 上一卷 = 第 2 卷
        expect(vol).toBeNull()
        expect(warn.mock.calls.some((c) => String(c[0]).includes('[summary]') && String(c[0]).includes('链不全'))).toBe(true)
      } finally {
        warn.mockRestore()
      }
      // 取舍不变：不强行生成（二阶误差红线），现有文件原样保留
      expect(readFileSync(volumeSummaryPath(root, 2), 'utf8')).toContain('sha256:old')
    } finally {
      db.close()
    }
  })
})
