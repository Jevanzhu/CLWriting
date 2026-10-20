/**
 * 确定性嵌入桩（单源）。
 *
 * 由来：`stubEmbed` 在 20 个测试档里各写一份（其中 `test/rag/index.test.ts` 单档 6 份），
 * 五种不同行为混用同一函数名——多数是「按首字符码点生成确定性三维向量」，另有 `[1,0,0]`
 * 正交向量、`[0.1,0.2,0.3]` 常量、按维度参数化等专用形态。同名不同义使「这个桩产出什么
 * 向量」必须逐档读实现才能确认，而向量值直接决定召回/去重/截断断言的语义。
 *
 * 收编口径（与 `wait-for.ts` 同款：只收同一语义，不收同名）：
 *   - 本文件的 `stubEmbed` = **唯一收编行为**：同文本必得同向量（可判等）、不同文本可区分
 *     （可按文本定位命中）。原 16 份逐字或仅差临时变量的实现都归此。
 *   - 专用向量形态仍留各档本地定义并各自具名（`[1,0,0]` 等）——它们的**值就是断言前提**，
 *     收编会改测试语义。判据见 `test/helpers/embed.test.ts`。
 *
 * 语义约定：非空 `texts` 逐段映射；空数组返回空数组（与服务端 `embed` 的空入参早退同形）。
 */
import type { EmbedResult } from '../../src/rag/embed.js'

/** 按首字符码点生成确定性三维单位化向量（同文本恒同向量）。 */
export function stubEmbed(_endpoint: string, _model: string, _key: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((text) => {
      const code = text.charCodeAt(0) || 1
      const norm = 1 / (code + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

/**
 * 按首字符码点生成确定性 `dim` 维向量（维度与 `rag` 库登记的 embedding 维度对齐用）。
 *
 * 与 `stubEmbed` 分开而不是加可选参数：调用方要的是「向量维度可控」这一不同能力，
 * 把它塞进同一个签名会让「维度对不对」在调用点看不出来。
 */
export function stubEmbedOfDim(
  dim: number,
): (_e: string, _m: string, _k: string, texts: string[]) => Promise<EmbedResult> {
  return (_e, _m, _k, texts) => Promise.resolve(texts.map(() => Array.from({ length: dim }, (_, d) => 0.1 * (d + 1))))
}
