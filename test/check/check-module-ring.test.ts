/**
 * R0916-7-P3-2（全项目源码质量与优雅度评审 P3-3）直测：check 模块族的环与依赖方向守护。
 *
 * 断环手法（评审原环：run ↔ run-tree-issues）：run.ts 退成纯 re-export 兼容桥、
 * 实现体两分（run-single-doc / run-tree-issues）、账本类配置派生落中立叶 leads-config。
 * 本用例是这些结构不变量的常驻锚——任一实现件回头取兼容桥、或配置派生被搬回
 * runner 侧，环即重建、断言变红：
 * ① src/check 运行时 import 图无环（SCC 全为单点）；
 * ② run-tree-issues 不引 run.js / runner.js（原环边的导入断言）；
 * ③ runner 与 run-tree-issues 双侧都从 leads-config.js 取 enabledLeadTypes；
 * ④ leads-config 为叶（不引 check 下任何模块）；
 * ⑤ run.ts 只许 re-export（无实现声明，出边只到两个实现件）。
 *
 * 注：环判定只取运行时边——`import type` / `export type` 语句在运行期不建立边
 * （类型面互引不构成运行环），扫描前先剥离。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// R62-58 同款：仓库根按 import.meta.url 解析（cwd 相对在非根目录跑即错）
const root = fileURLToPath(new URL('../../', import.meta.url))
const CHECK_DIR = join(root, 'src', 'check')

/** 去注释后的源码（块注 + 行注）——实现声明断言防注释里的样例代码误伤。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 剥离类型面语句（`import type` / `export type ... from` / 全 type 的混合具名形）——
 *  它们不建运行边（TS 6 里 ImportDeclaration.isTypeOnly 恒 undefined，标志在 importClause，
 *  故此处按语句文本判形而非读 AST 标志）。 */
function stripTypeOnlyStatements(text: string): string {
  return text
    .replace(/\n\s*import\s+type\s[\s\S]*?from\s*'[^']+'/g, '')
    .replace(/\n\s*export\s+type\s*\{[\s\S]*?\}\s*from\s*'[^']+'/g, '')
    .replace(/\n\s*import\s*\{([\s\S]*?)\}\s*from\s*'[^']+'/g, (stmt, inner: string) => {
      const names = inner
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '' && !s.startsWith('//'))
      return names.length > 0 && names.every((s) => s.startsWith('type ')) ? '' : stmt
    })
}

/** 取模块的运行时出边（同目录 `./x.js` → `x.ts`；含动态 import）。 */
function runtimeOutEdges(file: string): string[] {
  const text = stripTypeOnlyStatements(readFileSync(file, 'utf-8'))
  const targets = new Set<string>()
  for (const re of [/from\s*'(\.\/[^']+\.js)'/g, /import\(\s*'(\.\/[^']+\.js)'\s*\)/g]) {
    for (const m of text.matchAll(re)) targets.add(m[1]!.slice(2, -3) + '.ts')
  }
  return [...targets].sort()
}

function listCheckFiles(): string[] {
  return readdirSync(CHECK_DIR)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))
    .sort()
}

const FILES = listCheckFiles()
const GRAPH = new Map<string, string[]>(FILES.map((f) => [f, runtimeOutEdges(join(CHECK_DIR, f))]))

/** Tarjan SCC（迭代版）——环 = 分量内点数 > 1（自环单独判）。 */
function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  let counter = 0
  for (const start of graph.keys()) {
    if (index.has(start)) continue
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }]
    index.set(start, counter)
    low.set(start, counter)
    counter++
    stack.push(start)
    onStack.add(start)
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const neighbors = graph.get(frame.node) ?? []
      if (frame.next < neighbors.length) {
        const next = neighbors[frame.next]!
        frame.next++
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter++
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, next: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = []
        for (;;) {
          const node = stack.pop()!
          onStack.delete(node)
          comp.push(node)
          if (node === frame.node) break
        }
        out.push(comp)
      }
    }
  }
  return out
}

describe('R0916-7-P3-2 check 模块族：运行时依赖图无环', () => {
  it('运行时 SCC 全为单点（含自环检查）', () => {
    const sccs = stronglyConnectedComponents(GRAPH)
    const cyclic = sccs.filter((c) => c.length > 1 || (c.length === 1 && (GRAPH.get(c[0]!) ?? []).includes(c[0]!)))
    const dump = cyclic.map((c) => c.join(' → ')).join('\n')
    expect(cyclic, `src/check 出现运行时环（评审 P3-3 已断，回潮即红）:\n${dump}`).toEqual([])
  })

  it('run.ts 兼容桥无入边（实现件不得回头取桥——取则环成）', () => {
    const importers = FILES.filter((f) => f !== 'run.ts' && (GRAPH.get(f) ?? []).includes('run.ts'))
    expect(importers, `src/check 内出现 run.js 实现侧取用（环边）:\n${importers.join('\n')}`).toEqual([])
  })
})

describe('R0916-7-P3-2 check 模块族：lead 配置叶与树聚合的出边', () => {
  it('run-tree-issues 不引 run.js / runner.js（原环边的导入断言）', () => {
    const text = stripTypeOnlyStatements(readFileSync(join(CHECK_DIR, 'run-tree-issues.ts'), 'utf-8'))
    expect(/from\s*'\.\/run\.js'/.test(text), 'run-tree-issues 反向引兼容桥 → 环重建').toBe(false)
    expect(/from\s*'\.\/runner\.js'/.test(text), 'run-tree-issues 引总聚合机检 → 环重建').toBe(false)
  })

  it('enabledLeadTypes 单源：runner 与 run-tree-issues 双侧引 ./leads-config.js', () => {
    for (const f of ['runner.ts', 'run-tree-issues.ts']) {
      expect(GRAPH.get(f), `${f} 须引 ./leads-config.js`).toContain('leads-config.ts')
    }
  })

  it('leads-config 为叶：不引 check 下任何模块', () => {
    expect(GRAPH.get('leads-config.ts')).toEqual([])
  })
})

describe('R0916-7-P3-2 check 模块族：run.ts 兼容桥只许 re-export', () => {
  const text = readFileSync(join(CHECK_DIR, 'run.ts'), 'utf-8')
  const code = stripComments(text)

  it('无实现声明（函数/类/模块级变量一律不许落在桥里）', () => {
    expect(/\bfunction\s+\w/.test(code), 'run.ts 出现函数实现——实现件回头取用即成新环').toBe(false)
    expect(/\bclass\s+\w/.test(code), 'run.ts 出现类实现').toBe(false)
    expect(/^\s*(export\s+)?(const|let|var)\s/m.test(code), 'run.ts 出现模块级变量（实现态）').toBe(false)
  })

  it('出边只到两个实现件', () => {
    expect(GRAPH.get('run.ts')).toEqual(['run-single-doc.ts', 'run-tree-issues.ts'])
  })
})
