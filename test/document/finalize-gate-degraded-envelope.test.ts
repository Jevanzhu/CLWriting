/**
 * 0918独立重评二轮修复批（B103）：定稿防吃书闸 fail-open 降级事实透出回归。
 *
 * 机理：finalGateBlockers 兑现侧清单不可读（R32-3 形态）/ 闸门自身异常时 catch →
 * log.warn → 返回 [] 静默放行——闸门持续故障时防吃书检查长期零 UI 可见性（与机检侧
 * pushDegradedYellow 黄项口径不对称）。修法：fail-open 哲学不变，降级短语随定稿结果
 * 信封 gateDegraded（string[]，人话）透出，服务端 API 层透传、前端弹 warning toast。
 *
 * 钉住面：
 * - 兑现侧清单不可读（账本推进.md 目录占位）→ finalize 仍 ok:true（放行语义不变）
 *   且 gateDegraded 非空、含人话短语；定稿基线照常落盘；
 * - 两端一致的健康闸 → gateDegraded 为 undefined（不误报）；
 * - 红项阻断语义不回退（LEAD_GATE 照拦）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scaffoldBook } from '../helpers/book.js'
import { finalizeRevision } from '../../src/document/finalize.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BODY_SENTENCE = '玉佩在火光里泛出微芒。'

/** 造一本长篇布线书：正文章 0001（正文含 BODY_SENTENCE）+ 悬念线 + 细纲声明。 */
function makeBook(): { root: string; docId: string } {
  const { root } = scaffoldBook({
    prefix: 'finalize-gate-degraded-',
    flatRoot: true,
    dirs: ['工作区'],
    files: [
      { rel: '写作/正文/0001-开篇.md', content: `---\n章号: 1\n标题: 开篇\n---\n\n${BODY_SENTENCE}\n` },
      {
        rel: '布线/悬念/悬念-001-玉佩.md',
        content: '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      },
      { rel: '工作区/细纲.md', content: '---\n章号: 1\n推进: 悬念-001\n---\n\n本章细纲。\n' },
    ],
  })
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)
  return { root, docId }
}

test('B103: 兑现侧清单不可读 → finalize 仍成功且信封携带 gateDegraded（修复前静默 []、零可见）', () => {
  const { root, docId } = makeBook()
  try {
    // R32-3 同款形态：账本推进.md 做成目录——existsSync 命中但 readFileSync 必败
    mkdirSync(join(root, '工作区', '账本推进.md'))
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // fail-open 放行语义不变：基线照常落盘
    const e = readManifest(join(root, '项目', '文档清单.jsonl')).entries.get(docId)!
    expect(typeof e.finalizedRevision).toBe('string')
    // 降级事实透出：非空人话短语
    expect(Array.isArray(r.gateDegraded)).toBe(true)
    expect(r.gateDegraded!.length).toBeGreaterThan(0)
    expect(r.gateDegraded![0]).toContain('防吃书')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B103: 两端一致的健康闸 → gateDegraded 为 undefined（不误报降级）', () => {
  const { root, docId } = makeBook()
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), `- 悬念-001 递进：${BODY_SENTENCE}\n`, 'utf-8')
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.gateDegraded).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B103: 红项阻断语义不回退（声明了没做 → LEAD_GATE，无 gateDegraded）', () => {
  const { root, docId } = makeBook()
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), '', 'utf-8')
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('LEAD_GATE')
    expect(r.error).toContain('声明了没做')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
