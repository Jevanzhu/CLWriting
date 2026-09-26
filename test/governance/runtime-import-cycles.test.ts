/**
 * R0916-7-P3-3（评审修复批，2026-09-16）：src 运行时 import 环守护门。
 *
 * 背景：全项目评审 P3-3 报「通用工具放错模块」导致 12 模块强连通 + 5 个运行时文件环
 * ——最底层适配器经 process/prepare（estimateTokens）与 process/summary（码点工具
 * re-export 中转）反向依赖编排层、记账模块承载 fs 锁原语、atomic ↔ lock 互引、
 * install 三文件互引。本批把工具下沉到真家（shared/tokens.ts、shared/text.ts、
 * fs/lock-file.ts、fs/process-alive.ts、process/bg-task.ts、install/books-store.ts），
 * 本门即固化成果并对后续演化 fail-closed。
 *
 * 扫描口径（与评审口径一致，可复核）：
 * - 图节点 = src/**\/*.ts（排除 .d.ts 与 node_modules 内的第三方源码）；
 * - 边 = **运行时**相对 import/export：静态 `import … from`、`export … from`
 *   （re-export 桥同样是运行时边）、副作用 import `import 'x'`；
 * - **剥注释**后扫描；`import type` / `export type` 整句剔除（纯类型面不参与运行时初始化）；
 * - **动态 import 单列**（DYNAMIC_IMPORTS，独立冻结清单 + 与静态图合并后同样过环闸），
 *   避免「用 import() 藏一条环边」或「新增动态边无人登记」；
 * - 环 = 强连通分量（节点集），键取**排序后的节点集合**——集合变化即红（增删文件皆然）。
 *
 * 冻结清单口径（只紧不松）：FROZEN_CYCLES 只登记**本批面外**的既有环；任何新环（含
 * 已解环回潮、新文件插入既有环）一律红。清单解除条件：① 环被解开（例如 web-next
 * stores 按 test/governance/webnext-store-import-cycles.test.ts 的函数内延迟取实例
 * 改造完成）→ 必须从清单删除（stale 用例会红）；② 清单条目集合变化（多/少文件）→
 * 视同新环，重新评估后按现状改写条目——不得放宽为「前缀/通配」。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url)) // R62-58 同款：仓库根按 import.meta.url 解析
const SRC = join(root, 'src')

/** 递归收集 src 下 .ts（排除 .d.ts / node_modules / macOS ._ 垃圾）。 */
function listTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || name === 'node_modules') continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) listTs(fp, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(fp)
  }
  return out
}

/** 剥行/块注释（字符串内的 `//` 不误伤——逐字符扫描 + 字符串态）。 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let inStr: string | null = null
  while (i < src.length) {
    const c = src[i]!
    if (inStr) {
      if (c === '\\') {
        out += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === inStr) inStr = null
      out += c
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      out += c
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

// 静态 import/export 语句（含多行；跨下一条 import/export 不匹配，防把副作用 import
// 与后续 type-only 语句缝成假边）；(?!type\b) 剔除 import type / export type。
const STATIC_STMT_RE =
  /(?:^|\n)[ \t]*(?:import|export)\s+(?!type\b)(?:(?!(?:^|\n)[ \t]*(?:import|export)\s)[\s\S])*?from\s*['"]([^'"]+)['"]/g
/** 副作用 import（`import 'x.js'`）——同样构成运行时边。 */
const SIDE_EFFECT_RE = /(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g
/** 动态 import()（单列；含 await import）。 */
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

const norm = (p: string): string => relative(root, p).replaceAll('\\', '/')

/** 说明符 → 仓库内 .ts 节点（'*.js' 后缀按 TS 编译约定映射；非相对/非 .ts 返回 null）。 */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = spec.endsWith('.js') ? spec.slice(0, -3) + '.ts' : spec.endsWith('.json') ? null : spec + '.ts'
  return base === null ? null : norm(resolve(dirname(fromFile), base))
}

interface ImportGraph {
  /** 静态边：节点 → 依赖节点集 */
  static: Map<string, Set<string>>
  /** 动态 import 边（单列）：节点 → 依赖节点集 */
  dynamic: Map<string, Set<string>>
}

