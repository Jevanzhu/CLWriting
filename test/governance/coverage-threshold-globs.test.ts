/**
 * 覆盖阈值桶 glob 守护：vitest coverage thresholds 的每个 glob 键
 * 必须仍匹配 ≥1 个入口文件。glob 失配（目录重构/拼错/brace 展开漂移）时 v8 provider
 * 对空桶不报错——阈值门静默失效，防回退承诺落空。
 *
 * 单一数据源：桶清单与数值住 vitest.coverage-buckets.ts，配置与本测试同源消费——
 * 不再有「配置改了测试抄本没改」的漂移面；本测试守 glob 命中、桶外文件与数值形状。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  COVERAGE_THRESHOLDS,
  type CoverageThreshold,
} from '../../vitest.coverage-buckets.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
// picomatch 无 @types——createRequire 取运行时实现并收窄签名
const require_ = createRequire(import.meta.url)
const picomatch = require_('picomatch') as (g: string | string[]) => (s: string) => boolean

/** 桶清单与数值单一数据源 = vitest.coverage-buckets.ts（配置与守护门同源，无抄本）。 */
const EXPECTED_THRESHOLDS = COVERAGE_THRESHOLDS
const EXPECTED_GLOBS = Object.keys(COVERAGE_THRESHOLDS)
const INCLUDE = [...COVERAGE_INCLUDE]
const EXCLUDE = [...COVERAGE_EXCLUDE]

/** 递归收集 src 下 coverage 入口文件——include 扩入
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

describe('coverage 阈值桶 glob 守护', () => {
  it('阈值桶数值为 0-100 整数且每桶至少一项指标门', () => {
    const problems: string[] = []
    for (const [glob, values] of Object.entries(EXPECTED_THRESHOLDS)) {
      const keys = Object.keys(values)
      if (keys.length === 0) problems.push(`${glob}: 无任何指标门`)
      for (const [metric, v] of Object.entries(values)) {
        if (!Number.isInteger(v) || v < 0 || v > 100) problems.push(`${glob}.${metric}: ${v} 非 0-100 整数`)
      }
    }
    expect(problems, '\n' + problems.join('\n')).toEqual([])
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

  // 反向守卫——include∩¬exclude
  // 全集逐文件至少命中一个阈值桶。vitest 的 per-glob thresholds 语义 = 不匹配任何键的
  // 文件不做阈值检查（进报告但零守护）：前端新增 utils/ 等纯 TS 子目录即静默逃出全部门
  //（stores/composables/api 历次「收暗区」的同型回潮，此前无机器门阻止）。桶外文件
  // 点名报红，指引同步 vitest.config.ts 桶键 + 本测试 EXPECTED_GLOBS。
  it('include∩¬exclude 的每个文件至少命中一个阈值桶（桶外文件 = 零守护点名）', () => {
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

// ── 视图层单测覆盖桶（0/0 显影桶的回收条件机器化）──────────────────────────
// views/pages 的 0/0 显影桶登记的是「e2e 自管、单测不执行」的文件。原回收条件只是配置
// 注释里的一句话（「views 出现真单测面时按实测基线立门」），无机器守护：某视图被单测
// 真 import/挂载后，它的覆盖质量仍可能停在零守护的 0/0 桶里。本组把该条件双向核对：
//  正向：被单测 import 的 views/pages 文件必须落至少一个「已登记指标全非零」的桶；
//  反向：只匹配 views/pages 的非零桶，其名单文件必须仍在单测 import 面里（防登记僵尸）。
// 「真 import」口径 = 静态 `from '<spec>'` 与动态 `import('<spec>')`（剥注释后扫）：
// vi.mock 无 from、只替换模块不执行 SFC，不计入；解析到仓库内的视图文件才计数。
const VIEWS_PAGES_ENTRY_RE = /^src\/studio\/web-next\/src\/(?:pages|views)\/.+\.vue$/

/** 递归收集 test/ 下全部 .test.ts（单测 import 面只在该命名空间里） */
function listTestFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || name === 'node_modules') continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) listTestFiles(fp, out)
    else if (name.endsWith('.test.ts')) out.push(fp)
  }
  return out
}

