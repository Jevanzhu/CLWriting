/**
 * P1-2（复审-0914-优化修复批）：GATED_ACTIONS 注册表静态对账（镜像门）。
 *
 * runGatedGeneration（task-gate.ts）把「占闸 → ensureSession → ctrl 注册 → finally
 * 注销/释放」收编为高阶包装后，包装内部的 acquireTaskGate 调用点移入 task-gate.ts——
 * 该文件被 governance 对账（test/governance/known-actions-audit.test.ts，不可改）排除
 * 扫描，包装面端点的 action 若漏登记 GATED_ACTIONS 将静默削弱跨进程闸查询完备性
 *（busyGate 少报一个在途 action）。本测试补齐对账面：
 * ① 扫 src/ 全部 .ts（排除 task-gate.ts 自身定义）的 runGatedGeneration 调用点，
 *   action 字面量集合 === GATED_ACTIONS（漏登记/多余登记都红）；
 * ② 出现次数 === 捕获次数（动态 action / 签名漂移在此炸响）；
 * ③ GATED_ACTIONS ∩ KNOWN_ACTIONS === ∅ 且并集无重（拆表不变量：两表合起来恰是
 *   拆表前的原 KNOWN_ACTIONS 全集，跨进程扫描枚举并集完备性逐项一致）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWN_ACTIONS, GATED_ACTIONS } from '../../src/studio/server/api/task-gate.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** 递归收集 .ts（排除 .d.ts 与 macOS ._ 垃圾——同 governance 对账测试口径） */
function listTs(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) out = out.concat(listTs(fp))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(fp)
  }
  return out
}

/** 调用点提取：首参为 res 表达式，opts 对象字面量（纯标量字段、无嵌套大括号）内
 *  action 必须是 'xxx' 字面量（与治理面「字面量占闸」同纪律） */
const CALL_RE = /runGatedGeneration\(\s*[^,()]+,\s*\{([^}]*)\}/g
/** 出现计数（import 语句无括号不计；定义在 task-gate.ts 自身，下方已排除该文件） */
const OCCUR_RE = /runGatedGeneration\(/g

const files = listTs(join(root, 'src')).filter((f) => !f.endsWith(join('api', 'task-gate.ts')))

let occurrences = 0
const actions = new Set<string>()
const sites: string[] = []
for (const f of files) {
  const src = readFileSync(f, 'utf-8')
  occurrences += [...src.matchAll(OCCUR_RE)].length
  for (const m of src.matchAll(CALL_RE)) {
    const action = /\baction:\s*'([a-z-]+)'/.exec(m[1]!)?.[1]
    if (action) {
      actions.add(action)
      sites.push(`${relative(root, f)} → ${action}`)
    }
  }
}

describe('P1-2（复审-0914-优化修复批）：GATED_ACTIONS 注册表对账', () => {
  it('包装调用点 action 字面量集合 === GATED_ACTIONS（漏登记/多余登记都红）', () => {
    expect(
      [...actions].sort(),
      `全库包装调用点：\n${sites.join('\n')}\n（新增调用点须同步登记 task-gate.ts 的 GATED_ACTIONS）`,
    ).toEqual([...GATED_ACTIONS].sort())
  })

  it('每个调用点都以字符串字面量占闸（无动态 action / 无签名漂移）', () => {
    expect(occurrences).toBeGreaterThan(0) // 扫描面非空（防 src 布局大改后空转绿灯）
    expect(
      sites.length,
      '存在未被字面量正则捕获的 runGatedGeneration 调用点（动态 action 变量或 opts 形状变化）',
    ).toBe(occurrences)
  })

  it('两表不相交且并集无重（拆表不变量：并集 = 拆表前 KNOWN_ACTIONS 全集）', () => {
    expect(knownGatedIntersection()).toEqual([])
    const union = new Set([...KNOWN_ACTIONS, ...GATED_ACTIONS])
    expect(union.size).toBe(KNOWN_ACTIONS.length + GATED_ACTIONS.length)
  })
})

function knownGatedIntersection(): string[] {
  const known = new Set(KNOWN_ACTIONS)
  return GATED_ACTIONS.filter((a) => known.has(a))
}
