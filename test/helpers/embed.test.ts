/**
 * 嵌入桩单源的判据。
 *
 * 两件事要钉住：
 *   ①本文件导出的 `stubEmbed` 行为（同文本同向量 / 异文本可区分 / 空入参空出）——它是 15 处
 *     原实现收编后的唯一行为定义，行为改了等于十几档的用户同时改语义；
 *   ②**防复活**：canonical 实现不得再在别处本地声明。收编前 20 档各写一份、五种行为共用
 *     同一函数名，这类漂移肉眼不可见（`[1,0,0]` 与按首字符生成的三维向量都叫 stubEmbed）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './repo-root.js'
import { stubEmbed, stubEmbedOfDim } from './embed.js'

const TEST_ROOT = join(REPO_ROOT, 'test')
const HELPER = 'test/helpers/embed.ts'

/** test/ 下全部 .ts（排除 .d.ts 与 macOS 垃圾档）——判据面与仓库既有源码扫描门同口径。 */
function listTests(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) listTests(full, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('stubEmbed 行为定义', () => {
  it('同文本恒同向量（判等与去重断言的前提）', async () => {
    const a = await stubEmbed('e', 'm', 'k', ['雪夜'])
    const b = await stubEmbed('e', 'm', 'k', ['雪夜'])
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
  })

  it('异文本可区分（按文本定位命中的前提）', async () => {
    const vecs = await stubEmbed('e', 'm', 'k', ['雪夜', '旧约', '开篇'])
    expect(vecs).not.toBeNull()
    const keys = new Set((vecs ?? []).map((v) => v.join(',')))
    expect(keys.size).toBe(3)
  })

  it('三维且每维为正（归一化后落在 (0,1]，召回相似度计算不会出现零向量）', async () => {
    const vecs = (await stubEmbed('e', 'm', 'k', ['雪夜'])) ?? []
    expect(vecs[0]).toHaveLength(3)
    for (const v of vecs[0] ?? []) expect(v).toBeGreaterThan(0)
  })

  it('空入参返回空数组（与服务端 embed 的空入参早退同形）', async () => {
    expect(await stubEmbed('e', 'm', 'k', [])).toEqual([])
  })
})

describe('stubEmbedOfDim 维度可控', () => {
  it('产出维度等于入参，且每段同维', async () => {
    const vecs = (await stubEmbedOfDim(8)('e', 'm', 'k', ['甲', '乙'])) ?? []
    expect(vecs).toHaveLength(2)
    for (const v of vecs) expect(v).toHaveLength(8)
  })
})

describe('防复活：canonical 实现不得再在别处本地声明', () => {
  /** canonical 实现的指纹：按首字符码点归一 + 固定三系数。 */
  const FINGERPRINTS = [/charCodeAt\(0\)\s*\|\|\s*1/, /\*\s*0\.5\s*,\s*norm\s*\*\s*0\.3/]

  /**
   * 取某处 `function stubEmbed(` 的**函数体**（花括号配对到闭合），而非整档正文。
   *
   * 按档整文匹配会误报：有的档在用例内联写了一段相似计算（如按批次序号改维度），
   * 那是该用例的局部语义，不是「又声明了一份 canonical 桩」。
   */
  function declaredStubBodies(source: string): string[] {
    const out: string[] = []
    const declRe = /function stubEmbed\s*\(/g
    for (const m of source.matchAll(declRe)) {
      const open = source.indexOf('{', m.index)
      if (open < 0) continue
      let depth = 0
      for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
          depth--
          if (depth === 0) {
            out.push(source.slice(open, i + 1))
            break
          }
        }
      }
    }
    return out
  }

  it('test/ 下无第二份 canonical 嵌入桩', () => {
    const offenders: string[] = []
    for (const full of listTests(TEST_ROOT)) {
      const rel = relative(REPO_ROOT, full).replaceAll('\\', '/')
      if (rel === HELPER) continue
      const bodies = declaredStubBodies(readFileSync(full, 'utf-8'))
      if (bodies.some((body) => FINGERPRINTS.every((re) => re.test(body)))) offenders.push(rel)
    }
    expect(
      offenders,
      '这些档又本地声明了 canonical 嵌入桩——请改用 test/helpers/embed.ts 的 stubEmbed；' +
        '专用向量形态（如 [1,0,0] 正交向量）请另具名，不要复用 stubEmbed 这个名字:\n' +
        offenders.join('\n'),
    ).toEqual([])
  })

  it('扫描面自证：helpers/embed.ts 自身命中指纹（否则上面的空清单是扫描空转）', () => {
    const bodies = declaredStubBodies(readFileSync(join(REPO_ROOT, HELPER), 'utf-8'))
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.some((body) => FINGERPRINTS.every((re) => re.test(body)))).toBe(true)
  })
})
