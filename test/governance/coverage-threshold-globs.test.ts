/**
 * 覆盖阈值桶 glob 守护：vitest coverage thresholds 的每个 glob 键
 * 必须仍匹配 ≥1 个入口文件。glob 失配（目录重构/拼错/brace 展开漂移）时 v8 provider
 * 对空桶不报错——阈值门静默失效，防回退承诺落空。
 *
 * 双向锁：EXPECTED 桶清单 ↔ vitest.config.ts 文本互为镜像——配置删桶/改名红，
 * 新增桶不同步本测试也红（提醒同步，避免守护面失明）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../../', import.meta.url))
// picomatch 无 @types——createRequire 取运行时实现并收窄签名
const require_ = createRequire(import.meta.url)
const picomatch = require_('picomatch') as (g: string | string[]) => (s: string) => boolean

/** 与 vitest.config.ts thresholds 键保持同序（双向锁基准） */
const EXPECTED_GLOBS = [
  'src/{!(studio),studio/!(web-next)}/**',
  // 主桶上叠的三个域级子桶（ai/events/studio-server，基线 −2pp）
  'src/ai/**',
  'src/events/**',
  'src/studio/server/**',
  // metrics/driver/review 三小域
  // 域级子桶（主池化桶稀释收口；阈值取保守防回退档的缘由见 vitest.config.ts 同锚注）
  'src/metrics/**',
  'src/driver/**',
  'src/review/**',
  // 15 个后端域域级子桶（此前仅落主池化桶 ~89% 均值；
  // 阈值 = 全量 coverage-summary 实测 −2pp，观测明细见 vitest.config.ts 同锚注）
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
  // 聚合桶扩面收编 components/types 下仅有的
  // 非 SFC 纯 TS 运行时文件（settings-context.ts / theme.ts），沿阈值不变先例
  // include 扩入 .vue 后再收暗区——views/pages/根 App.vue
  // 的 SFC 并入聚合桶（glob 扩 pages,views + 根层 *.vue 键单列自定地板 96/62；
  // 聚合桶阈值维持 43/81，.vue 计入后扩面口径新观测 L 81.42 / B 83.81 未低于现地板
  // 未触发重定，缘由见 vitest.config.ts 同锚注）
  // views/pages 自聚合桶拆出——单测恒 mock、
  // 真实脚本仅 e2e 驱动（不回流 v8 覆盖），0% 视图在聚合均值里对门不可见；显影桶 0/0
  // 登记「e2e 自管」边界，聚合桶 glob 收窄（80/66 门不放松），缘由见 vitest.config.ts 同锚注
  'src/studio/web-next/src/{components,composables,editor,shared,stores,types}/**',
  'src/studio/web-next/src/{pages,views}/**',
  // 视图层单测覆盖桶（0/0 显影桶的回收条件机器化）：被单测真 import/挂载的
  // 视图文件自「e2e 自管」名单划出、落非零门；本测试双向核对（新增单测面不同步即红、
  // 点名无单测面的文件同样红），阈值 = 本地 v8 窄跑池化实测 −2pp（缘由见 vitest.config.ts 同锚注）
  'src/studio/web-next/src/{pages,views}/{Book,Library,Shelf,AuditView,EditorView,OnboardView,OverviewView,RelationsView,StyleView,WorkbenchView}.vue',
  // 同族的窄桶延伸：Welcome/LearnView 补 dom 直测后自 0/0 显影桶划出、单列非零门
  //（并入上方 10 文件桶会被池化均值稀释，缘由见 vitest.config.ts 同锚注）
  'src/studio/web-next/src/{pages,views}/{Welcome,LearnView}.vue',
  'src/studio/web-next/src/*.vue',
  // stores 单列域级子桶（基线 −2pp → 89/88，与聚合桶并存叠加）
  'src/studio/web-next/src/stores/**',
  // composables 单列域级子桶——聚合桶 lines 门仅 43，远低于本域
  // 实测 84.13，域内腰斩在聚合均值里对门不可见；阈值 = 实测基线 −2pp 向下取整（82/81）
  'src/studio/web-next/src/composables/**',
  // 三处「池化均值稀释」显影桶——worker 入口只在 spawn 侧真线程
  // 被加载（主线程 import 零执行 → v8 0%），relations 两 SFC / useLibraryIpc 只被 pages
  // 与 e2e 消费（单测面恒 mock → 0%）：0% 文件在聚合桶 92%/80% 均值里对门不可见。
  // 本批补直测后立窄桶防回退，阈值 = 本地实测（跑相关三档的 v8 口径）−2pp 向下取整
  //（workers 与 useLibraryIpc S/B/F/L 100% → 98；relations SFC 池化 L 42.64 / B 49.49
  // → 40 / 47，缘由见 vitest.config.ts 同锚注）。桶键须与配置同序（双向锁基准）。
  'src/**/*-worker.ts',
  'src/studio/web-next/src/components/relations/*.vue',
  'src/studio/web-next/src/composables/useLibraryIpc.ts',
]

