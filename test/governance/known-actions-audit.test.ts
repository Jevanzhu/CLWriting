/**
 * R77-2（二十五轮批 E）：KNOWN_ACTIONS 注册表静态对账（零漂移机器门）。
 *
 * crossProcessHeldTaskGatesFor（R75-5）靠 KNOWN_ACTIONS 正向枚举锁文件名查跨进程
 * 在途闸——新增 acquireTaskGate 调用点漏登记只削弱查询完备性（busyGate 少报一个
 * 在途 action），acquire 侧互斥不受影响，此前无任何门禁拦漂移。本测试扫 src/ 全部
 * .ts（排除 task-gate.ts 自身定义），提取每个调用点的 action 字符串字面量：
 * ① 字面量集合 === KNOWN_ACTIONS（漏登记/多余登记都红）；
 * ② 出现次数 === 捕获次数（动态 action 变量 / 签名漂移在此炸响，不静默漏对账）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWN_ACTIONS } from '../../src/studio/server/api/task-gate.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** 递归收集 .ts（排除 .d.ts 与 macOS ._ 垃圾——同 dependency-direction.test.ts 口径） */
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

/** 调用点提取：首参允许一层嵌套括号（params['name']! 等表达式），action 必须是字面量 */
const CALL_RE = /acquireTaskGate\((?:[^()]|\([^()]*\))*?,\s*'([a-z-]+)'\s*\)/g
/** 出现计数（import 语句无括号不计；定义在 task-gate.ts 自身，下方已排除该文件） */
const OCCUR_RE = /acquireTaskGate\(/g

const files = listTs(join(root, 'src')).filter((f) => !f.endsWith(join('api', 'task-gate.ts')))

let occurrences = 0
const actions = new Set<string>()
const sites: string[] = []
for (const f of files) {
  const src = readFileSync(f, 'utf-8')
  occurrences += [...src.matchAll(OCCUR_RE)].length
  for (const m of src.matchAll(CALL_RE)) {
    actions.add(m[1]!)
    sites.push(`${relative(root, f)} → ${m[1]}`)
  }
}

describe('R77-2 批 E：KNOWN_ACTIONS 注册表对账', () => {
  it('调用点 action 字面量集合 === KNOWN_ACTIONS（漏登记/多余登记都红）', () => {
    expect(
      [...actions].sort(),
      `全库调用点：\n${sites.join('\n')}\n（新增调用点须同步登记 task-gate.ts 的 KNOWN_ACTIONS）`,
    ).toEqual([...KNOWN_ACTIONS].sort())
  })

  it('每个调用点都以字符串字面量占闸（无动态 action / 无签名漂移）', () => {
    expect(occurrences).toBeGreaterThan(0) // 扫描面非空（防 src 布局大改后空转绿灯）
    expect(
      sites.length,
      '存在未被字面量正则捕获的 acquireTaskGate 调用点（动态 action 变量或签名变化）',
    ).toBe(occurrences)
  })
})
