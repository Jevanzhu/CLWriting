/**
 * R0913-win P2-2（2026-09-13 全库源码重评 win 适配修复批）：AI 章节工具 docId join
 * 折叠回归——chapterToDocId 的清单 join 改走 docJoinKey（NFC + 分隔符 + win/darwin
 * 大小写折叠，fs/safe-path.ts 单源）。修复前精确比较在外部 case-only 改名（win）或
 * NFD 文件名（mac APFS 惯存分解形）后 miss → 回落 legacyId（新形态哈希）→ AI 章节结
 * 构工具拿到的 docId 服务层解析失败，操作硬败。
 *
 * 断言分支：NFD 形（toNfcName 全平台归一）为全平台断言；case 变体形（platformCaseFold
 * 折叠面 = win32+darwin）按平台分支（R45-2 钉值测试同族：linux 为不折叠臂）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import { chapterToDocId } from '../../../src/ai/tools/shared.js'
import { legacyId } from '../../../src/document/stable-id.js'
import { writeManifest } from '../../../src/document/manifest.js'

let bookRoot: string

beforeEach(() => {
  bookRoot = mkdtempTracked(join(tmpdir(), 'r0913-docid-'))
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

function writeChapter(fileName: string, chapterNo: number): void {
  const dir = join(bookRoot, '写作', '正文')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), `---\n章号: ${chapterNo}\n标题: 测试章\n---\n\n正文\n`, 'utf-8')
}

function writeManifestEntry(entryPath: string, id: string): void {
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeManifest(manifestPath, {
    version: 1,
    entries: new Map([[id, { id, nodeType: 'document', path: entryPath, parentId: null }]]),
  })
}

describe('R0913-win P2-2：chapterToDocId join 键折叠', () => {
  it('NFD 清单形态 × NFC 盘上形态 → 返回清单真 id（全平台：toNfcName 归一）', () => {
    // 盘上 NFC（é = U+00E9）；清单登记 NFD（e + U+0301）——mac APFS 惯存分解形经
    // 外部工具/拷贝落进清单的形态。修复前精确比较 miss → legacyId。
    writeChapter('0001-café.md', 1) // NFC
    writeManifestEntry('写作/正文/0001-cafe\u0301.md', 'doc_nfd_entry') // NFD
    expect(chapterToDocId(bookRoot, 1)).toBe('doc_nfd_entry')
  })

  it('case-only 漂移：折叠面（win/darwin）返回真 id，不折叠面（linux）按原语义回落 legacy', () => {
    const foldFs = process.platform === 'win32' || process.platform === 'darwin'
    writeChapter('0001-Hero.md', 1)
    // 清单登记小写形（外部 case-only 改名后清单滞留旧形态的反向构造，等价触发面）
    writeManifestEntry('写作/正文/0001-hero.md', 'doc_case_entry')
    const got = chapterToDocId(bookRoot, 1)
    if (foldFs) expect(got).toBe('doc_case_entry')
    else expect(got).toBe(legacyId('写作/正文/0001-Hero.md'))
  })

  it('清单无此章 → 仍回落 legacyId（查无登记的原语义不变）', () => {
    writeChapter('0001-solo.md', 1)
    expect(chapterToDocId(bookRoot, 1)).toBe(legacyId('写作/正文/0001-solo.md'))
  })
})