/**
 * P1-19（全项目源码二轮独立复审）：阈值数值全表快照——31 桶 × 4 指标的数值此前
 * 零机器守护（glob 键双向锁只锁键不锁值），配置里静默下调任一数值都不会红。
 * 本快照与 vitest.config.ts 文本逐值互锁：配置改值而快照未同步 → 红。
 *
 * 维护口径（合法重基线时）：按 vitest.config.ts 注释里的「实测 −2pp 向下取整」
 * 规则先算新值 → 同步本表（一处改两处）→ 配置注释同批更新。绿门只紧不松：
 * 向下调值须在批记/注释里留理由（razor 档等例外同配置注释口径）。
 * 缺省面：只登记了部分指标的桶（如 api 桶只有 L/B）按实际登记面锁定——快照缺项
 * = 配置出现该指标也红（见下「快照未登记指标」分支）。
 */
const EXPECTED_THRESHOLDS: Record<string, Record<string, number>> = {
  'src/{!(studio),studio/!(web-next)}/**': { statements: 89, branches: 83, functions: 95, lines: 92 },
  'src/ai/**': { statements: 91, branches: 85, functions: 95, lines: 93 },
  'src/events/**': { statements: 92, branches: 90, functions: 98, lines: 95 },
  'src/studio/server/**': { statements: 87, branches: 73, functions: 92, lines: 89 },
  'src/metrics/**': { statements: 91, branches: 80, functions: 95, lines: 97 },
  'src/driver/**': { statements: 95, branches: 92, functions: 98, lines: 97 },
  'src/review/**': { statements: 93, branches: 81, functions: 98, lines: 94 },
  'src/cache/**': { statements: 91, branches: 82, functions: 95, lines: 93 },
  'src/check/**': { statements: 93, branches: 88, functions: 98, lines: 94 },
  'src/desktop/**': { statements: 87, branches: 79, functions: 87, lines: 90 },
  'src/document/**': { statements: 90, branches: 83, functions: 94, lines: 91 },
  'src/export/**': { statements: 89, branches: 89, functions: 94, lines: 88 },
  'src/format/**': { statements: 94, branches: 92, functions: 97, lines: 95 },
  'src/fs/**': { statements: 93, branches: 89, functions: 98, lines: 93 },
  'src/git/**': { statements: 89, branches: 78, functions: 93, lines: 91 },
  'src/install/**': { statements: 88, branches: 83, functions: 98, lines: 92 },
  'src/knowledge/**': { statements: 90, branches: 86, functions: 98, lines: 90 },
  'src/learn/**': { statements: 94, branches: 71, functions: 93, lines: 94 },
  'src/log/**': { statements: 97, branches: 91, functions: 88, lines: 97 },
  'src/process/**': { statements: 88, branches: 81, functions: 97, lines: 92 },
  'src/rag/**': { statements: 91, branches: 88, functions: 94, lines: 93 },
  'src/state/**': { statements: 91, branches: 85, functions: 95, lines: 93 },
  'src/studio/web-next/src/api/**': { lines: 91, branches: 88 },
  'src/studio/web-next/src/{components,composables,editor,shared,stores,types}/**': { lines: 80, branches: 66 },
  'src/studio/web-next/src/{pages,views}/**': { lines: 0, branches: 0 },
  'src/studio/web-next/src/{pages,views}/{Book,Library,Shelf,AuditView,EditorView,OnboardView,OverviewView,RelationsView,StyleView,WorkbenchView}.vue':
    { lines: 78, branches: 59 },
  'src/studio/web-next/src/{pages,views}/{Welcome,LearnView}.vue': { lines: 98, branches: 98 },
  'src/studio/web-next/src/*.vue': { lines: 96, branches: 88 },
  'src/studio/web-next/src/stores/**': { lines: 93, branches: 83 },
  'src/studio/web-next/src/composables/**': { lines: 79, branches: 63 },
  'src/**/*-worker.ts': { statements: 98, branches: 98, functions: 98, lines: 98 },
  'src/studio/web-next/src/components/relations/*.vue': { lines: 40, branches: 47 },
  'src/studio/web-next/src/composables/useLibraryIpc.ts': { lines: 98, branches: 98 },
}
/** 各桶排除时留下注释标记便于人读；include/exclude 口径同 vitest.config.ts */
// INCLUDE 抄本同步扩 'src/studio/web-next/src/**/*.vue'
//（配置侧 include 扩 SFC 入核算，抄本保持口径一致；下方收集函数随动收 .vue）
const INCLUDE = ['src/**/*.ts', 'src/studio/web-next/src/**/*.vue']
// EXCLUDE 抄本补 'src/studio/web-next/vite.config.ts'——与
// vitest.config.ts coverage.exclude 对齐，消除抄本与配置的口径漂移
// 原 '{components,types}/**' 整目录抄本收窄为
// 点名 'src/studio/web-next/src/types/tree.ts'（纯类型声明零运行时语句）——两目录下的
// 非 SFC 运行时文件（settings-context.ts/theme.ts）不再排除，抄本与配置同步收窄
const EXCLUDE = [
  'src/**/*.d.ts',
  // web-next 子包 node_modules 里
  // 27 个第三方 .ts（@lezer/markdown、entities 等）会命中 include 'src/**/*.ts'——
  // 它们不属于任何阈值桶（零守护的合法形态），不排除会让下方反向守卫点名误报；
  // vitest.config.ts coverage.exclude 同步补 '**/node_modules/**'（抄本保持口径一致）
  '**/node_modules/**',
  'src/studio/web-next/vite.config.ts',
  'src/studio/web-next/src/types/tree.ts',
  'src/studio/web-next/src/{main,router}.ts',
]

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