function buildGraph(): ImportGraph {
  const files = listTs(SRC)
  const known = new Set(files.map(norm))
  const g: ImportGraph = { static: new Map(), dynamic: new Map() }
  for (const f of files) {
    const from = norm(f)
    const src = stripComments(readFileSync(f, 'utf-8'))
    const statics = new Set<string>()
    const dynamics = new Set<string>()
    for (const re of [STATIC_STMT_RE, SIDE_EFFECT_RE]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const to = resolveSpec(f, m[1]!)
        if (to && known.has(to)) statics.add(to)
      }
    }
    DYNAMIC_RE.lastIndex = 0
    let d: RegExpExecArray | null
    while ((d = DYNAMIC_RE.exec(src))) {
      const to = resolveSpec(f, d[1]!)
      if (to && known.has(to)) dynamics.add(to)
    }
    g.static.set(from, statics)
    g.dynamic.set(from, dynamics)
  }
  return g
}

/** 有向图强连通分量（Tarjan，迭代栈实现防深递归）。 */
function findSccs(graph: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let counter = 0
  for (const start of graph.keys()) {
    if (index.has(start)) continue
    // 显式栈（节点 → 待处理邻居迭代器位置）
    const work: Array<{ node: string; iter: Iterator<string> }> = [
      { node: start, iter: (graph.get(start) ?? new Set()).values() },
    ]
    index.set(start, counter)
    low.set(start, counter)
    counter++
    stack.push(start)
    onStack.add(start)
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const next = frame.iter.next()
      if (!next.done) {
        const w = next.value
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter)
          counter++
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, iter: (graph.get(w) ?? new Set()).values() })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          comp.push(w)
        } while (w !== frame.node)
        if (comp.length > 1) sccs.push(comp.sort())
      }
    }
  }
  return sccs
}

/** 环键：排序后的节点集合（集合变化即红，消除旋转/起点歧义）。 */
const cycleKey = (comp: string[]): string => [...comp].sort().join(' + ')

/** 合并静态 + 动态边（动态边单列统计，但合并后同样过环闸——见文件头注）。 */
function mergeGraph(g: ImportGraph): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>()
  for (const [k, v] of g.static) merged.set(k, new Set(v))
  for (const [k, v] of g.dynamic) {
    const cur = merged.get(k) ?? new Set<string>()
    for (const t of v) cur.add(t)
    merged.set(k, cur)
  }
  return merged
}

/**
 * 本批解开的环边（逐条显式断言 A→B 不存在）。前四条是真实环边（各自强连通分量内的
 * 一条边），其余是同一根因（通用工具/中转层放错模块）下剥除的转运边——一并断言，
 * 防「中转层回潮」。
 */
const SOLVED_EDGES: Array<{ from: string; to: string; why: string }> = [
  // ① fs 文件环：atomic 只为取 isProcessAlive 而引 lock，lock 又引 atomic 的重试原语
  { from: 'src/fs/atomic.ts', to: 'src/fs/cross-process-lock.ts', why: 'isProcessAlive 已拆至 fs/process-alive.ts' },
  // ② ai 强连通的环边：适配器族（gateway 用量估算）反向依赖编排层取 estimateTokens
  {
    from: 'src/ai/provider/usage-estimate.ts',
    to: 'src/process/prepare.ts',
    why: 'estimateTokens 已下沉 shared/tokens.ts',
  },
  // ③ ai 强连通的环边：风格修复规则经 process/summary 的 re-export 中转取码点工具
  { from: 'src/ai/rules/style-remedy.ts', to: 'src/process/summary.ts', why: 'codePoint 工具直引 shared/text.ts' },
  // ④ install 环的两条回引边：repair/resolve 回引 books.ts 取存储原语与常量
  { from: 'src/install/books-repair.ts', to: 'src/install/books.ts', why: '存储层已下沉 install/books-store.ts' },
  {
    from: 'src/install/books-resolve.ts',
    to: 'src/install/books.ts',
    why: 'CLWRITING_DIR 已下沉 install/books-store.ts',
  },
  // ⑤ 同根因剥除的转运边（非环边但同为「通用工具放错模块」的中转层）
  { from: 'src/ai/prompts/chat.ts', to: 'src/process/summary.ts', why: 'clipByCodePoints 直引 shared/text.ts' },
  { from: 'src/ai/tools/search.ts', to: 'src/process/summary.ts', why: 'clipByCodePoints 直引 shared/text.ts' },
  { from: 'src/ai/tools/rewrite.ts', to: 'src/process/summary.ts', why: '码点工具直引 shared/text.ts' },
  { from: 'src/process/book-search.ts', to: 'src/process/summary.ts', why: 'clipByCodePoints 直引 shared/text.ts' },
  { from: 'src/process/spill.ts', to: 'src/process/summary.ts', why: 'codePointLength 直引 shared/text.ts' },
  {
    from: 'src/ai/orchestrate/self-heal.ts',
    to: 'src/process/summary.ts',
    why: 'runRegisteredBgTask 已独立为 process/bg-task.ts',
  },
  {
    from: 'src/ai/provider/store.ts',
    to: 'src/ai/calls.ts',
    why: '锁写原语已迁 fs/lock-file.ts（设置域不再经记账模块借用）',
  },
]

