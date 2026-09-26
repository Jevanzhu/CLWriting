/**
 * R0916-6-P3-2（评审修复批，2026-09-16）：web-next Pinia store 模块级循环依赖守护门。
 *
 * 背景：stores 域存在既有模块级环（函数内延迟 useXxxStore() 取实例维持运行时安全，
 * 模块顶层求值不触环）。本测试静态扫描 src/studio/web-next/src/stores/*.ts 的相对
 * import（仅限 stores 目录内 './' 引用），构建有向图并枚举初等环，双闸防演化失控：
 *  - 未知环：新环即红，报出环路径 + 修复指引（函数内延迟 useXxxStore() 取实例，
 *    或拆单向模块）——新增 store 依赖时不得无感加环。
 *  - 白名单防僵尸：已知环逐条必须仍真实存在，否则红提示清理白名单（环已解则登记
 *    过时，防白名单变僵尸，SHAPE_KNOWN 同款口径）。
 * 风格对齐 test/governance/ai-studio-direction.test.ts（R0916-5c）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// R62-58 同款：仓库根按 import.meta.url 解析——非根目录跑不误判
const root = fileURLToPath(new URL('../../', import.meta.url))
const STORES_DIR = join(root, 'src', 'studio', 'web-next', 'src', 'stores')

/** import 语句模块说明符（单双引号；仅收 stores 目录内相对引用 './x'）。 */
const REL_IMPORT_RE = /^import\s+(?:type\s+)?[\s\S]*?from\s+['"](\.[/\\][^'"]+)['"]/

/** 读 stores 目录全量 .ts，产出邻接表：文件名（不含 .ts）→ stores 内相对依赖名集。 */
function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const name of readdirSync(STORES_DIR)) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue
    const from = name.replace(/\.ts$/, '')
    for (const line of readFileSync(join(STORES_DIR, name), 'utf-8').split('\n')) {
      const m = REL_IMPORT_RE.exec(line)
      if (!m || !m[1]) continue
      const spec = m[1].replaceAll('\\', '/')
      if (!spec.startsWith('./')) continue // 仅 stores 目录内相对引用
      const to = spec.slice(2).replace(/\.ts$/, '')
      if (!graph.has(from)) graph.set(from, [])
      graph.get(from)!.push(to)
    }
    if (!graph.has(from)) graph.set(from, [])
  }
  return graph
}

/**
 * 枚举全部初等环（每个环恰一次，以环内最小节点为起点即规范形）。
 * 图很小（15 节点 / ~15 边），按最小节点约束的朴素 DFS 即可，无需 Johnson 全套。
 */
function findCycles(graph: Map<string, string[]>): string[][] {
  const nodes = [...graph.keys()].sort()
  const rank = new Map(nodes.map((n, i) => [n, i]))
  const cycles: string[][] = []
  for (const start of nodes) {
    const startRank = rank.get(start)!
    const path: string[] = []
    const onPath = new Set<string>()
    const dfs = (cur: string): void => {
      path.push(cur)
      onPath.add(cur)
      for (const next of graph.get(cur) ?? []) {
        const r = rank.get(next) ?? -1
        if (r < startRank) continue // start 是该环节点集的最小者，其余起点已覆盖
        if (next === start) cycles.push([...path, start])
        else if (!onPath.has(next)) dfs(next)
      }
      path.pop()
      onPath.delete(cur)
    }
    dfs(start)
  }
  return cycles
}

/** 环规范形：'a→b→…→a'（起点即最小节点，与枚举序一致，消除旋转歧义）。 */
const canonical = (cycle: string[]): string => cycle.join('→')

/**
 * 已知环白名单（规范形）。评审 R0916-6 报三组（ui↔prefs / doc↔workspace / doc↔tree），
 * 本批全量枚举实得四组——第四组 doc→words→tree→doc（words 挂 tree、doc 挂 words 复合
 * 而成）属同款「函数内延迟取实例」安全模式，一并登记；治理后从此处移除。
 */
const KNOWN_CYCLES = new Set<string>(['prefs→ui→prefs', 'doc→workspace→doc', 'doc→tree→doc', 'doc→words→tree→doc'])

describe('R0916-6-P3-2: web-next store 模块环守护', () => {
  it('无未知环（新环即红：函数内延迟 useXxxStore() 或拆单向模块）', () => {
    const found = findCycles(buildGraph()).map(canonical)
    const unknown = found.filter((c) => !KNOWN_CYCLES.has(c))
    expect(
      unknown,
      'stores 出现白名单外的模块级循环依赖。修复指引：跨 store 取实例一律收进函数内' +
        '延迟 useXxxStore()（模块顶层只 import 类型/常量），或拆成单向模块' +
        '（被依赖方不回引）；确属既有环漏登记才补 KNOWN_CYCLES:\n' +
        unknown.join('\n'),
    ).toEqual([])
  })

  it('KNOWN_CYCLES 白名单逐条仍真实存在（防白名单变僵尸，已解环应清理登记）', () => {
    const found = new Set(findCycles(buildGraph()).map(canonical))
    const stale = [...KNOWN_CYCLES].filter((c) => !found.has(c))
    expect(stale, 'KNOWN_CYCLES 有条目对应的环已不存在（已治理），请从白名单移除:\n' + stale.join('\n')).toEqual([])
  })
})
