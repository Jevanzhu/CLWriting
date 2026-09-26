/**
 * R0916-7-P3-14（2026-09-25 源码质量评审 P3-14）：任务闸 action 字面量治理门
 * —— 原 KNOWN_ACTIONS 注册表对账的替代门（对账对象已随锁文件名改造消失）。
 *
 * 背景：P3-14 前锁文件名 = 截断 sha256(action+NUL+book)（单向不可逆），跨进程查「本书
 * 有哪些任务在跑」只能拿 KNOWN_ACTIONS/GATED_ACTIONS 两张注册表逐个哈希探测，于是需要
 * 两张表 + 两份静态对账门防漏
 * 登记。文件名改 `${action}.${hash(book)}.lock` 后列目录即可枚举（action 自描述），注册表
 * 与两份对账门随批删除；换来一条新的、同等重要的不变量：
 *
 *   **action 必须是文件名安全 token**（`^[a-z][a-z0-9-]*$`）——
 *   ① 含 '.' 会让 `${action}.${hash}.lock` 的解析在第二个点处歧义，该闸从枚举面静默消失
 *     （crossProcessHeldTaskGatesFor 只认「action 段无点」的名）；
 *   ② 含路径分隔符/空白/大写等会拼出非法或跨目录的锁名（win 非法字符集与长路径同样踩雷）。
 *
 * 本门扫 src/ 全部 .ts（排除 task-gate.ts 自身）的两类调用点字面量：
 * - `acquireTaskGate(book, 'action')`（端点直接占闸面）；
 * - `runGatedGeneration(res, { action: 'action', ... })`（包装占闸面）。
 * ① 每个字面量都必须通过 token 正则（违规即红，带站点清单）；
 * ② 出现次数 === 捕获次数（动态 action 变量/签名漂移在此炸响，不静默漏对账）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockFileName } from '../../src/studio/server/api/task-gate.js'

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
const CALL_RE = /acquireTaskGate\((?:[^()]|\([^()]*\))*?,\s*'([^']*)'\s*\)/g
/** 出现计数（import 语句无括号不计；定义在 task-gate.ts 自身，下方已排除该文件） */
const OCCUR_RE = /acquireTaskGate\(/g
/** 包装面调用点：opts 对象字面量（纯标量字段、无嵌套大括号）内 action 字面量 */
const GATED_CALL_RE = /runGatedGeneration\(\s*[^,()]+,\s*\{([^}]*)\}/g
const GATED_ACTION_RE = /\baction:\s*'([^']*)'/g
const GATED_OCCUR_RE = /runGatedGeneration\(/g

/** action 字面量白名单：小写字母起头、只含小写/数字/连字符（不含 '.'——见文件头注①） */
const ACTION_TOKEN_RE = /^[a-z][a-z0-9-]*$/

const files = listTs(join(root, 'src')).filter((f) => !f.endsWith(join('api', 'task-gate.ts')))

let occurrences = 0
let gatedOccurrences = 0
const sites: Array<{ site: string; action: string }> = []
for (const f of files) {
  const src = readFileSync(f, 'utf-8')
  occurrences += [...src.matchAll(OCCUR_RE)].length
  for (const m of src.matchAll(CALL_RE)) sites.push({ site: `${relative(root, f)} → ${m[1]}`, action: m[1]! })
  gatedOccurrences += [...src.matchAll(GATED_OCCUR_RE)].length
  for (const m of src.matchAll(GATED_CALL_RE)) {
    for (const a of m[1]!.matchAll(GATED_ACTION_RE)) sites.push({ site: `${relative(root, f)} → gated ${a[1]}`, action: a[1]! })
  }
}

describe('R0916-7-P3-14：任务闸 action 字面量治理门', () => {
  it('全部调用点 action 字面量都是文件名安全 token（无 "." 等会破坏锁名解析的字符）', () => {
    expect(sites.length).toBeGreaterThan(0) // 扫描面非空（防 src 布局大改后空转绿灯）
    const bad = sites.filter((s) => !ACTION_TOKEN_RE.test(s.action))
    expect(
      bad.map((s) => s.site),
      'action 须匹配 ^[a-z][a-z0-9-]*$（含 "." 会让 `${action}.${hash(book)}.lock` 的枚举解析歧义）',
    ).toEqual([])
  })

  it('锁名可枚举：动作段原样往返、书名段不泄漏书名（含路径字符也不进文件名）', () => {
    const name = lockFileName('书/名:x', 'rag-build')
    // 形状独立钉定（不借自身 split 反推）：action 段在前、书名段 = 16 hex、.lock 收尾
    expect(name).toMatch(/^rag-build\.[0-9a-f]{16}\.lock$/)
    expect(name.includes('书')).toBe(false)
  })

  it('每个调用点都以字符串字面量占闸（无动态 action / 无签名漂移）', () => {
    // 直接占闸面的出现次数 == 字面量捕获数
    const direct = sites.filter((s) => !s.site.includes('→ gated ')).length
    expect(
      direct,
      '存在未被字面量正则捕获的 acquireTaskGate 调用点（动态 action 变量或签名变化）',
    ).toBe(occurrences)
    const gated = sites.filter((s) => s.site.includes('→ gated ')).length
    expect(
      gated,
      '存在未被字面量正则捕获的 runGatedGeneration 调用点（动态 action / opts 形状变化）',
    ).toBe(gatedOccurrences)
  })
})
