/**
 * Y-17 / Y-18 / Y-19（第五十七轮）回归——trash 与 foreshadow 迁移守卫。
 *
 * Y-18：restore/purge 校验 trashedPath 必须落在 工作区/.trash/ 内——trash-manifest
 * 是可篡改数据面，此前的「不出书仓库」校验挡不住书内横向搬/删文件（trashedPath 填
 * 正文路径 → restore 把正文 rename 走 / purge 把正文物理删）。
 * Y-17：restoreTrash 主清单写失败不再静默——warn 留痕（docId 身份断链无自动补录，
 * 注释如实纠正）。
 * Y-19：migrateLegacyForeshadows 续跑遇目标已存在 → 不重写（作者可能已编辑新文件），
 * 只补删旧源。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { restoreTrash, purgeTrash, appendTrashEntry } from '../../src/document/trash.js'
import { migrateLegacyForeshadows } from '../../src/document/foreshadow.js'
import * as logMod from '../../src/log/index.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-y17-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tamperEntry(): void {
  // 正文文件（篡改场景的受害者）
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '正文内容')
  // 篡改的 trash 条目：trashedPath 指向正文（越出 .trash 但仍在书仓库内）
  appendTrashEntry(root, {
    id: 'doc_evil',
    originalPath: '素材/目标.md',
    trashedPath: '写作/正文/0001-开篇.md',
    trashedAt: '2026-08-24T00:00:00Z',
    role: 'chapter',
  })
}

describe('Y-18: trashedPath 必须在 .trash 内', () => {
  it('restore：篡改条目（trashedPath 指向正文）→ NOT_FOUND，正文不被搬走', async () => {
    tamperEntry()
    const r = await restoreTrash(root, 'doc_evil')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_FOUND')
    expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(true)
    expect(existsSync(join(root, '素材', '目标.md'))).toBe(false)
  })

  it('purge：篡改条目 → NOT_FOUND，正文不被物理删除', async () => {
    tamperEntry()
    const r = await purgeTrash(root, 'doc_evil')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_FOUND')
    expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(true)
    expect(readFileSync(join(root, '写作', '正文', '0001-开篇.md'), 'utf-8')).toBe('正文内容')
  })
})

describe('Y-17: restore 清单写失败 warn 留痕', () => {
  it('主清单写失败（项目 是文件）→ 恢复仍成功 + log.warn 记身份断链提示', async () => {
    // 正常 trash 形态：文件在 .trash 内
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, '工作区', '.trash', 'doc_w-开篇.md'), '内容')
    appendTrashEntry(root, {
      id: 'doc_w',
      originalPath: '写作/正文/0001-开篇.md',
      trashedPath: '工作区/.trash/doc_w-开篇.md',
      trashedAt: '2026-08-24T00:00:00Z',
      role: 'chapter',
    })
    // 项目 做成普通文件 → 清单 RMW 的 mkdir/write 必败
    writeFileSync(join(root, '项目'), 'not-a-dir')
    const warnSpy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    const r = await restoreTrash(root, 'doc_w')
    expect(r.ok).toBe(true)
    // 文件已回原位（清单失败不阻断恢复）
    expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(true)
    // Y-17 修复点：不再静默——warn 留痕含身份断链提示
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[1] ?? '')
    expect(msg).toContain('doc_w')
    expect(msg).toContain('身份断链')
  })
})

describe('Y-19: foreshadow 迁移续跑不覆盖已编辑目标', () => {
  it('目标已存在（上次写成功后崩溃残留）→ 不重写只删旧源，作者修改保留', () => {
    // 旧账本伏笔
    mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
    writeFileSync(join(root, '大纲', '伏笔', 'L1.md'), '---\n编号: L1\n标题: 玉佩\n状态: 进行中\n---\n\n履历')
    // 续跑形态：目标已在（上次 atomicWrite 成功、rmSync 前崩溃），且作者已编辑它
    mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
    writeFileSync(join(root, '设定', '伏笔', 'L1-玉佩.md'), '作者改过的内容')
    const r = migrateLegacyForeshadows(root)
    expect(r.migrated).toBe(1)
    expect(readFileSync(join(root, '设定', '伏笔', 'L1-玉佩.md'), 'utf-8')).toBe('作者改过的内容')
    expect(existsSync(join(root, '大纲', '伏笔', 'L1.md'))).toBe(false)
  })
})
