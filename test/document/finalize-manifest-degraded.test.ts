/**
 * R0917-6-P3-6（2026-09-17 全库源码重评六轮修复批）：finalize 前置查路径的清单读失败
 * 分诊回归。
 *
 * 缺陷形态：prepareFinalize 的 lookupRelPath 走 readManifest 容错版，清单撞
 * EACCES/EBUSY/EIO 瞬态读失败时与「文档不在清单里」同归 null，作者看到「未在文档清单
 * 中找到该文档」这一失实归因（真实原因是清单读不到）且不提示可重试；同文件锁内
 * readManifestStrict 的 WRITE_ERROR 信封（R27-40）与 R48-5 读盘失败信封反证本域已知
 * 该风险面。修复 = 改走 readManifestDegraded，degraded 非空 → WRITE_ERROR 可重试。
 *
 * 确定性模拟：清单路径做成目录（readFileSync 抛 EISDIR），与 manifest-read-degraded
 * -flag.test.ts 同款手法（不依赖平台权限档）。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finalizeRevision } from '../../src/document/finalize.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { scaffoldBook } from '../helpers/book.js'

function makeBook(): string {
  const { root } = scaffoldBook({
    prefix: 'finalize-degraded-',
    flatRoot: true,
    files: [{ rel: '写作/正文/0001-开篇.md', content: '---\n章号: 1\n标题: 开篇\n---\n\n正文。\n' }],
  })
  mkdirSync(join(root, '项目'), { recursive: true })
  return root
}

describe('R0917-6-P3-6：finalize 前置清单读失败与「未登记」分诊', () => {
  it('清单路径是目录（EISDIR 读失败）→ WRITE_ERROR 可重试，不再误报 NOT_FOUND', () => {
    const root = makeBook()
    // 用目录占位清单路径：readFileSync 抛 EISDIR → readManifestDegraded 归 degraded
    mkdirSync(join(root, '项目', '文档清单.jsonl'))
    const r = finalizeRevision(root, generateDocId())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.error).toContain('定稿前清单读取失败')
  })

  it('清单不存在 + 未登记 docId → NOT_FOUND 原语义不变（合法空态不误升级为可重试）', () => {
    const root = makeBook()
    const r = finalizeRevision(root, generateDocId())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('NOT_FOUND')
    expect(r.error).toBe('未在文档清单中找到该文档')
  })

  it('清单合法但 docId 未登记 → NOT_FOUND（读成功路径不受本修复影响）', () => {
    const root = makeBook()
    writeFileSync(join(root, '项目', '文档清单.jsonl'), '{"type":"header","version":1}\n', 'utf-8')
    const r = finalizeRevision(root, generateDocId())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('NOT_FOUND')
    expect(r.error).toBe('未在文档清单中找到该文档')
  })
})