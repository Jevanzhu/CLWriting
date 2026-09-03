/**
 * R65-58（F-2）覆盖阈值桶 glob 守护：vitest coverage thresholds 的每个 glob 键
 * 必须仍匹配 ≥1 个入口文件。glob 失配（目录重构/拼错/brace 展开漂移）时 v8 provider
 * 对空桶不报错——阈值门静默失效，防回退承诺落空。
 *
 * 双向锁：EXPECTED 桶清单 ↔ vitest.config.ts 文本互为镜像——配置删桶/改名红，
 * 新增桶不同步本测试也红（提醒同步，避免守护面失明）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../../', import.meta.url))
// picomatch 无 @types——createRequire 取运行时实现并收窄签名
const require_ = createRequire(import.meta.url)
const picomatch = require_('picomatch') as (g: string | string[]) => (s: string) => boolean

/** 与 vitest.config.ts thresholds 键保持同序（双向锁基准） */
const EXPECTED_GLOBS = [
  'src/{!(studio),studio/!(web-next)}/**',
  // R66-41（十四轮）：主桶上叠的三个域级子桶（ai/events/studio-server，基线 −2pp）
  'src/ai/**',
  'src/events/**',
  'src/studio/server/**',
  'src/studio/web-next/src/api/**',
  'src/studio/web-next/src/{composables,editor,shared,stores}/**',
  // R29-12（二十九轮批 F）：stores 单列域级子桶（基线 −2pp → 89/88，与聚合桶并存叠加）
  'src/studio/web-next/src/stores/**',
]
/** 各桶排除时留下注释标记便于人读；include/exclude 口径抄自 vitest.config.ts */
const INCLUDE = ['src/**/*.ts']
// R43-27（四十三轮）：EXCLUDE 抄本补 'src/studio/web-next/vite.config.ts'——与
// vitest.config.ts coverage.exclude（R33D-36 入列）对齐，消除抄本与配置的口径漂移
const EXCLUDE = [
  'src/**/*.d.ts',
  'src/studio/web-next/vite.config.ts',
  'src/studio/web-next/src/{components,types}/**',
  'src/studio/web-next/src/{main,router}.ts',
]

/** 递归收集 src 下 .ts 文件（.vue 不入口径——coverage include 仅收 .ts） */
function listSrcTs(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) out = out.concat(listSrcTs(fp))
    else if (name.endsWith('.ts')) out.push(fp)
  }
  return out
}

/**
 * 配置侧阈值桶键提取（R35-45：缩进宽松 `[ \t]*`——此前锚定 8 空格，vitest.config.ts
 * 重排/缩进调整即静默零匹配，「配置新增桶未入 EXPECTED」方向单向降级（与 check-packaging
 * 同型教训）。键形 `'glob': {` 全文件唯 thresholds 块所有，宽松缩进不引入误匹配面。
 */
function extractThresholdKeys(cfgText: string): string[] {
  return [...cfgText.matchAll(/^[ \t]*'([^']+)':\s*\{/gm)].map((m) => m[1]!)
}

describe('coverage 阈值桶 glob 守护（R65-58）', () => {
  it('EXPECTED 清单与 vitest.config.ts 的阈值桶双向一致', () => {
    const cfgText = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
    const drift: string[] = []
    for (const g of EXPECTED_GLOBS) {
      if (!cfgText.includes(`'${g}'`)) drift.push(`配置缺桶：${g}`)
    }
    // 配置侧多出的桶（thresholds 块的键行，缩进宽松提取）
    for (const k of extractThresholdKeys(cfgText)) {
      if (k && !EXPECTED_GLOBS.includes(k)) drift.push(`配置新增桶未入 EXPECTED：${k}（请同步本测试）`)
    }
    expect(drift, '\n' + drift.join('\n')).toEqual([])
  })

  it('R35-45：配置整体重排（缩进变化）后键提取仍生效——门不随排版静默失效', () => {
    const cfgText = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
    // 整体 +6 空格重排（原锚定 8 空格的正则在此输入下恒零匹配 = 双向锁单侧失明）
    const reindented = cfgText
      .split('\n')
      .map((line) => (line.trim() === '' ? line : '      ' + line))
      .join('\n')
    expect(extractThresholdKeys(reindented)).toEqual(extractThresholdKeys(cfgText))
    // 重排后仍能取全 EXPECTED 全部桶（双向锁继续有效）
    expect(extractThresholdKeys(reindented)).toEqual(EXPECTED_GLOBS)
  })

  it('每个阈值桶 glob 至少命中 1 个入口文件（空桶 = 阈值门静默失效）', () => {
    const includeMatcher = picomatch(INCLUDE)
    const excludeMatcher = picomatch(EXCLUDE)
    const files = listSrcTs(join(root, 'src'))
      .map((fp) => relative(root, fp).replaceAll('\\', '/'))
      .filter((rel) => includeMatcher(rel) && !excludeMatcher(rel))
    expect(files.length, 'coverage 入口集为空——include glob 或目录结构漂移').toBeGreaterThan(0)

    const empties: string[] = []
    for (const key of EXPECTED_GLOBS) {
      if (!files.some(picomatch(key))) empties.push(key)
    }
    expect(
      empties,
      '以下阈值桶 glob 命中 0 个文件（v8 对空桶不报错，阈值门已静默失效——重构后须同步 vitest.config 桶键）:\n' +
        empties.join('\n'),
    ).toEqual([])
  })
})
