/**
 * R73-66（二十一轮批 E）回归：learn store commit 独立请求代。
 *
 * 修复前 commit() 只快照 reqGen 不推代——同代双 commit（并发/重入）守卫互相穿透，
 * 且全靠 harvest 推代兜底；未来任何旁路清列表不复位 committing 即穿透。修复后 commit
 * 自己推代（commitGen）：后一笔使前一笔迟到回填/finally 解锁全部作废；clear() 推
 * commitGen 作废在途 commit；在途遇 harvest 推代（reqGen 变）仍作废本笔回填（M-11
 * 原语义保留）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/learn', () => ({
  runLearn: vi.fn(),
  runLearnCommit: vi.fn(),
}))

import { runLearn, runLearnCommit } from '../../../src/studio/web-next/src/api/learn'
import { useLearnStore } from '../../../src/studio/web-next/src/stores/learn'

const learnMock = runLearn as ReturnType<typeof vi.fn>
const commitMock = runLearnCommit as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

async function seededPicks(): Promise<ReturnType<typeof useLearnStore>> {
  learnMock.mockResolvedValue({
    samples: [
      { 场景: 's', 正文: 'b1', 出处: 'c' },
      { 场景: 's', 正文: 'b2', 出处: 'c' },
    ],
    quotes: [],
  })
  const s = useLearnStore()
  await s.harvest('bookA')
  return s
}

describe('R73-66: commit 独立推代（同代双 commit 不再互相穿透）', () => {
  it('同批勾选重入双 commit：B 先归 → A 迟到成功回填被推代作废（不覆盖 B 的消息）', async () => {
    const s = await seededPicks()
    s.toggleSample('b1')
    let resolveA!: (v: { sampleFiles: string[]; quoteFiles: string[] }) => void
    let resolveB!: (v: { sampleFiles: string[]; quoteFiles: string[] }) => void
    commitMock
      .mockImplementationOnce(() => new Promise((r) => (resolveA = r))) // A
      .mockImplementationOnce(() => new Promise((r) => (resolveB = r))) // B（同批重入——B 启动时 A 未归，勾选未清）

    const pA = s.commit('bookA')
    const pB = s.commit('bookA') // 程序性重入（绕过 UI committing 锁的旁路场景）

    // B 先落：入库项（b1）移除 + 成功消息（b2 未勾选仍在列表）
    resolveB({ sampleFiles: ['f1.md'], quoteFiles: [] })
    await pB
    expect(s.commitMessage).toContain('已收录')
    expect(s.samples.map((x) => x.正文)).toEqual(['b2'])

    // A 迟到落（注意 A 与 B 同批，A 若穿透会用不同口径改写消息）：修复点——被推代作废
    resolveA({ sampleFiles: ['f1.md', 'f9.md'], quoteFiles: ['g9'] })
    await pA
    expect(s.commitMessage).toBe('已收录 1 章样章、0 条金句 → 文风/样章库。') // 仍是 B 的口径
    expect(s.samples.map((x) => x.正文)).toEqual(['b2']) // A 的列表过滤同样不落地
    expect(s.committing).toBe(false)
  })

  it('commit A 迟到失败同样不覆盖新 commit 的消息', async () => {
    const s = await seededPicks()
    s.toggleSample('b1')
    let rejectA!: (e: Error) => void
    let resolveB!: (v: { sampleFiles: string[]; quoteFiles: string[] }) => void
    commitMock
      .mockImplementationOnce(
        () =>
          new Promise<never>((_, rej) => {
            rejectA = rej
          }),
      )
      .mockImplementationOnce(() => new Promise((r) => (resolveB = r)))

    const pA = s.commit('bookA')
    const pB = s.commit('bookA') // 第二笔推代
    resolveB({ sampleFiles: ['f1.md'], quoteFiles: [] })
    await pB
    expect(s.commitMessage).toContain('已收录')

    rejectA(new Error('迟到失败'))
    await pA
    expect(s.commitMessage).toContain('已收录') // 修复点：不被 A 的失败消息覆盖
    expect(s.committing).toBe(false)
  })

  it('clear() 在途 commit → 迟到成功回填不落、committing 复位（按钮不卡）', async () => {
    const s = await seededPicks()
    s.toggleSample('b1')
    let resolveA!: (v: { sampleFiles: string[]; quoteFiles: string[] }) => void
    commitMock.mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
    const p = s.commit('bookA')
    expect(s.committing).toBe(true)

    s.clear() // 切书清场：commitGen 推进
    expect(s.committing).toBe(false) // clear 直接复位（R-1/Y-32 同款）

    resolveA({ sampleFiles: ['f1.md'], quoteFiles: [] })
    await p
    expect(s.commitMessage).toBeNull() // 修复点：迟到回填被推代挡住
    expect(s.committing).toBe(false)
  })

  it('M-11 语义保留：commit 在途遇 harvest 推代（reqGen 变）→ 回填仍作废', async () => {
    const s = await seededPicks()
    s.toggleSample('b1')
    let resolveCommit!: (v: { sampleFiles: string[]; quoteFiles: string[] }) => void
    commitMock.mockImplementationOnce(() => new Promise((r) => (resolveCommit = r)))
    const p = s.commit('bookA')

    // 入库在途时新书收割（reqGen 推代）
    learnMock.mockResolvedValue({ samples: [{ 场景: 'B', 正文: 'B 正文', 出处: 'c' }], quotes: [] })
    await s.harvest('bookB')
    expect(s.samples[0]!.正文).toBe('B 正文')

    resolveCommit({ sampleFiles: ['f1.md'], quoteFiles: [] })
    await p
    expect(s.commitMessage).toBeNull() // A 书提示不落 B 书收割视图（原 M-11 不回归）
    expect(s.samples[0]!.正文).toBe('B 正文') // B 候选不被 A 的列表过滤误删
  })
})
