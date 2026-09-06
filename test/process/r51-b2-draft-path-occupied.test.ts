/**
 * R51-B-2（五十一轮）回归：saveDraft 锁内复核补「他者文档移入同路径」方向。
 *
 * 原 R33D-20 复核只查本 docId 被移走（e.id===finalDocId && e.path!==relPath）——
 * 等锁窗内他进程把另一文档移入同路径（异 id entry 认领 relPath）时放行：新文件登记
 * 分支照常 upsert，清单出现两条 entry 认领同一路径（docId 反查歧义、树扫描重复节点）。
 * 修复：反向命中同口径上抛拒绝（世界已变，fail-closed）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveDraft } from '../../src/process/draft-pipeline.js'
import { resolveDraftPath } from '../../src/format/draft.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

let root = ''
let manifestPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'r51-b2-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  manifestPath = join(root, '项目', '文档清单.jsonl')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('R51-B-2: saveDraft 锁内复核反方向（他文档移入同路径）', () => {
  it('等锁窗内他文档认领目标路径 → 上抛拒绝，不落盘、不产重复路径清单条目', async () => {
    const content = '---\n章号: 42\n标题: 撞窗章\n---\n\n正文内容。'
    const { relPath } = resolveDraftPath(root, 42, content)
    // 入口时点：清单无 relPath 登记（registeredId=null → finalDocId 走 legacyId）
    const m0 = readManifest(manifestPath) // 缺失 → 空清单（容错口径）
    writeManifest(manifestPath, m0)
    // 发起保存（首个 await 前的预读全部同步完成），在等锁窗内模拟他进程 doMoveOrRename
    // 把另一文档移入同路径（清单登记先于本链复核落库）
    const pending = saveDraft(root, 42, content)
    const m1 = readManifest(manifestPath)
    upsertEntry(m1, { id: 'doc-mover-in', nodeType: 'document', path: relPath, parentId: null })
    writeManifest(manifestPath, m1)
    // 修复点：复核反向命中 → 拒绝（修复前放行，登记后清单双路径条目）
    await expect(pending).rejects.toThrow(/已被占用/)
    // 拒绝前未写盘：目标文件不存在
    expect(existsSync(join(root, relPath))).toBe(false)
    // 清单无重复路径条目：仍只有移入者一条认领
    const m2 = readManifest(manifestPath)
    const claimants = [...m2.entries.values()].filter((e) => e.path === relPath)
    expect(claimants).toHaveLength(1)
    expect(claimants[0]!.id).toBe('doc-mover-in')
  })

  it('无撞窗时保存照常成功（复核不误伤正常链）', async () => {
    const content = '---\n章号: 7\n标题: 正常章\n---\n\n正常正文。'
    const r = await saveDraft(root, 7, content)
    expect(r.relPath).toContain('正常章')
    expect(existsSync(join(root, r.relPath))).toBe(true)
  })
})
