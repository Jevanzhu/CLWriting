/**
 * R0916-5c（⑤③ ai↔studio 解环·守门固化批，2026-09-16）：ai→studio 方向锁 + studio→ai 组合根形状锁。
 *
 * R0916 波1 全量边表侦察结论：ai→studio 静态 import = 0 条——最后一条反向边
 * （orchestrate/chat/turns.ts → studio/server/api/task-gate）已由 R0912 以
 * task-gate-port 端口化解，r0912-task-gate-port 仅锚两文件源；studio→ai = 64 条，
 * 全部落在组合根面（server/index.ts、server/http.ts、server/api/**）。
 * 本测试把现状钉成常驻门防回潮：
 *  - 方向锁（模块级全量）：src/ai/** 零 studio import。AI 层需要 studio 侧能力时
 *    走端口注入（先例 src/ai/orchestrate/task-gate-port.ts + stream.ts 组合根注册、
 *    src/document/structure.ts StructureRagPort），不得直连；本门吸收并超越 r0912
 *    的两文件源锚。
 *  - 形状锁：src/studio/**（含 web-next）凡 import ai 必须落在组装根点名面
 *    （server/index.ts、server/http.ts）或**逐文件登记表**内——web-next 永远零 ai
 *    直连（经 HTTP 访问 server）；新文件确需 ai 能力时应上移组合根或端口化，
 *    评审确需直连才逐文件登记（api 层入 API_LAYER_REGISTERED，面外入 SHAPE_KNOWN）。
 *    扫描面 = .ts + .vue SFC 的 <script> 块（template/style 内字样不判）——SFC 不是
 *    门的盲区。
 *  与 G5（dependency-direction.test.ts：编辑器/底座 → AI 生成层）正交不重叠；
 *  r0912 两文件源锚为本门子集，语义保留不动。
 *
 * 2026-10-11 全量复审报告 §四 C7/H3 收紧（本批）：原组合根面白名单含**目录前缀**
 * COMB_ROOT_PREFIXES = ['src/studio/server/api/']——任何新增 api 文件直连 ai 自动放行，
 * 与「例外须逐文件登记」的文案不一致（H3）。现删除该前缀，收紧为逐文件登记：
 *  - api 层直连面改 API_LAYER_REGISTERED（键 = 相对路径，值 = 登记理由，逐条在位）；
 *  - 面外例外仍走 SHAPE_KNOWN（当前空集）；
 *  - 登记表双向自校验：新增未登记文件（含 api 层新增）→ 红；登记项文件不存在
 *    （改名/搬迁）或已不再直连 ai（已治理）→ 红；条目错位（api 面文件入面外表 /
 *    面外文件入 api 表）→ 红。
 * 覆盖面对照：旧前缀在现状下实际放行的 api 层直连文件 = 22 个，新登记表逐条对应这
 * 22 条（见下表），无漏放；此后新增文件一律需评审登记后才放行。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// R62-58 同款：仓库根按 import.meta.url 解析——非根目录跑不误判
const root = fileURLToPath(new URL('../../', import.meta.url))

/**
 * R0916-6-P3-11（2026-09-16 全库源码重评五轮修复批）：扫描口径加固——原 AI_RE/STUDIO_RE
 * 逐行（或整文）只测静态 `from` 单正则，有两处逃逸面：①多行 import（from 与路径被
 * 换行空白错开时，逐行窗口失配）②动态 `import()`（无 from 关键字，正则天然不捕）。
 * 修法：整文读 → 空白归一（/\s+/g → 单空格，跨行与同行等价）→ 静态同族正则 + 动态
 * import 正则联测。动态正则口径与静态逐字同族：AI 侧保持 `(?:\.\.\/)+ai\/` 相对限定
 * （放宽为 `[^'"]*ai\/` 会误捕 openai/ 等含 ai 段的 bare 包名）；STUDIO 侧保持
 * `[^'"]*\/studio\/` 任意路径含段即捕（与原口径一致）。
 * 已知残余面（与原口径相同、不因归一扩大）：注释/字符串字面量里恰好写有 import 字样
 * 会误报——原形状锁本就对整文 test，此面非本批新增；src 现状零命中（门绿），如出现
 * 再引入 scripts/check-counts.mjs 的 stripComments 剥离口径。
 */