/** 去注释（防注释里的示例 import 被当真实引用；字符串面保留，路径字面量不受损） */
function stripTestComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 单测真 import 的 views/pages 文件集（仓库相对路径，去重） */
function unitImportedViews(): Set<string> {
  const out = new Set<string>()
  const specRe = /from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g
  for (const fp of listTestFiles(join(root, 'test'))) {
    const src = stripTestComments(readFileSync(fp, 'utf-8'))
    for (const m of src.matchAll(specRe)) {
      const spec = m[1] ?? m[2]
      if (!spec) continue
      const abs = resolve(dirname(fp), spec)
      const rel = relative(root, abs).replaceAll('\\', '/')
      if (VIEWS_PAGES_ENTRY_RE.test(rel) && existsSync(abs)) out.add(rel)
    }
  }
  return out
}

/** coverage 入口文件集（include∩¬exclude；与上方两守卫同口径） */
function coverageEntryFiles(): string[] {
  const includeMatcher = picomatch(INCLUDE)
  const excludeMatcher = picomatch(EXCLUDE)
  return listCoverageEntries(join(root, 'src'))
    .map((fp) => relative(root, fp).replaceAll('\\', '/'))
    .filter((rel) => includeMatcher(rel) && !excludeMatcher(rel))
}

/** 已登记指标「全非零」的桶键（0/0 显影桶与缺值桶不算——前者语义即零守护） */
function nonzeroBucketKeys(values: Record<string, CoverageThreshold>): string[] {
  return Object.entries(values)
    .filter(([, v]) => Object.keys(v).length > 0 && Object.values(v).every((n) => n !== undefined && n > 0))
    .map(([k]) => k)
}

describe('视图层单测覆盖桶（0/0 显影桶的机器化回收条件）', () => {
  it('被单测 import 的 views/pages 文件必须落非零覆盖率桶（新增单测面不同步桶即红）', () => {
    const nonzero = nonzeroBucketKeys(EXPECTED_THRESHOLDS)
    const imported = [...unitImportedViews()].sort()
    expect(imported.length, '未扫到任何被单测 import 的视图文件——扫描口径或目录结构漂移').toBeGreaterThan(0)

    const missing = imported.filter((f) => !nonzero.some((g) => picomatch(g)(f)))
    expect(
      missing,
      '以下 views/pages 文件已被单测真 import/挂载，却只落 0/0 显影桶（无阈值守护）。' +
        '回收动作：按本地 v8 窄跑实测 −2pp 在 vitest.config.ts 立非零桶并同步本测试 ' +
        'EXPECTED 清单；若该文件其实不由单测执行（仅 import 边），改为在测试里 mock 引用:\n' +
        missing.join('\n'),
    ).toEqual([])
  })

  it('非零视图桶的名单必须仍在单测 import 面里（回收登记不得变僵尸）', () => {
    const values = EXPECTED_THRESHOLDS
    const files = coverageEntryFiles()
    const imported = unitImportedViews()

    const stale: string[] = []
    for (const glob of nonzeroBucketKeys(values)) {
      // 注：picomatch 的 matcher 第二参为 returnObject，直接当 filter 谓词会命中一切
      //（index≥1 真值时总返回结果对象）——必须经箭头收敛为纯布尔
      const matched = files.filter((f) => picomatch(glob)(f))
      // 只管「视图专属桶」（匹配集非空且全落 views/pages）——聚合/域桶另有反向守卫兜底
      if (matched.length === 0 || !matched.every((f) => VIEWS_PAGES_ENTRY_RE.test(f))) continue
      for (const f of matched) if (!imported.has(f)) stale.push(`${glob} → ${f}`)
    }
    expect(
      stale,
      '非零视图桶名单里出现无单测 import 面的文件（登记已僵尸：单测面被删后该文件靠阈值硬撑，' +
        'CI 覆盖率腿会先红且归因不清）。回收动作：从 vitest.config.ts 桶名单与 EXPECTED 清单移除:\n' +
        stale.join('\n'),
    ).toEqual([])
  })
})
