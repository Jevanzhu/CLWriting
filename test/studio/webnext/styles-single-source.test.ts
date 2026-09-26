/**
 * R0916-7-P3-26（0916-7 批）源码扫描回归：样式单源两道闸（防复活锚）。
 *
 * ① `.spin` 旋转——收敛前全库 8 处定义（styles/utilities.css 一份 + 7 个组件/视图内
 *    各一份），时长 0.8s / 0.9s / 1s 三档；同一旋转动作三档时长本无依据。收敛后
 *    animation 定义点唯一在 styles/utilities.css，组件内只可留颜色/尺寸覆盖
 *    （OnboardStepPanel 的强调色即此合法形态），不得再写 .spin 的 animation，也不得
 *    在别处新造异档（.save-btn-spin / .ai-btn-spin 是另名类，同受「全库同档」约束）。
 *
 * ② `--text-warning` 回退值——token 在 tokens.css 浅/暗两档均已定义，此前两处回退值
 *    互不同（StartupNoticeBanner 的 #d4a72c 与 WbDraftCard 的 #b8860b）且与 token 三方
 *    不一致；回退值只会掩盖拼写错误、让失配静默，全库清零。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src/studio/web-next/src'
const UTILITIES = 'styles/utilities.css'

/** 收集 web-next src 下全部 .vue/.css 源文件，返回相对 SRC 的 posix 路径。 */
function collectFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full))
      continue
    }
    if (/\.(vue|css)$/.test(name))
      out.push(
        full
          .slice(SRC.length + 1)
          .split('\\')
          .join('/'),
      )
    else if (name === 'main.ts') out.push(name)
  }
  return out
}

const read = (rel: string): string => readFileSync(`${SRC}/${rel}`, 'utf-8')
/** 去注释再解析：头注/说明注释里出现的 `.spin` 字样不得被当成选择器文本。 */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const readRules = (rel: string): string => stripComments(read(rel))

/** 抽出源码里全部规则块（选择器文本 + 声明体；@media 等嵌套块的内层规则照常命中）。 */
function ruleBlocks(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!, body: m[2]! })
  }
  return out
}

const files = collectFiles()

describe('R0916-7-P3-26: .spin 旋转动画单源', () => {
  it('全库只有 utilities.css 一处 .spin 规则带 animation（组件内只可留颜色/尺寸覆盖）', () => {
    const definitions = files.filter((rel) =>
      ruleBlocks(readRules(rel)).some(
        // 选择器含独立类 .spin（`.` + spin，且后不接词/连字符——.save-btn-spin 不算）
        ({ selector, body }) => /\.spin(?![\w-])/.test(selector) && /animation/.test(body),
      ),
    )
    expect(definitions).toEqual([UTILITIES])
  })

  it('utilities.css 的 .spin 声明 0.9s（众数档定档处）', () => {
    const blocks = ruleBlocks(readRules(UTILITIES)).filter(({ selector }) => /\.spin(?![\w-])/.test(selector))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body.replace(/\s+/g, ' ').trim()).toBe('animation: clw-spin 0.9s linear infinite;')
  })

  it('全库 clw-spin 动画时长同档（异档 0.8s/1s 不得再出现）', () => {
    const durations = new Set<string>()
    for (const rel of files) {
      for (const m of read(rel).matchAll(/animation(-name)?\s*:\s*([^;]+);/g)) {
        const decl = m[2]!
        if (!decl.includes('clw-spin')) continue
        const dur = decl.match(/(\d+(?:\.\d+)?)s/)
        if (dur) durations.add(dur[0])
      }
    }
    expect([...durations]).toEqual(['0.9s'])
  })

  it('utilities.css 由 main.ts 全局装载（单源得其实效）', () => {
    expect(read('main.ts')).toContain("import './styles/utilities.css'")
  })
})

describe('R0916-7-P3-26: --text-warning 不留回退值', () => {
  it('tokens.css 浅/暗两档均定义 --text-warning', () => {
    const tokens = read('styles/tokens.css')
    const defs = tokens.match(/--text-warning\s*:\s*#[0-9a-fA-F]{3,8}/g) ?? []
    expect(defs.length).toBeGreaterThanOrEqual(2)
  })

  it('全库无 var(--text-warning, <回退值>) 形态', () => {
    const withFallback = files.filter((rel) => /--text-warning\s*,/.test(read(rel)))
    expect(withFallback).toEqual([])
  })
})