/**
 * 配置侧阈值桶键提取（缩进宽松 `[ \t]*`——此前锚定 8 空格，vitest.config.ts
 * 重排/缩进调整即静默零匹配，「配置新增桶未入 EXPECTED」方向单向降级（与 check-packaging
 * 同型教训）。键形 `'glob': {` 全文件唯 thresholds 块所有，宽松缩进不引入误匹配面。
 */
function extractThresholdKeys(cfgText: string): string[] {
  return [...cfgText.matchAll(/^[ \t]*'([^']+)':\s*\{/gm)].map((m) => m[1]!)
}

/**
 * 配置侧阈值桶数值提取（P1-19）——单行 `'glob': { statements: N, ... },` 形态。
 * 数值须为裸整数（`(?![.\d])` 负向前瞻：`88.5` 不截成 88 静默通过，而是提取不到 →
 * 与快照比对报红）；缩进宽松同 extractThresholdKeys。
 */
function extractThresholdValues(cfgText: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const m of cfgText.matchAll(/^[ \t]*'([^']+)':\s*\{([^}]*)\}/gm)) {
    const values: Record<string, number> = {}
    for (const v of m[2]!.matchAll(/(statements|branches|functions|lines)\s*:\s*(\d+)(?![.\d])/g)) {
      values[v[1]!] = Number(v[2])
    }
    out[m[1]!] = values
  }
  return out
}

describe('coverage 阈值桶 glob 守护', () => {
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

  it('P1-19：阈值数值全表快照——配置逐值比对，静默下调/漏改快照即红', () => {
    const cfgText = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
    const actual = extractThresholdValues(cfgText)
    expect(Object.keys(actual).sort(), '配置侧桶键集与数值快照快照键集不一致').toEqual(
      Object.keys(EXPECTED_THRESHOLDS).sort(),
    )
    const drift: string[] = []
    for (const [glob, exp] of Object.entries(EXPECTED_THRESHOLDS)) {
      const got = actual[glob]
      if (!got) {
        drift.push(`${glob}: 配置缺失该桶数值`)
        continue
      }
      for (const [metric, want] of Object.entries(exp)) {
        if (!Number.isInteger(want) || want < 0 || want > 100) drift.push(`${glob}.${metric}: 快照值 ${want} 越界`)
        if (got[metric] !== want) drift.push(`${glob}.${metric}: 配置 ${got[metric] ?? '缺失'} ≠ 快照 ${want}`)
      }
      for (const metric of Object.keys(got)) {
        if (!(metric in exp)) drift.push(`${glob}.${metric}: 配置出现快照未登记指标（现值 ${got[metric]}）`)
        const v = got[metric]!
        if (!Number.isInteger(v) || v < 0 || v > 100) drift.push(`${glob}.${metric}: 配置值 ${v} 非 0-100 整数`)
      }
    }
    expect(
      drift,
      '\n阈值数值漂移（下调门须先按 −2pp 规则算值并同批更新快照与配置注释，不得静默下调）:\n' + drift.join('\n'),
    ).toEqual([])
  })

  it('配置整体重排（缩进变化）后键提取仍生效——门不随排版静默失效', () => {
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
function nonzeroBucketKeys(values: Record<string, Record<string, number>>): string[] {
  return Object.entries(values)
    .filter(([, v]) => Object.keys(v).length > 0 && Object.values(v).every((n) => n > 0))
    .map(([k]) => k)
}

describe('视图层单测覆盖桶（0/0 显影桶的机器化回收条件）', () => {
  it('被单测 import 的 views/pages 文件必须落非零覆盖率桶（新增单测面不同步桶即红）', () => {
    const cfgText = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
    const nonzero = nonzeroBucketKeys(extractThresholdValues(cfgText))
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
    const values = extractThresholdValues(readFileSync(join(root, 'vitest.config.ts'), 'utf8'))
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
