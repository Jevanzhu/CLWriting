/**
 * GG-P2-6 回归 —— 软删「回收站宁删失败」：登记写不成则整个软删不成立。
 *
 * 修复前 doTrash 先 rename 进 .trash、后补回收站登记，登记失败（磁盘满/登记路径被占）
 * 被 catch {} 静默吞掉 → 文件已删而回收站无记录，作者永远无法还原（静默丢稿）。
 * 修复后先写登记、成功才移文件。本文件把登记文件路径占成目录构造「登记必败」，
 * 断言软删返回 WRITE_ERROR、源文件与清单条目原地未动；并回归一条登记可写时的成功路径
 * （顺序调整不改变既有语义）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'

/** 造书：写作/正文/第一卷/0001 + 项目清单登记 doc_ch01（结构同 trash.test.ts）。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'gg-p2-6-trash-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

test('GG-P2-6：回收站登记写入失败 → 软删整体失败，源文件与清单条目原地未动（宁删失败）', async () => {
  const { root, svc } = makeBookWithChapter()
  // 把回收站登记文件路径占成目录——appendTrashEntry 的原子写 rename 到目录必抛
  mkdirSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'), { recursive: true })
  const srcAbs = join(root, '写作', '正文', '第一卷', '0001-开篇.md')
  const r = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('WRITE_ERROR')
  expect(r.reason).toContain('回收站登记')
  // 修复前（先移文件后吞登记失败）：文件已被移进 .trash 且清单除名——静默丢还原入口
  expect(existsSync(srcAbs)).toBe(true)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('doc_ch01')
  // 回收站里也没有半截产物（登记失败时文件尚未移入）
  expect(existsSync(join(root, '工作区', '.trash', 'doc_ch01-0001-开篇.md'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('GG-P2-6：登记可写时软删照常成功（先登记后移文件的顺序不改变既有语义）', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.trashedPath).toBe('工作区/.trash/doc_ch01-0001-开篇.md')
  expect(existsSync(join(root, r.trashedPath))).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).not.toContain('doc_ch01')
  rmSync(root, { recursive: true, force: true })
})
