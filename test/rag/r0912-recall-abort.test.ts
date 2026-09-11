/**
 * R0912-4（2026-09-11 修复批）回归：RAG 召回随编排中断。
 *
 * 背景：materials.ts 调 recallDetailed 无 signal——备料召回的 embed 网络往返（≤30s）
 * 与流式打分不随编排中断收口，编排中断后分钟级白烧。修复：recallDetailed 加可选
 * `opts?: { signal?: AbortSignal }`（向后兼容，旧调用零变更），在入口 / embed 网络往返
 * 前后 / 流式打分循环（store.streamChunkScores 行级检查点）检查 aborted → 抛
 * 「RAG 召回已中断」（与 embed 失败同走 throw 形态——本函数既有错误形态，调用方降级）。
 *
 * 断言面：
 * - signal 预先 aborted → 快速中断，embed 零发起；
 * - embed 往返窗口内 abort → 尽快中断，不进入全表扫描（若扫描发生会 resolve 而非 reject）；
 * - store.streamChunkScores 预先 aborted → 立即抛、零产出；无 signal 产出口径不变；
 * - 旧调用方（不传 opts）行为不变（正常 resolve）。
 */
import { test, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { openRagDb, closeRagDb, storeChunk, setRagMeta, streamChunkScores } from '../../src/rag/store.js'
import { recallDetailed } from '../../src/rag/index.js'
import type { RagConfig } from '../../src/rag/config.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 造一本带 2 块 3 维向量的 rag.db（模型 m1，维度登记一致） */
function makeRagBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r0912-recall-abort-'))
  const db = openRagDb(root)
  try {
    storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: new Float32Array([0.1, 0.2, 0.3]), model: 'm1' })
    storeChunk(db, { 章号: 2, start_offset: 0, end_offset: 10, embedding: new Float32Array([0.3, 0.2, 0.1]), model: 'm1' })
    setRagMeta(db, 'embedding_model', 'm1')
    setRagMeta(db, 'embedding_dim', '3')
  } finally {
    closeRagDb(db)
  }
  return root
}

const CFG: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'm1' }
const embedOk = (): Promise<EmbedResult> => Promise.resolve([[0.1, 0.2, 0.3]])

test('R0912-4: signal 预先 aborted → 快速中断，不发起 embed', async () => {
  const root = makeRagBook()
  let embedCalls = 0
  const embedSpy = (): Promise<EmbedResult> => {
    embedCalls++
    return embedOk()
  }
  const ctrl = new AbortController()
  ctrl.abort()
  await expect(
    recallDetailed(root, CFG, 'key', '查询', 5, embedSpy, 100000, { signal: ctrl.signal }),
  ).rejects.toThrow('RAG 召回已中断')
  expect(embedCalls).toBe(0) // 中断先于网络：embed 一次都没打
})

test('R0912-4: embed 往返窗口内 abort → 尽快中断，不进入全表扫描', async () => {
  const root = makeRagBook()
  const ctrl = new AbortController()
  const embedAborting = (): Promise<EmbedResult> => {
    // 网络往返窗口内编排中断（返回向量前后信号已置位）
    ctrl.abort()
    return embedOk()
  }
  // 若检查点缺失，召回会继续扫描并 resolve——reject 本身即「未扫描」的确定性判据
  await expect(
    recallDetailed(root, CFG, 'key', '查询', 5, embedAborting, 100000, { signal: ctrl.signal }),
  ).rejects.toThrow('RAG 召回已中断')
})

test('R0912-4: 旧调用方（不传 opts）行为不变——正常 resolve（向后兼容）', async () => {
  const root = makeRagBook()
  const r = await recallDetailed(root, CFG, 'key', '查询', 5, embedOk, 100000)
  expect(Array.isArray(r.hits)).toBe(true)
  expect(r.truncated).toBe(false)
  expect(r.totalBlocks).toBe(2) // 流式打分照常跑完（2 块全产出）
})

test('R0912-4: store.streamChunkScores——预先 aborted 立即中断零产出；无 signal 产出口径不变', () => {
  const root = makeRagBook()
  const db = openRagDb(root)
  try {
    const ctrl = new AbortController()
    ctrl.abort()
    expect(() => streamChunkScores(db, new Float32Array([0.1, 0.2, 0.3]), 'm1', 100, ctrl.signal)).toThrow(
      'RAG 召回已中断',
    )
    const r = streamChunkScores(db, new Float32Array([0.1, 0.2, 0.3]), 'm1', 100)
    expect(r.produced).toBe(2)
    expect(r.rows).toHaveLength(2)
  } finally {
    closeRagDb(db)
  }
})
