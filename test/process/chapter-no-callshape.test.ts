/**
 * R1010c-EN-P2-1（2026-09-10 全量独立复审修复批）：chapterNoFromName 调用形态对表。
 *
 * 背景：src/process/summary.ts:519-529 的 R1010b-CORE-P2-1 注释曾宣称 `1.md` 等
 * 宽容命名「既不进 chain 也不进 missing」已收口——其中 `1.md` 系失实（chapterNoFromName
 * 正则 `/^(\d+)(?:[-—]|\s|$)/` 数字后 `.` 不匹配 → null）。同名文件树/消费方口径分裂
 * 如实存在，四个消费方的实际传参形态两分：
 * - **带全名（含 .md）**：summary:442,527（manifest e.path.split('/').pop()）、
 *   leads:103 与 foreshadow:574（walkMdEach onFile 的 name = Dirent.name 原名）——
 *   对 `1.md` 返回 null（不识别）；
 * - **stripMd 后裸名**：document/tree.ts:84 先 stripMd(e.name) 再经 :105 薄委托判——
 *   对 `1.md` 剥成 `1` 后返回 1（树排序认得）。
 *
 * 本对表钉住「同一磁盘文件名在两种调用形态下行为不同」这一现状边界：
 * 裸数字扩集（让 `1.md` 全消费面一致认得）是既有台账待拍板项——未来拍板落地时，
 * 改动者只改正则会同时移动本表两侧断言，若只改一处（如仅给某消费方补 stripMd）
 * 漏改其余，本表即红，防「修复只改一处漏其他」复发。
 *
 * 选址说明（新文件而非并入 test/format/filename.test.ts）：被测现象是四消费方调用
 * 形态的跨层分裂（消费方契约），test/process/ 已收同类消费侧回归
 * （r1010b-volume-chain-wide-name.test.ts，同一次单源升格的端侧验证）；
 * filename.test.ts 是消毒/提取模块自身的单元契约，不宜混入消费方对表。
 */
import { describe, expect, it } from 'vitest'
import { chapterNoFromName } from '../../src/format/filename.js'

/** 模拟 document/tree.ts 的调用形态：先剥 .md 再判（stripMd 等价：去尾部 .md） */
const treeShape = (fileName: string): number | null => chapterNoFromName(fileName.replace(/\.md$/i, ''))
/** 模拟 summary/leads/foreshadow 的调用形态：全名直判 */
const consumerShape = (fileName: string): number | null => chapterNoFromName(fileName)

describe('R1010c-EN-P2-1：chapterNoFromName 调用形态对表（带 .md 全名 vs stripMd 裸名）', () => {
  it('形态一（summary:442,527 / leads:103 / foreshadow:574——全名直判）：`1.md` → null', () => {
    expect(chapterNoFromName('1.md')).toBeNull()
    expect(chapterNoFromName('0001-开局.md')).toBe(1)
    expect(chapterNoFromName('1—开局.md')).toBe(1)
    expect(chapterNoFromName('1 开局.md')).toBe(1)
  })

  it('形态二（document/tree.ts:84→105——先 stripMd 再判）：`1.md` 剥名后 → 1', () => {
    expect(chapterNoFromName('1')).toBe(1)
    expect(chapterNoFromName('0001-开局')).toBe(1)
    expect(chapterNoFromName('1—开局')).toBe(1)
  })

  it('分裂现状锚定：同一文件名 `1.md` 树侧认得（=1）、消费侧不认（=null）', () => {
    expect(treeShape('1.md')).toBe(1)
    expect(consumerShape('1.md')).toBeNull()
    // 分裂点恰在扩展名：带分隔符的宽容命名两侧口径一致（分裂只在裸数字 + .md 形态）
    expect(treeShape('1-开局.md')).toBe(consumerShape('1-开局.md'))
    expect(treeShape('5—标题.md')).toBe(consumerShape('5—标题.md'))
    expect(treeShape('1.md')).not.toBe(consumerShape('1.md'))
  })
})