/**
 * 面外既有环冻结清单（键 = 排序节点集合）。当前仅 web-next Pinia stores 两族——
 * 前端同目录已有 test/governance/webnext-store-import-cycles.test.ts 逐环守护，
 * 本门以其节点集合为键做第二道兜底（集合变化 = 新环形态，必须重新评估）。
 *
 * 解除条件：环解开或节点集合变化时必须改写本清单（stale 用例会红）。后端口（src 除
 * web-next 外）当前**零环**——若 check 环、ai 适配器族环等回潮，本门直接红：应按
 * 「工具下沉真家 + 依赖单向化」解环，不要把它们登记进冻结清单。
 */
const FROZEN_CYCLES: ReadonlySet<string> = new Set([
  cycleKey([
    'src/studio/web-next/src/stores/doc.ts',
    'src/studio/web-next/src/stores/tree.ts',
    'src/studio/web-next/src/stores/workspace.ts',
    'src/studio/web-next/src/stores/words.ts',
  ]),
  cycleKey(['src/studio/web-next/src/stores/prefs.ts', 'src/studio/web-next/src/stores/ui.ts']),
])

/**
 * 动态 import 边冻结清单（单列：动态边不进静态图，但新增/删除必须显式登记）。
 * 解除条件同 FROZEN_CYCLES——变更即改清单，不得放空。
 */
const DYNAMIC_IMPORTS: ReadonlySet<string> = new Set([
  'src/desktop/lifecycle.ts -> src/desktop/server-manager.ts',
  'src/document/lead-finalize.ts -> src/format/types.ts',
  'src/state/state.ts -> src/format/types.ts',
  'src/studio/server/api/providers.ts -> src/ai/provider/types.ts',
])

/**
 * 中转层回潮防线：这些符号不得再从 from 模块 import（实现已迁 home，直引新家）。
 * 只列**已全量改指**的符号——仍被面外文件合法消费的 re-export 桥（如
 * install/books.ts 的存储层导出面、fs/cross-process-lock.ts 的 isProcessAlive）
 * 不入此表，它们在图上由单向下行边体现（见 SOLVED_EDGES 与环闸）。
 */
const FORBIDDEN_TRANSIT: Array<{ from: string; symbols: string[]; home: string }> = [
  { from: 'src/process/summary.ts', symbols: ['codePointLength', 'clipByCodePoints'], home: 'src/shared/text.ts' },
  {
    from: 'src/process/prepare.ts',
    symbols: ['estimateTokens', 'TOKEN_COEFFICIENTS', 'DEFAULT_TOKEN_COEFF'],
    home: 'src/shared/tokens.ts',
  },
  { from: 'src/process/summary.ts', symbols: ['runRegisteredBgTask'], home: 'src/process/bg-task.ts' },
  {
    from: 'src/ai/calls.ts',
    symbols: ['serializedLockedWrite', 'SerializedLockedWriteOpts'],
    home: 'src/fs/lock-file.ts',
  },
]

