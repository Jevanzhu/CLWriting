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
  // R0916-6-P3-12（2026-09-16 全库源码重评五轮修复批）：metrics/driver/review 三小域
  // 域级子桶（主池化桶稀释收口；阈值取保守防回退档的缘由见 vitest.config.ts 同锚注）
  'src/metrics/**',
  'src/driver/**',
  'src/review/**',
  // 0918独立重评修复批（G001）：15 个后端域域级子桶（此前仅落主池化桶 ~89% 均值；
  // 阈值 = 2026-09-18 全量 coverage-summary 实测 −2pp，观测明细见 vitest.config.ts 同锚注）
  'src/cache/**',
  'src/check/**',
  'src/desktop/**',
  'src/document/**',
  'src/export/**',
  'src/format/**',
  'src/fs/**',
  'src/git/**',
  'src/install/**',
  'src/knowledge/**',
  'src/learn/**',
  'src/log/**',
  'src/process/**',
  'src/rag/**',
  'src/state/**',
  'src/studio/web-next/src/api/**',
  // 重评-2（全库代码重评审 2026-09-05）：聚合桶扩面收编 components/types 下仅有的
  // 非 SFC 纯 TS 运行时文件（settings-context.ts / theme.ts），沿 R62-23 阈值不变先例
  // 0918独立重评修复批（G003）：include 扩入 .vue 后再收暗区——views/pages/根 App.vue
  // 的 SFC 并入聚合桶（glob 扩 pages,views + 根层 *.vue 键单列自定地板 96/62；
  // 聚合桶阈值维持 43/81，.vue 计入后扩面口径新观测 L 81.42 / B 83.81 未低于现地板
  // 未触发重定，缘由见 vitest.config.ts 同锚注）
  // RC 全项目重审（GLM-5.3，2026-09-20）P2-5：views/pages 自聚合桶拆出——单测恒 mock、
  // 真实脚本仅 e2e 驱动（不回流 v8 覆盖），0% 视图在聚合均值里对门不可见；显影桶 0/0
  // 登记「e2e 自管」边界，聚合桶 glob 收窄（80/66 门不放松），缘由见 vitest.config.ts 同锚注
  'src/studio/web-next/src/{components,composables,editor,shared,stores,types}/**',
  'src/studio/web-next/src/{pages,views}/**',
  'src/studio/web-next/src/*.vue',
  // R29-12（二十九轮批 F）：stores 单列域级子桶（基线 −2pp → 89/88，与聚合桶并存叠加）
  'src/studio/web-next/src/stores/**',
  // R0910-W（2026-09-10）：composables 单列域级子桶——聚合桶 lines 门仅 43，远低于本域
  // 实测 84.13，域内腰斩在聚合均值里对门不可见；阈值 = 实测基线 −2pp 向下取整（82/81）
  'src/studio/web-next/src/composables/**',
]
/** 各桶排除时留下注释标记便于人读；include/exclude 口径抄自 vitest.config.ts */
// 0918独立重评修复批（G003）：INCLUDE 抄本同步扩 'src/studio/web-next/src/**/*.vue'
//（配置侧 include 扩 SFC 入核算，抄本保持口径一致；下方收集函数随动收 .vue）
const INCLUDE = ['src/**/*.ts', 'src/studio/web-next/src/**/*.vue']
// R43-27（四十三轮）：EXCLUDE 抄本补 'src/studio/web-next/vite.config.ts'——与
// vitest.config.ts coverage.exclude（R33D-36 入列）对齐，消除抄本与配置的口径漂移
// 重评-2（全库代码重评审 2026-09-05）：原 '{components,types}/**' 整目录抄本收窄为
// 点名 'src/studio/web-next/src/types/tree.ts'（纯类型声明零运行时语句）——两目录下的
// 非 SFC 运行时文件（settings-context.ts/theme.ts）不再排除，抄本与配置同步收窄
const EXCLUDE = [
  'src/**/*.d.ts',
  // R0911-G-P2-2（2026-09-11 全量重评 GLM-5.3 修复批）：web-next 子包 node_modules 里
  // 27 个第三方 .ts（@lezer/markdown、entities 等）会命中 include 'src/**/*.ts'——
  // 它们不属于任何阈值桶（零守护的合法形态），不排除会让下方反向守卫点名误报；
  // vitest.config.ts coverage.exclude 同步补 '**/node_modules/**'（抄本保持口径一致）
  '**/node_modules/**',
  'src/studio/web-next/vite.config.ts',
  'src/studio/web-next/src/types/tree.ts',
  'src/studio/web-next/src/{main,router}.ts',
]

/** 递归收集 src 下 coverage 入口文件——0918独立重评修复批（G003）：include 扩入
 * .vue 后收集面随动（.ts + .vue），空桶/反向外守卫两测试据此覆盖 SFC 入口集 */
function listCoverageEntries(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) out = out.concat(listCoverageEntries(fp))
    else if (name.endsWith('.ts') || name.endsWith('.vue')) out.push(fp)
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
    const files = listCoverageEntries(join(root, 'src'))
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

  // R0911-G-P2-2（2026-09-11 全量重评 GLM-5.3 修复批）：反向守卫——include∩¬exclude
  // 全集逐文件至少命中一个阈值桶。vitest 的 per-glob thresholds 语义 = 不匹配任何键的
  // 文件不做阈值检查（进报告但零守护）：前端新增 utils/ 等纯 TS 子目录即静默逃出全部门
  //（stores/composables/api 历次「收暗区」的同型回潮，此前无机器门阻止）。桶外文件
  // 点名报红，指引同步 vitest.config.ts 桶键 + 本测试 EXPECTED_GLOBS。
  it('R0911-G-P2-2：include∩¬exclude 的每个文件至少命中一个阈值桶（桶外文件 = 零守护点名）', () => {
    const includeMatcher = picomatch(INCLUDE)
    const excludeMatcher = picomatch(EXCLUDE)
    const files = listCoverageEntries(join(root, 'src'))
      .map((fp) => relative(root, fp).replaceAll('\\', '/'))
      .filter((rel) => includeMatcher(rel) && !excludeMatcher(rel))
    expect(files.length, 'coverage 入口集为空——include glob 或目录结构漂移').toBeGreaterThan(0)

    const outside = files.filter((rel) => !EXPECTED_GLOBS.some((g) => picomatch(g)(rel)))
    expect(
      outside,
      '以下文件不匹配任何阈值桶 glob（vitest 语义：不匹配任何键的文件不做阈值检查——' +
        '新增子目录须同步 vitest.config.ts 桶键与 EXPECTED_GLOBS，否则该文件零守护）:\n' +
        outside.join('\n'),
    ).toEqual([])
  })
})
