/**
 * MP2-3（专项重评二轮修复批）：四处用户可见归档/还原 rename 收编 renameWithRetry。
 *
 * trash 目录还原（trash.ts:288）/ 导出旧产物归档（export/index.ts archiveOldExport 与
 * 分章目录归档 :333）/ 账本推进归档（lead-update-draft.ts:184）此前裸 renameSync——
 * win 杀软/索引器瞬时锁（EPERM/EBUSY）直接失败。修复后经 renameWithRetry（3×50ms
 * 退避）瞬时锁可穿透。本文件对四个调用点做端到端回归：node:fs 的 renameSync 按
 * 路径条件注入一次性 EPERM（真实重试链穿透 atomic.ts → renameWithRetry）。
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failState = vi.hoisted(() => ({
  /** 命中即抛一次 EPERM 后放行（null = 全放行）。 */
  failWhen: null as ((from: string, to: string) => boolean) | null,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (failState.failWhen?.(from, to)) {
        failState.failWhen = null // 只失败一次：瞬时锁形态
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      return actual.renameSync(from, to)
    },
  }
})

import { restoreTrash, appendTrashEntry } from '../../src/document/trash.js'
import { exportBook } from '../../src/export/index.js'
import { archivePendingLeadUpdates } from '../../src/process/lead-update-draft.js'
import { LEAD_UPDATES_FILE, LEAD_UPDATES_ARCHIVE_DIR } from '../../src/check/lead-updates.js'

function mkRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `clw-mp2-3-${tag}-`))
}

describe('MP2-3：归档/还原 rename 穿透 win 瞬时锁（EPERM 一次后成功）', () => {
  it('trash 目录还原：renameWithRetry 退避后还原成功', async () => {
    const root = mkRoot('trash')
    try {
      const trashedRel = '工作区/.trash/d1-设定组'
      mkdirSync(join(root, trashedRel), { recursive: true })
      writeFileSync(join(root, trashedRel, 'a.md'), '内容', 'utf-8')
      appendTrashEntry(root, {
        id: 'd1',
        originalPath: '工作区/设定/设定组',
        trashedPath: trashedRel,
        trashedAt: new Date().toISOString(),
        role: 'setting',
      })
      failState.failWhen = (from) => from.includes('.trash')

      const r = await restoreTrash(root, 'd1')

      expect(r.ok).toBe(true) // 修复点：瞬时 EPERM 退避后还原成功（此前直接 WRITE_ERROR）
      expect(existsSync(join(root, '工作区/设定/设定组/a.md'))).toBe(true)
      expect(existsSync(join(root, trashedRel))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('导出旧产物归档（全本）：EPERM 一次后退避成功，不再落「归档失败」warning', () => {
    const root = mkRoot('export-merged')
    try {
      writeFileSync(
        join(root, 'book.yaml'),
        ['spec_version: 1', 'book:', '  title: 归档退避', '  genre: 玄幻'].join('\n'),
        'utf-8',
      )
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      writeFileSync(join(root, '写作', '正文', '1-雪.md'), '---\n章号: 1\n标题: 雪\n---\n雪落。', 'utf-8')
      const exportDir = join(root, '工作区', '导出')
      expect(exportBook({ bookRoot: root, format: 'merged' }).ok).toBe(true)
      // 归档只在书名变更后触发（同名重导出原地覆写不归档，archiveOldExport 的
      // old !== mergedFileName 条件）——改 title 后再导出才走 rename 归档链
      writeFileSync(
        join(root, 'book.yaml'),
        ['spec_version: 1', 'book:', '  title: 归档退避二', '  genre: 玄幻'].join('\n'),
        'utf-8',
      )
      failState.failWhen = (from, to) => to.includes('.旧版') && from.includes('全本-')

      const r = exportBook({ bookRoot: root, format: 'merged' }) // 书名变更再导出 → 归档旧全本

      expect(r.ok).toBe(true) // 修复点：瞬时锁退避后旧产物归档成功
      expect((r.warnings ?? []).some((w) => w.includes('归档失败'))).toBe(false)
      expect(existsSync(join(exportDir, '.旧版', '全本-归档退避.md'))).toBe(true)
      expect(existsSync(join(exportDir, '全本-归档退避二.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('导出分章目录归档：EPERM 一次后退避成功，产物写入 分章/ 不带序号', () => {
    const root = mkRoot('export-split')
    try {
      writeFileSync(
        join(root, 'book.yaml'),
        ['spec_version: 1', 'book:', '  title: 分章退避', '  genre: 玄幻'].join('\n'),
        'utf-8',
      )
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      writeFileSync(join(root, '写作', '正文', '1-雨.md'), '---\n章号: 1\n标题: 雨\n---\n雨落。', 'utf-8')
      const exportDir = join(root, '工作区', '导出')
      expect(exportBook({ bookRoot: root, format: 'split' }).ok).toBe(true)
      failState.failWhen = (from, to) => to.includes('.旧版') && from.endsWith(join('导出', '分章'))

      const r = exportBook({ bookRoot: root, format: 'split' }) // 第二次 → 旧分章目录归档

      expect(r.ok).toBe(true) // 修复点
      expect((r.warnings ?? []).some((w) => w.includes('分章目录归档失败'))).toBe(false)
      expect(existsSync(join(exportDir, '.旧版', '分章'))).toBe(true)
      expect(existsSync(join(exportDir, '分章'))).toBe(true) // 新产物正常落位
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('账本推进归档：EPERM 一次后退避成功，草稿不再依赖作者重试', () => {
    const root = mkRoot('lead')
    try {
      mkdirSync(join(root, '工作区'), { recursive: true })
      const main = join(root, LEAD_UPDATES_FILE)
      writeFileSync(main, '# 第3章 账本推进\n\n- [ ] 甲：玉佩线索推进（未确认）\n', 'utf-8')
      failState.failWhen = (from) => from.endsWith(LEAD_UPDATES_FILE)

      archivePendingLeadUpdates(root, 5)

      expect(existsSync(main)).toBe(false) // 修复点：瞬时锁退避后归档完成
      expect(existsSync(join(root, LEAD_UPDATES_ARCHIVE_DIR, '第3章.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
