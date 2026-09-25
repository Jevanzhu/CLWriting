/**
 * R0916-7-P3-16（2026-09-24 全项目源码质量与优雅度评审 P3-16 第三项）回归：盘上 role 读入校验。
 *
 * 修复前 parseTrashText 用 `(o.role as DocumentRole) ?? 'note'` 断言——清单被手改、旧版本
 * 枚举漂移或他进程写入坏值时，任意字符串原样进入角色联合，下游按角色分流的能力判定拿到
 * 类型系统无法预料的取值。现在非法值回落 'note' 并日志留痕；合法值与缺失（旧清单形态）
 * 行为不变。
 */
import { describe, expect, it, vi, afterEach, type MockInstance } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { parseDocumentRole, readTrashManifest, readTrashManifestStrict } from '../../src/document/trash.js'
import { log } from '../../src/log/index.js'
import type { DocumentRole } from '../../src/document/layout.js'

const dirs: string[] = []

function makeRoot(lines: string[]): string {
  const root = mkdtempTracked(join(tmpdir(), 'r0916-role-'))
  dirs.push(root)
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
  writeFileSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'), lines.join('\n') + '\n', 'utf-8')
  return root
}

function entryJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    id: 'doc_1',
    originalPath: '写作/正文/第一卷/0001-开篇.md',
    trashedPath: '工作区/.trash/doc_1-0001-开篇.md',
    trashedAt: '2026-09-24T00:00:00.000Z',
    ...over,
  })
}

/** 本用例关注的角色回落留痕（过滤环境噪声） */
function roleWarns(spy: MockInstance<typeof log.warn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => (c[0] === 'trash' ? String(c[1]) : ''))
    .filter((m) => m.includes('role 非法'))
    .map((m) => JSON.parse(m) as Record<string, unknown>)
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('R0916-7-P3-16：parseDocumentRole 值域校验', () => {
  const VALID: DocumentRole[] = [
    'chapter',
    'piece-body',
    'chapter-outline',
    'outline',
    'volume-outline',
    'setting',
    'ledger',
    'style',
    'introduction',
    'draft',
    'material',
    'note',
    'discard',
  ]

  for (const role of VALID) {
    it(`合法角色 '${role}' 原样保留（无留痕）`, () => {
      const spy = vi.spyOn(log, 'warn')
      expect(parseDocumentRole(role)).toBe(role)
      expect(roleWarns(spy)).toHaveLength(0)
    })
  }

  it('缺失（undefined/null）→ note，静默（旧清单合法形态）', () => {
    const spy = vi.spyOn(log, 'warn')
    expect(parseDocumentRole(undefined)).toBe('note')
    expect(parseDocumentRole(null)).toBe('note')
    expect(roleWarns(spy)).toHaveLength(0)
  })

  it('非法字符串 → note 且留痕（原值可归因）', () => {
    const spy = vi.spyOn(log, 'warn')
    expect(parseDocumentRole('wip')).toBe('note')
    const warns = roleWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ role: 'wip' })
  })

  it('非字符串（数字/对象）→ note 且留痕（类型可归因）', () => {
    const spy = vi.spyOn(log, 'warn')
    expect(parseDocumentRole(7)).toBe('note')
    expect(parseDocumentRole({ role: 'chapter' })).toBe('note')
    const warns = roleWarns(spy)
    expect(warns).toHaveLength(2)
    expect(warns[0]).toMatchObject({ role: 'number' })
    expect(warns[1]).toMatchObject({ role: 'object' })
  })
})

describe('R0916-7-P3-16：清单读入端到端（容错读 + strict 读同源）', () => {
  it('非法 role 行 → 读出的角色回落 note（不再原样进联合）；同文件合法行不受影响', () => {
    const root = makeRoot([
      entryJson({ id: 'doc_bad', role: 'novel-chapter' }),
      entryJson({ id: 'doc_ok', role: 'chapter' }),
      entryJson({ id: 'doc_legacy' }), // 旧清单无 role 字段
    ])
    const spy = vi.spyOn(log, 'warn')
    const entries = readTrashManifestStrict(root)
    expect(entries.map((e) => [e.id, e.role])).toEqual([
      ['doc_bad', 'note'],
      ['doc_ok', 'chapter'],
      ['doc_legacy', 'note'],
    ])
    // strict 与容错读同源（同解析体），行为一致
    expect(readTrashManifest(root).map((e) => e.role)).toEqual(['note', 'chapter', 'note'])
    // 留痕逐次解析一条（两次读 = 两条）——非法值可归因，旧清单缺字段静默
    expect(roleWarns(spy)).toHaveLength(2)
  })

  it('坏值行不阻断同文件后续行（读全量语义不变）', () => {
    const root = makeRoot([entryJson({ id: 'doc_bad', role: 42 }), entryJson({ id: 'doc_ok', role: 'setting' })])
    const entries = readTrashManifestStrict(root)
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ id: 'doc_ok', role: 'setting' })
  })
})