const STUDIO_RES = [
  /from\s+['"][^'"]*\/studio\//, // 静态 import / export-from（原口径）
  /import\(\s*['"][^'"]*\/studio\//, // 动态 import()（P3-11 增补）
]
/** src/studio/** 的 ai import 匹配（任意相对深度；静态 + 动态，见 P3-11 注）。 */
const AI_RES = [/from\s+['"](?:\.\.\/)+ai\//, /import\(\s*['"](?:\.\.\/)+ai\//]

/** P3-11：整文空白归一后跑正则组，返回命中的匹配片段（供违规行输出定位）。 */
function hitsAny(content: string, res: RegExp[]): string[] {
  const flat = content.replace(/\s+/g, ' ')
  const out: string[] = []
  for (const re of res) {
    const m = flat.match(re)
    if (m) out.push(m[0])
  }
  return out
}

/** 组装根点名面：studio→ai 的装配入口（显式两文件，非目录前缀——新文件不得经前缀静默放行）。 */
const COMB_ROOT_FILES = ['src/studio/server/index.ts', 'src/studio/server/http.ts']

/** api 层组装面的路径限定——仅用于校验登记项归属（不放行判定；放行只认逐文件登记表）。 */
const API_LAYER_PREFIX = 'src/studio/server/api/'

/**
 * api 层直连 ai 的逐文件登记表（键 = 仓库根相对路径；值 = 登记理由）。
 *
 * 取代原 COMB_ROOT_PREFIXES 目录前缀白名单（2026-10-11 全量复审报告 §四 C7/H3）：
 * api 层是组合根面，但面内直连须逐文件在位登记——新增 api 文件未登记即红，
 * 评审确需直连才入表；文件改名/搬迁或不再直连 ai 时本表须同步（僵尸校验会红）。
 * 登记理由写明该文件为何需要 ai 直连，供后续评审复核；api 层以外文件的例外走
 * SHAPE_KNOWN（本表条目必须落在 API_LAYER_PREFIX 内）。
 */
const API_LAYER_REGISTERED: ReadonlyMap<string, string> = new Map([
  [
    'src/studio/server/api/ai-status.ts',
    'AI 可达性探测端点（GET /api/ai-status）：只引 ProviderRuntime 端口类型（组装根注入），无运行时 ai 依赖',
  ],
  [
    'src/studio/server/api/analysis.ts',
    '分析端点族（6 路由）：runSpec/analysisSpec 组装 AI 分析任务 + ProviderRuntime 端口 + AnalysisKind 契约类型',
  ],
  [
    'src/studio/server/api/books-lifecycle.ts',
    '书生命周期端点（删书等）：中止在途 chat/自愈、等待后台任务，并失效 setting-rule / calls 迁移缓存——编排状态直连面',
  ],
  ['src/studio/server/api/books-rename.ts', '书名修改端点：中止在途 chat/自愈 + 查后台任务在途（改名期间禁写）'],
  [
    'src/studio/server/api/chat.ts',
    'chat 端点族：sendChatMessage/resolveChatConfirm/clearChatHistory + 自愈嵌入态查询',
  ],
  ['src/studio/server/api/cost-stats.ts', '成本统计端点：aggregateCost（llm/call 事件 × 价格表聚合，只读）'],
  ['src/studio/server/api/draft.ts', '草稿端点：recordAuthorSignal（作者信号记账）'],
  ['src/studio/server/api/onboard.ts', '开书向导端点：runSpec + ONBOARD_SPEC'],
  [
    'src/studio/server/api/outline.ts',
    '大纲端点：runSpec + OUTLINE_SPEC；另引 redactSecret（ai/provider/redact 兼容转发，真家 log/redact.ts）',
  ],
  [
    'src/studio/server/api/overview.ts',
    '总览端点：仅 redactSecret（经 ai/provider/redact 兼容转发——真家 log/redact.ts，改指即可消 ai 边）',
  ],
  [
    'src/studio/server/api/provider-save-guard.ts',
    '非路由模块：providers / rag-providers 两族端点共用的保存失败信封映射（saveProviders + ProviderRevisionConflictError → 409/500）',
  ],
  [
    'src/studio/server/api/providers.ts',
    '供应商端点族（10 路由）：provider store 读写、模型清单、能力探测、脱敏；含 ProviderConf pricing 类型的动态 import',
  ],
  ['src/studio/server/api/rag-providers.ts', 'RAG 供应商端点族：provider store 读写 + Vault 类型'],
  ['src/studio/server/api/rag.ts', 'RAG 端点族：loadProviders 解析 embedding provider + redactSecret'],
  [
    'src/studio/server/api/review.ts',
    '三审端点族：runSpec/reviewSpec + ProviderRuntime 端口 + effectiveRemainingCalls 预算闸',
  ],
  ['src/studio/server/api/rewrite.ts', '重写端点族：runSpec + REWRITE_SPEC'],
  ['src/studio/server/api/settings.ts', '设置域端点（含关系挖掘）：runSpec + RELATION_MINE_SPEC'],
  [
    'src/studio/server/api/state.ts',
    '状态机端点：仅 redactSecret（经 ai/provider/redact 兼容转发——真家 log/redact.ts，改指即可消 ai 边）',
  ],
  [
    'src/studio/server/api/stats-signature.ts',
    '非路由模块：trace-stats / cost-stats 结果缓存的数据源指纹探针——需事件库路径（events 单源）与 rule-hits 统计文件路径（ai/rule-hits 单源导出，禁消费方手抄）同源派生',
  ],
  [
    'src/studio/server/api/stream.ts',
    'SSE/spawn/interrupt/auto-write 端点：自愈/chat 编排、spec 运行、计费、spawn registry、task-gate-port 组合根注册',
  ],
  [
    'src/studio/server/api/style.ts',
    '风格端点族（9 路由）：仅 redactSecret（经 ai/provider/redact 兼容转发——真家 log/redact.ts，改指即可消 ai 边）',
  ],
  [
    'src/studio/server/api/task-gate.ts',
    '非路由模块：API 层长任务并发闸（忙矩阵查 ai 编排在途态 chat/自愈/后台/spawn；反向 ai→studio 走 task-gate-port）',
  ],
  ['src/studio/server/api/trace-stats.ts', 'trace 指标端点：aggregateTrace + readRuleHits（只读聚合）'],
])

/**
 * api 层以外的评审例外（键 = 相对路径；值 = 理由）。当前空集——web-next 永远零 ai
 * 直连（经 HTTP 访问 server）；api 层以外确需 ai 能力时应上移组合根或端口化。
 * api 面文件一律入 API_LAYER_REGISTERED（错位会被下方校验点名）；条目文件不存在
 * （改名/搬迁）或已不再直连 ai（已治理）→ 红，要求同步删改。
 */
const SHAPE_KNOWN: ReadonlyMap<string, string> = new Map<string, string>()

/** 递归收集目录下源码（.ts 排除 .d.ts + .vue SFC；排除 macOS ._ 垃圾；G5 同款）。 */
function listSource(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) out = out.concat(listSource(fp))
    else if ((name.endsWith('.ts') && !name.endsWith('.d.ts')) || name.endsWith('.vue')) out.push(fp)
  }
  return out
}

/** 门只判脚本面 import：.vue 取 <script> 块正文（template/style 里的字样不算，防误报）。 */
function scriptBlocks(name: string, content: string): string {
  if (!name.endsWith('.vue')) return content
  return [...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '').join('\n')
}

/** 读文件内容（.vue 先剥到 script 块；调用方一律经此读，勿直读防绕门）。 */
function readSource(fp: string): string {
  return scriptBlocks(fp, readFileSync(fp, 'utf-8'))
}

/** 源文件探测结果（登记表自校验用；注入探针以便自证用例离线构造形态）。 */
interface SourceProbe {
  /** 文件在位（改名/搬迁 → false，须同步登记） */
  exists: boolean
  /** 仍直连 ai（静态或动态 import） */
  importsAi: boolean
}

/**
 * 形状锁判据（纯函数，磁盘扫描与「门不空转」自证用例共用）：
 * 返回未登记直连 ai 的条目（`相对路径  ←  命中片段`）。
 */
function shapeViolations(files: ReadonlyArray<{ rel: string; content: string }>): string[] {
  const out: string[] = []
  for (const { rel, content } of files) {
    const hits = hitsAny(content, AI_RES)
    if (hits.length === 0) continue
    if (COMB_ROOT_FILES.includes(rel)) continue
    if (API_LAYER_REGISTERED.has(rel) || SHAPE_KNOWN.has(rel)) continue
    out.push(`${rel}  ←  ${hits.join(' | ')}`)
  }
  return out
}

/** 登记表条目（两张表合并后的统一形状；inApiTable 决定归属面校验方向）。 */
interface RegistryEntry {
  rel: string
  reason: string
  inApiTable: boolean
}

/** 两张登记表的全量条目（api 层表 + 面外表）。 */
function registryEntries(): RegistryEntry[] {
  return [
    ...[...API_LAYER_REGISTERED].map(([rel, reason]) => ({ rel, reason, inApiTable: true })),
    ...[...SHAPE_KNOWN].map(([rel, reason]) => ({ rel, reason, inApiTable: false })),
  ]
}

/**
 * 登记表自校验（纯函数，注入探针——磁盘入口见下方 diskProbe）：
 * 僵尸（文件不存在 / 已不再直连 ai）+ 错位（api 面文件入面外表、面外文件入 api 表）。
 */
function registryProblems(entries: readonly RegistryEntry[], probe: (rel: string) => SourceProbe): string[] {
  const problems: string[] = []
  for (const { rel, reason, inApiTable } of entries) {
    const p = probe(rel)
    if (!p.exists) {
      problems.push(`${rel}  ←  文件已不存在（改名/搬迁？）——请按新路径更新登记（理由：${reason}）`)
      continue
    }
    if (!p.importsAi) {
      problems.push(`${rel}  ←  ai import 已消失（视为已治理）——请从登记表移除（理由：${reason}）`)
      continue
    }
    if (inApiTable && !rel.startsWith(API_LAYER_PREFIX)) {
      problems.push(`${rel}  ←  api 层登记表条目不在 api 面内——面外例外应入 SHAPE_KNOWN（理由：${reason}）`)
    } else if (!inApiTable && rel.startsWith(API_LAYER_PREFIX)) {
      problems.push(`${rel}  ←  api 面文件误登记在 SHAPE_KNOWN——应入 API_LAYER_REGISTERED（理由：${reason}）`)
    }
  }
  return problems
}

/** 磁盘探针（登记表自校验的生产入口）。 */
function diskProbe(rel: string): SourceProbe {
  const fp = join(root, rel)
  if (!existsSync(fp)) return { exists: false, importsAi: false }
  return { exists: true, importsAi: hitsAny(readSource(fp), AI_RES).length > 0 }
}

/** 磁盘扫描面：src/studio 全量源码（.ts + .vue，读取经 readSource 剥 script 块）。 */
function studioSources(): Array<{ rel: string; content: string }> {
  return listSource(join(root, 'src', 'studio')).map((fp) => ({
    rel: relative(root, fp).replaceAll('\\', '/'),
    content: readSource(fp),
  }))
}

describe('R0916-5c ai↔studio 依赖方向守护', () => {
  it('方向锁：src/ai/** 无 studio import（模块级全量，静态 + 动态 import()）', () => {
    const violations: string[] = []
    for (const file of listSource(join(root, 'src', 'ai'))) {
      const rel = relative(root, file).replaceAll('\\', '/')
      for (const hit of hitsAny(readSource(file), STUDIO_RES)) {
        violations.push(`${rel}  ←  ${hit}`)
      }
    }
    expect(
      violations,
      'AI 层出现 studio 直连。若为合理依赖，走端口注入先例' +
        '（src/ai/orchestrate/task-gate-port.ts + stream.ts 组合根注册 / ' +
        'src/document/structure.ts StructureRagPort），不得直连:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('形状锁：studio→ai 只准落在组装根点名面或逐文件登记表（未登记即红）', () => {
    const files = studioSources()
    expect(files.length, 'src/studio 扫描面为空——目录结构漂移，门已失明').toBeGreaterThan(0)
    const violations = shapeViolations(files)
    expect(
      violations,
      '组合根面以外出现未登记的 studio→ai import（扫描含 .vue 的 script 块——web-next 永远零 ai 直连，' +
        '经 HTTP 访问 server）。修法：上移组合根 / 端口化；确需直连时逐文件登记——' +
        'api 层入 API_LAYER_REGISTERED（含理由），面外入 SHAPE_KNOWN:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('登记表防僵尸与错位：条目须在位、仍直连 ai、且落在各自归属面', () => {
    const problems = registryProblems(registryEntries(), diskProbe)
    expect(
      problems,
      '登记表有条目已过时/错位（文件改名、已治理、或登记在错误的表内）——' +
        '请同步 API_LAYER_REGISTERED / SHAPE_KNOWN:\n' +
        problems.join('\n'),
    ).toEqual([])
  })

  it('扫描口径自证：未登记直连必红、登记项与组装根点名不误红（门不空转）', () => {
    const planted = "import { runSpec } from '../../../ai/tasks/spec.js'"
    const probeRel = 'src/studio/server/api/__probe-new-endpoint.ts'
    // ① 新增未登记 api 文件直连 ai → 必红（原目录前缀放行面已关闭）
    const added = shapeViolations([{ rel: probeRel, content: planted }])
    expect(added, '未登记新增文件未被判红——形状锁失牙').toHaveLength(1)
    expect(added[0]).toContain(probeRel)
    // ② 已登记 api 文件 / 组装根点名文件 → 不红（现状覆盖不误伤）
    const registeredRel = [...API_LAYER_REGISTERED.keys()][0]
    expect(registeredRel, 'api 层登记表为空——登记面丢失').toBeDefined()
    expect(shapeViolations([{ rel: registeredRel!, content: planted }])).toEqual([])
    expect(shapeViolations([{ rel: 'src/studio/server/index.ts', content: planted }])).toEqual([])
    // ③ 面外文件（web-next）直连 → 必红（须走 SHAPE_KNOWN 评审登记）
    expect(shapeViolations([{ rel: 'src/studio/web-next/src/probe.ts', content: planted }])).toHaveLength(1)
    // ④ 动态 import() 同族口径照常命中；不直连 ai 的文件不红
    expect(shapeViolations([{ rel: probeRel, content: "await import('../../../ai/tasks/specs.js')" }])).toHaveLength(1)
    expect(shapeViolations([{ rel: probeRel, content: "import { reply } from '../http.js'" }])).toEqual([])
  })

  it('登记表自校验口径自证：僵尸/错位条目必判红（注入探针，离线构造）', () => {
    const apiRel = [...API_LAYER_REGISTERED.keys()][0]!
    const entries = registryEntries()
    // ① 文件缺失（改名/搬迁形态）→ 逐条必判
    const missing = registryProblems(entries, () => ({ exists: false, importsAi: false }))
    expect(missing).toHaveLength(entries.length)
    expect(missing.every((p) => p.includes('文件已不存在'))).toBe(true)
    // ② 条目已不再直连 ai（已治理形态）→ 仅该条判红，其余照常通过
    const cleaned = registryProblems(entries, (rel) => ({ exists: true, importsAi: rel !== apiRel }))
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0]).toContain(apiRel)
    expect(cleaned[0]).toContain('ai import 已消失')
    // ③ 错位：api 面文件入面外表 / 面外文件入 api 表 → 各判一条
    const misplaced = registryProblems(
      [
        { rel: apiRel, reason: '探针', inApiTable: false },
        { rel: 'src/studio/web-next/src/probe.ts', reason: '探针', inApiTable: true },
      ],
      () => ({ exists: true, importsAi: true }),
    )
    expect(misplaced).toHaveLength(2)
    expect(misplaced.some((p) => p.includes('误登记在 SHAPE_KNOWN'))).toBe(true)
    expect(misplaced.some((p) => p.includes('不在 api 面内'))).toBe(true)
  })
})
