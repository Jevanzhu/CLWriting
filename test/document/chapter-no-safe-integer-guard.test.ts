/**
 * 0918独立重评二轮修复批（B102）：chapterNoFromName SafeInteger 守卫下沉单源回归。
 *
 * 机理：16+ 位纯数字前缀文件名经 Number() 解析成超 2^53 失真浮点（1e20 级）——
 * 此前守卫只在两处消费点手工补（manifest/structure-core finalizedChapterNumbers），
 * finalize 防吃书闸定位与 service-meta 前缀回落未补，口径分裂。守卫下沉
 * format/filename.ts 单源后失真大数恒 null；消费点手工补丁删除（单源保证）。
 *
 * 钉住面：
 * - 单源：天文数字前缀 → null；2^53-1 安全边界内照常解析；
 * - 定稿章号集合（manifest / structure-core 两同名函数）：失真条目不入集合（守卫
 *   删除后由单源保证，行为不回退）；
 * - finalize 防吃书闸定位：fm 坏 + 天文数字文件名 → 章号按 0 降级（版本 reason
 *   落 ch:0000，不再派发 1.23e20 级章号）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chapterNoFromName } from '../../src/format/filename.js'
import { readManifest, writeManifest, upsertEntry, finalizedChapterNumbers as finalizedFromManifest } from '../../src/document/manifest.js'
import { finalizedChapterNumbers as finalizedFromRoot } from '../../src/document/structure-core.js'
import { finalizeRevision } from '../../src/document/finalize.js'
import { listVersions, readVersionMeta, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { generateDocId } from '../../src/document/stable-id.js'

test('B102 单源：16+ 位纯数字前缀 → null（失真浮点不外泄）', () => {
  expect(chapterNoFromName('99999999999999999999-标题.md')).toBeNull()
  expect(chapterNoFromName('12345678901234567 标题.md')).toBeNull()
  expect(chapterNoFromName('123456789012345678.md')).toBeNull() // 裸尾形态同守卫
})

test('B102 单源：安全整数边界不误伤（2^53-1 含，2^53+1 失真拒）', () => {
  expect(chapterNoFromName('9007199254740991-终.md')).toBe(9007199254740991)
  expect(chapterNoFromName('9007199254740993-x.md')).toBeNull()
  // 既有宽容集行为保绿
  expect(chapterNoFromName('0001-开篇.md')).toBe(1)
  expect(chapterNoFromName('5—标题.md')).toBe(5)
})

test('B102 消费点：定稿章号集合（清单形/书根形）失真条目不入集合（手工守卫删除后由单源保证）', () => {
  // 清单形（manifest.ts finalizedChapterNumbers）
  const root = join(tmpdir(), `clw-b102-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    mkdirSync(join(root, '项目'), { recursive: true })
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, { id: 'doc-huge', nodeType: 'document', path: '写作/正文/99999999999999999999-天文.md', parentId: null, finalizedRevision: 'sha256:x' })
    upsertEntry(m, { id: 'doc-ok', nodeType: 'document', path: '写作/正文/0012-正常.md', parentId: null, finalizedRevision: 'sha256:y' })
    writeManifest(manifestPath, m)
    const set1 = readManifest(manifestPath) // 回读走盘上事实
    expect(finalizedFromManifest(set1)).toEqual(new Set([12]))
    // 书根形（structure-core.ts finalizedChapterNumbers）
    expect(finalizedFromRoot(root)).toEqual(new Set([12]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B102 finalize：fm 坏 + 天文数字文件名 → 章号按 0 降级（版本 reason 落 ch:0000，不再 1e+20）', () => {
  const root = join(tmpdir(), `clw-b102f-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    // 有布线的长篇书：chapterNo > 0 才进防吃书闸定位——天文数字前缀须降 0 跳闸
    mkdirSync(join(root, '布线'), { recursive: true })
    mkdirSync(join(root, '工作区'), { recursive: true })
    const rel = '写作/正文/99999999999999999999-天文.md'
    mkdirSync(join(root, '写作/正文'), { recursive: true })
    writeFileSync(join(root, rel), '正文无 fm 形态。\n', 'utf8')
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    mkdirSync(join(root, '项目'), { recursive: true })
    const m = readManifest(manifestPath)
    const docId = generateDocId()
    upsertEntry(m, { id: docId, nodeType: 'document', path: rel, parentId: null })
    writeManifest(manifestPath, m)

    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 防吃书闸定位收到的是 0（无章号降级）而非 1.23e20——版本 reason 钉住
    const versions = listVersions(join(root, '工作区', VERSIONS_DIR_NAME), docId)
    expect(versions.length).toBeGreaterThan(0)
    const meta = readVersionMeta(join(root, '工作区', VERSIONS_DIR_NAME), docId, versions[0]!.id)
    expect(meta).not.toBeNull()
    expect(meta!.meta.reason).toContain('ch:0000')
    expect(meta!.meta.reason).not.toContain('1e+20')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
