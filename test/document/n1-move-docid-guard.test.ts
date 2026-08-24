/**
 * N1（五十九轮）回归：doMoveOrRename 入口 safeDocId 守卫。
 *
 * manifest 是可篡改数据面：构造 id:"../../evil" 条目后 PATCH move/rename 可把
 * journal .jsonl 写出书仓库外（executeSave 有 P1-SEC-A 守卫，此入口漏）。
 * 验证：非法 docId → PATH_ESCAPE，仓库外无 journal 文件；writeSnapshot 对非法
 * docId 的静默 null 改为 warn 留痕（留底纪律失守可诊断）。
 */
import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { writeSnapshot } from '../../src/document/snapshot.js'
import { initLogging, flushLogsForTest } from '../../src/log/index.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'n1-docid-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造书：正文一章 + 清单登记一个 id 非法（路径穿越）但 path 合法的条目。 */
function makeBookWithEvilDocId(): { root: string; svc: DocumentService } {
  const root = tmpRoot()
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      // N1 攻击面：docId 构造 ../../evil → journal 路径 join(journalDir, `${docId}.jsonl`) 越出书仓库
      '{"id":"../../evil","nodeType":"document","path":"写作/正文/0001-开篇.md","parentId":null}',
    ].join('\n') + '\n',
    'utf-8',
  )
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

test('N1: 非法 docId 的 moveDocument → PATH_ESCAPE，journal 不越出书仓库', async () => {
  const { root, svc } = makeBookWithEvilDocId()
  const r = await svc.moveDocument({ docId: '../../evil', toDir: '写作/正文/第一卷' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('PATH_ESCAPE')
  // join(root/工作区/.journal, '../../evil.jsonl') 若被写 → root/evil.jsonl（越出工作区一层，
  // 已出书仓库控制面）；守卫后不应存在任何越出 .journal 的产物
  expect(existsSync(join(root, 'evil.jsonl'))).toBe(false)
  expect(existsSync(join(root, '工作区', 'evil.jsonl'))).toBe(false)
  // 正文文件原位未动（rename 未执行）
  expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(true)
})

test('N1: 非法 docId 的 renameDocument → PATH_ESCAPE', async () => {
  const { svc } = makeBookWithEvilDocId()
  const r = await svc.renameDocument({ docId: '../../evil', newName: '0001-改名.md' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('PATH_ESCAPE')
})

test('N1: 合法 docId 的 rename 照常成功（守卫不误伤）', async () => {
  const root = tmpRoot()
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ok","nodeType":"document","path":"写作/正文/0001-开篇.md","parentId":null}',
    ].join('\n') + '\n',
    'utf-8',
  )
  const svc = new DocumentService({ bookRoot: root })
  const r = await svc.renameDocument({ docId: 'doc_ok', newName: '0001-改名.md' })
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '0001-改名.md'))).toBe(true)
})

test('N1: writeSnapshot 非法 docId → null 且 warn 留痕（不再静默）', async () => {
  const logsDir = join(tmpRoot(), 'logs')
  initLogging({ logsDir, mirrorConsole: false })
  const out = writeSnapshot(join(logsDir, '版本'), '../../evil', '内容', { origin: 'manual', reason: '移动前留底', baseRevision: null })
  expect(out).toBeNull()
  await flushLogsForTest()
  const lines: string[] = []
  for (const f of readdirSync(logsDir)) {
    if (!f.endsWith('.jsonl')) continue
    lines.push(...readFileSync(join(logsDir, f), 'utf8').split('\n').filter((l) => l.trim()))
  }
  expect(lines.some((l) => l.includes('非法 docId'))).toBe(true)
  // 日志目录本身无越出（dirname(logsDir/版本, ...) 不会因非法 docId 逃逸写文件）
  expect(existsSync(join(dirname(logsDir), 'evil'))).toBe(false)
})
