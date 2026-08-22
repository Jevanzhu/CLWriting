/**
 * 低级项（第十轮 低-4）回归 —— doMoveOrRename catch 块内 appendAborted 自身可抛穿透。
 *
 * 移动/重命名失败（rename EACCES 等）进 catch 后要补 journal aborted 行留痕；
 * 但 appendAborted 自己也可能失败（journal 目录被删/磁盘满/权限）——此前该异常
 * 直接穿透，调用方拿到裸 throw 而非 {ok:false} 契约（moveDocument 用 Promise.resolve
 * 包裹不捕获 throw，变成 rejected promise）。
 * mock journal.appendAborted 抛 EACCES 构造「移动失败 + 留痕也失败」双重故障，
 * 断言：仍返回 {ok:false}、留痕尝试发生过、源文件不动（fail-closed）。
 */
import { test, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

vi.mock('../../src/document/journal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/document/journal.js')>()
  return {
    ...orig,
    // 只让 appendAborted 失败：pending 正常写入（拿到 opId），settled 不在本路径
    appendAborted: vi.fn(() => {
      throw Object.assign(new Error('EACCES: journal 磁盘满（模拟）'), { code: 'EACCES' })
    }),
  }
})

import { DocumentService } from '../../src/document/service.js'
import { appendAborted } from '../../src/document/journal.js'

/** 造书：写作/正文/第一卷/0001-开篇 + 项目清单登记 doc_ch01 + git init（同 service-struct 夹具）。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'clw-move-abort-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

test('低-4（第十轮）：移动失败且 appendAborted 也失败 → 仍返回 {ok:false} 不穿透', async () => {
  const { root, svc } = makeBookWithChapter()
  // 目标目录只读 → renameSync EACCES 进 catch（pending 已写入，opId 已拿到）
  mkdirSync(join(root, '写作', '正文', '第二卷'), { recursive: true })
  chmodSync(join(root, '写作', '正文', '第二卷'), 0o555)
  try {
    const r = await svc.moveDocument({ docId: 'doc_ch01', toDir: '写作/正文/第二卷' })
    // 契约：双重故障下仍拿到 {ok:false}，而不是裸异常/rejected promise
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('移动/重命名失败')
    // 留痕尝试发生过（appendAborted 被调用，失败被兜底吞掉）
    expect(vi.mocked(appendAborted)).toHaveBeenCalledTimes(1)
    // fail-closed：源文件未被移动
    expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(true)
    expect(existsSync(join(root, '写作', '正文', '第二卷', '0001-开篇.md'))).toBe(false)
  } finally {
    chmodSync(join(root, '写作', '正文', '第二卷'), 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})
