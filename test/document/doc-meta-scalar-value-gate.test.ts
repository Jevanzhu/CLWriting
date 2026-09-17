/**
 * 0918独立重评修复批（B010）回归：updateDocMeta fm 值类型闸。
 *
 * 修复前 meta PATCH 的值未经类型闸直入 patchFlatFm→stringifyValue——对象等非标量经
 * String(val) 兜底落成 "[object Object]" 伪值写坏 fm。修复后入口白名单（string/
 * 有限数字/boolean/仅含三者的标量数组，isFmWritableValue 单源置于 stringifyValue 旁）
 * fail-loud 拒收：BAD_INPUT 走 MoveResult 既有错误信封、未执行任何修改（fm 未写坏）；
 * undefined 跳过口径不变；标量/标量数组照旧成功且往返可解析。
 *
 * 直调 DocumentService.updateDocMeta（updateDocMetaLocked 入口闸在取锁前）；书仓库
 * 手工 scaffold（清单登记 doc_1 → 正文章）。锚：0918独立重评修复批 B010。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentService } from '../../src/document/service.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { splitFrontMatter, parseFlat } from '../../src/format/frontmatter.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const REL = '写作/正文/0001-开篇.md'
const BASE = '---\n章号: 1\n标题: 开篇\n---\n\n正文内容。\n'

let bookRoot = ''
let svc: DocumentService

afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  bookRoot = ''
})

function scaffold(): void {
  bookRoot = mkdtempTracked(join(tmpdir(), 'clw-meta-scalar-gate-'))
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, REL), BASE, 'utf8')
  // makeGitBook 同款清单登记形态（readManifest 容错读空 → upsert → 写回）
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  upsertEntry(m, { id: 'doc_1', nodeType: 'document', path: REL, parentId: null })
  writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)
  svc = new DocumentService({ bookRoot })
}

describe('0918独立重评修复批 B010: updateDocMeta fm 值类型闸', () => {
  it('对象值 → BAD_INPUT 明确报错，fm 未写坏（字节不变）', async () => {
    scaffold()
    const r = await svc.updateDocMeta('doc_1', { 主题: { a: 1 } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('BAD_INPUT')
      expect(r.reason).toContain('主题')
      expect(r.reason).toContain('值类型不支持')
    }
    expect(readFileSync(join(bookRoot, REL), 'utf8')).toBe(BASE)
  })

  it('null / 嵌套数组 / NaN → BAD_INPUT（未执行修改）', async () => {
    scaffold()
    for (const bad of [
      { 空值: null },
      { 嵌套: [[1, 2]] },
      { 非数: Number.NaN },
    ]) {
      const r = await svc.updateDocMeta('doc_1', bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('BAD_INPUT')
    }
    expect(readFileSync(join(bookRoot, REL), 'utf8')).toBe(BASE)
  })

  it('标量 / 标量数组照旧成功且往返可解析', async () => {
    scaffold()
    const r = await svc.updateDocMeta('doc_1', { 备注: '纯文本备注', 权重: 3, 开关: true, 标签: ['悬疑', '推理'] })
    expect(r.ok).toBe(true)
    const raw = readFileSync(join(bookRoot, REL), 'utf8')
    const sp = splitFrontMatter(raw)
    expect(sp).not.toBeNull()
    const fm = parseFlat(sp!.fmRaw)
    expect(fm.get('备注')).toBe('纯文本备注')
    expect(fm.get('权重')).toBe(3)
    // 读侧 parseValue 无布尔推断（既有约定）：写侧 stringifyValue 落 `true` 裸串、读回字符串
    expect(fm.get('开关')).toBe('true')
    expect(fm.get('标签')).toEqual(['悬疑', '推理'])
    expect(raw).toContain('正文内容。')
  })

  it('undefined = 不改该键（口径不变），其余键照写', async () => {
    scaffold()
    const r = await svc.updateDocMeta('doc_1', { 空缺: undefined, 附注: 'ok' } as Record<string, unknown>)
    expect(r.ok).toBe(true)
    const raw = readFileSync(join(bookRoot, REL), 'utf8')
    expect(raw).not.toContain('空缺')
    expect(raw).toContain('附注: ok')
  })
})
