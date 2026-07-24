/**
 * G5 依赖方向守护（M10 §2）—— 编辑器/底座源码不得 import AI 生成层。
 *
 * 防回潮：G1/G2 已清 document 的死代码违规；本测试常驻，断言不新增反向依赖。
 * 已知业务依赖（非死代码，待后续接口反转/下沉治理）入 KNOWN 白名单；
 * 某条治理后从白名单移除，第二个用例会提醒清理。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 编辑器/底座模块（禁止 import AI 生成层）。review 归编辑器辅助，同守。 */
const EDITOR_BASE = [
  'document', 'fs', 'format', 'cache', 'git',
  'export', 'import', 'install', 'metrics', 'impact', 'check', 'review',
]
/** AI 生成层模块（被禁目标）。 */
const AI_LAYER = [
  'ai', 'auto', 'driver', 'finalize', 'gate', 'knowledge', 'learn',
  'process', 'rag', 'reconcile', 'roles', 'session', 'state',
]

/**
 * 已知例外（待治理）：编辑器/底座 → AI 的现存业务依赖。
 * 从白名单移除即视为已治理（第二个用例会校验 import 是否真消失）。
 */
const KNOWN = new Set([
  'src/metrics/collect.ts:ai',   // readAiCallBudget 读 AI 调用预算
  'src/install/init.ts:roles',   // generateRoleShells 建书生成角色壳
  'src/install/update.ts:roles', // generateRoleShells 更新生成角色壳
])

const AI_RE = new RegExp(`from\\s+['"](?:\\.\\./)+(${AI_LAYER.join('|')})/`)

/** 递归收集目录下所有 .ts 文件（排除 .d.ts 与 macOS ._ 垃圾）。 */
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

/** 扫描编辑器/底座 → AI 生成层的 import；返回非白名单违规。 */
function scanViolations(): string[] {
  const violations: string[] = []
  for (const mod of EDITOR_BASE) {
    const dir = join('src', mod)
    if (!existsSync(dir)) continue
    for (const file of listTs(dir)) {
      const rel = relative('.', file).replaceAll('\\', '/')
      const lines = readFileSync(file, 'utf-8').split('\n')
      for (const line of lines) {
        const m = line.match(AI_RE)
        if (!m) continue
        const aiModule = m[1]
        if (!aiModule) continue
        if (!KNOWN.has(`${rel}:${aiModule}`)) {
          violations.push(`${rel}:${aiModule}  ←  ${line.trim()}`)
        }
      }
    }
  }
  return violations
}

describe('G5 依赖方向守护', () => {
  it('编辑器/底座源码无 AI 生成层 import（KNOWN 白名单除外）', () => {
    const violations = scanViolations()
    expect(
      violations,
      '编辑器/底座出现新的 AI 生成层 import。若为合理依赖，登记入 KNOWN 白名单并注明后续治理:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('KNOWN 白名单条目仍实际存在（防止白名单变僵尸）', () => {
    const stale: string[] = []
    for (const key of KNOWN) {
      const idx = key.indexOf(':')
      const file = key.slice(0, idx)
      const aiModule = key.slice(idx + 1)
      if (!existsSync(file)) {
        stale.push(`${key}  ← 文件已不存在`)
        continue
      }
      const re = new RegExp(`from\\s+['"](?:\\.\\./)+${aiModule}/`)
      if (!re.test(readFileSync(file, 'utf-8'))) {
        stale.push(`${key}  ← import 已消失，可从白名单移除（视为已治理）`)
      }
    }
    expect(
      stale,
      'KNOWN 白名单有条目已过时（对应 import 已治理，应移除以反映现状）:\n' + stale.join('\n'),
    ).toEqual([])
  })
})