/** 扫描「从 from 模块 import 了表内符号」的 import 语句（含多行）；返回违规行描述。 */
function scanTransitViolations(): string[] {
  const files = listTs(SRC)
  const violations: string[] = []
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf-8'))
    const fromRel = norm(f)
    for (const rule of FORBIDDEN_TRANSIT) {
      const ruleFrom = norm(join(root, rule.from))
      // 该文件的 import/export 语句里是否有指向 rule.from 的说明符
      const stmtRe =
        /(?:^|\n)[ \t]*(?:import|export)\s+(?!type\b)((?:(?!(?:^|\n)[ \t]*(?:import|export)\s)[\s\S])*?)from\s*['"]([^'"]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = stmtRe.exec(src))) {
        const clause = m[1]!
        const to = resolveSpec(f, m[2]!)
        if (to !== ruleFrom) continue
        const hit = rule.symbols.filter((s) => new RegExp(`\\b${s}\\b`).test(clause))
        if (hit.length > 0)
          violations.push(`${fromRel} 仍从 ${rule.from} 引 ${hit.join('/')}（应直引 ${rule.home}）：${m[0].trim()}`)
      }
    }
  }
  return violations
}

describe('R0916-7-P3-3: src 运行时 import 环守护', () => {
  const graph = buildGraph()
  const staticSccs = findSccs(graph.static)
  const mergedSccs = findSccs(mergeGraph(graph))

  it('本批解开的环边逐条不再存在（A→B）', () => {
    const present = SOLVED_EDGES.filter((e) => graph.static.get(e.from)?.has(e.to)).map(
      (e) => `${e.from} → ${e.to} 仍存在（${e.why}）`,
    )
    expect(
      present,
      '已解开的环边回潮（工具/原语被搬回旧家或重新经中转层引用）。修复指引：直引实现所在模块，' +
        '不要新增 re-export 兼容层:\n' +
        present.join('\n'),
    ).toEqual([])
  })

  it('无冻结清单外的环（新环即红；后端口当前应零环）', () => {
    const unknown = staticSccs.map(cycleKey).filter((k) => !FROZEN_CYCLES.has(k))
    expect(
      unknown,
      'src 出现冻结清单外的运行时循环依赖（含已解环回潮 / 新文件插入既有环）。修复指引：' +
        '把通用工具下沉到其真家模块（shared/fs 等零上层依赖的叶子）、或拆单向模块（被依赖方不回引）；' +
        '确属面外既有环才登记 FROZEN_CYCLES——且按节点集合精确登记（禁前缀/通配）:\n' +
        unknown.join('\n'),
    ).toEqual([])
  })

  it('冻结清单逐条仍真实存在（防僵尸；后端口零环是常态）', () => {
    const found = new Set(staticSccs.map(cycleKey))
    const stale = [...FROZEN_CYCLES].filter((k) => !found.has(k))
    expect(
      stale,
      'FROZEN_CYCLES 有条目对应的环已不存在或节点集合已变（已治理/已改写形态），请从清单移除或按现状改写:\n' +
        stale.join('\n'),
    ).toEqual([])
  })

  it('动态 import 单列且逐条登记（新增/删除必须显式改清单）', () => {
    const found = new Set<string>()
    for (const [from, tos] of graph.dynamic) {
      for (const to of tos) found.add(`${from} -> ${to}`)
    }
    expect(
      [...found].sort(),
      '动态 import 边发生变化（动态边不进静态图，但同样参与运行时初始化）——请显式更新 DYNAMIC_IMPORTS 清单:\n' +
        [...found].sort().join('\n'),
    ).toEqual([...DYNAMIC_IMPORTS].sort())
  })

  it('静态 ∪ 动态合并图同样无冻结清单外的环（防用 import() 藏环边）', () => {
    const unknown = mergedSccs.map(cycleKey).filter((k) => !FROZEN_CYCLES.has(k))
    expect(unknown, '合并动态 import 后出现冻结清单外的环（静态图看不见的隐藏环）:\n' + unknown.join('\n')).toEqual([])
  })

  it('迁移符号不再经中转模块 import（直引新家）', () => {
    const violations = scanTransitViolations()
    expect(
      violations,
      '已迁移符号仍经中转模块引用（re-export 兼容层回潮）。修复指引：直引实现所在模块:\n' + violations.join('\n'),
    ).toEqual([])
  })
})
