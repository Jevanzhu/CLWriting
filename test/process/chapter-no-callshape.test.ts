/**
 * R1010c-EN-P2-1（阶段 36 拍板落地，B 档单源扩集）：chapterNoFromName 调用形态对表。
 *
 * 沿革：单源扩集前 `1.md`（裸数字+.md）只在「先剥扩展名」的调用形态被认（tree
 * stripMd / health 取号下限 / finalizedChapterNumbers 双实现——B005 批自带剥），
 * 带全名直传的调用形态（summary:442,527 / leads:103 / foreshadow:574 /
 * finalize inferChapterFromName / draft-path 守卫）失明 → 同一磁盘文件名口径分裂。
 * 扩集入单源（isMdFileName 剥 .md 后再匹配）后全调用形态拉齐一致。本对表钉住
 * 「任一调用形态对裸数字名同判」——未来改正则或剥扩展逻辑漏其一，本表即红，
 * 防「修复只改一处漏其他」复发（沿 R1010c 原判据，方向由钉分裂翻为钉一致）。
 *
 * 选址说明（沿原选址）：被测现象是消费方调用形态的跨层契约（消费方对表），
 * test/process/ 已收同类消费侧回归（volume-chain-wide-name.test.ts）；
 * filename.test.ts 是消毒/提取模块自身的单元契约，不宜混入消费方对表。
 */
import { describe, expect, it } from 'vitest'
import { chapterNoFromName } from '../../src/format/filename.js'

/** 模拟 document/tree.ts 的调用形态：先剥 .md 再判（stripMd 等价：去尾部 .md） */
const treeShape = (fileName: string): number | null => chapterNoFromName(fileName.replace(/\.md$/i, ''))
/** 模拟 summary/leads/foreshadow/finalize/draft-path 的调用形态：全名直判 */
const consumerShape = (fileName: string): number | null => chapterNoFromName(fileName)

describe('R1010c-EN-P2-1：chapterNoFromName 调用形态对表（单源扩集后全形态一致）', () => {
  it('形态一（summary/leads/foreshadow/finalize/draft-path——全名直判）：`1.md` → 1（扩集后认）', () => {
    expect(chapterNoFromName('1.md')).toBe(1)
    expect(chapterNoFromName('0001-开局.md')).toBe(1)
    expect(chapterNoFromName('1—开局.md')).toBe(1)
    expect(chapterNoFromName('1 开局.md')).toBe(1)
  })

  it('形态二（document/tree.ts——先 stripMd 再判）：`1.md` 剥名后 → 1（与单源内剥叠加幂等）', () => {
    expect(chapterNoFromName('1')).toBe(1)
    expect(chapterNoFromName('0001-开局')).toBe(1)
    expect(chapterNoFromName('1—开局')).toBe(1)
  })

  it('统一口径锚定：同一文件名两种调用形态同判（扩集前分裂形态自此拉齐）', () => {
    expect(treeShape('1.md')).toBe(consumerShape('1.md'))
    expect(treeShape('1.md')).toBe(1)
    expect(consumerShape('1.md')).toBe(1)
    // 带分隔符的宽容命名两侧口径原本即一致（分裂只在裸数字 + .md 形态，已收口）
    expect(treeShape('1-开局.md')).toBe(consumerShape('1-开局.md'))
    expect(treeShape('5—标题.md')).toBe(consumerShape('5—标题.md'))
    // 消费方自带剥（tree 形态）与单源内剥叠加不改变结果——大写扩展名同幂等
    expect(treeShape('12.MD')).toBe(consumerShape('12.MD'))
    expect(consumerShape('12.MD')).toBe(12)
  })
})
