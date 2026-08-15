/**
 * 目录生成管线双向校验（批次 D1，学 cherry catalog-source-sync / catalog-hand-edit-check）。
 *
 * cherry 需要两个 CI job：其 sync 测试不敢 fetch 上游（flaky），只能离线算「源能决定
 * 的事实」；我们的生成是 model-quirks.ts 的**纯函数**、零网络——一个确定性重算测试
 * 同时覆盖两个方向：手改 catalog.gen.ts（重算 ≠ 生成物）红；改 model-quirks.ts 未
 * 重新 generate（重算 ≠ 生成物）红。npm test 每跑必核。
 */
import { describe, expect, it } from 'vitest'
import { buildModelCatalog, contentVersionOf, stableStringify } from '../../../src/ai/provider/catalog.js'
import { MODEL_CATALOG, MODEL_CATALOG_VERSION } from '../../../src/ai/provider/catalog.gen.js'

describe('D1 目录同步校验', () => {
  it('生成物与源码重算一致（手改生成物 / 改源未重生成 → 失配红）', () => {
    expect(buildModelCatalog()).toEqual(MODEL_CATALOG)
  })

  it('contentVersion = 目录体内容哈希', () => {
    expect(contentVersionOf(MODEL_CATALOG)).toBe(MODEL_CATALOG_VERSION)
  })

  it('目录覆盖版本敏感系列（glm/kimi 双版本入册）', () => {
    const models = MODEL_CATALOG.rows.map((r) => r.model)
    expect(models).toContain('glm-5.2')
    expect(models).toContain('glm-4.6')
    expect(models).toContain('kimi-k3')
    expect(models).toContain('kimi-k2')
  })
})

describe('stableStringify 稳定序列化', () => {
  it('键序无关：同内容不同插入序 → 同串同哈希', () => {
    const a = { z: 1, a: { y: [1, { b: 2, a: 1 }], x: 's' } }
    const b = { a: { x: 's', y: [1, { a: 1, b: 2 }] }, z: 1 }
    expect(stableStringify(a)).toBe(stableStringify(b))
    expect(contentVersionOf(a)).toBe(contentVersionOf(b))
  })

  it('undefined 字段不入串（可选字段缺席 ≠ 显式 undefined）', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })

  it('内容扰动 → 版本变（同日重生成的日期戳坑不存在）', () => {
    expect(contentVersionOf({ a: 1 })).not.toBe(contentVersionOf({ a: 2 }))
  })
})
