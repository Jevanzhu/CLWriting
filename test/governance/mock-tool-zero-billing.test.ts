/**
 * R26-27（二十六轮）：mock 快路零计费契约对账（静态扫 + 运行时 spec 双面门）。
 *
 * 根因：tryMockTool 未命中（MOCK_TOOL_INPUT 缺键）时返回 null，runner 落回真实
 * provider 路径——CLWRITING_DRIVER=mock 本应是零成本环境，缺一键就变成「配了
 * provider 就在 mock 模式发真实计费调用」。dd-P2 事故（submit_relations 漏键）
 * 即此型，当时靠人肉补键，无门禁拦下一次。
 *
 * 语义：凡可达 tryMockTool 的 toolName（specs.ts 各 spec 的 mock 声明 + 调用点
 * 字面量）必须都有 mock input 键；反向不要求（键集允许暂时超集）。
 *
 * 测法：① 运行时枚举 specs 模块全部导出 + 工厂样例调用，tool 型 mock 的
 * toolName ⊆ MOCK_TOOL_INPUT 键集（AnalysisKind 用 Record<AnalysisKind,true>
 * 穷举守卫——新 kind 漏列直接编译红，不用运行时才发现）；② 静态扫 src/ 全部
 * .ts 的 `toolName: '<lit>'` / `mockTool: '<lit>'` / `analysisSpec('<kind>')`
 * 字面量，逐一对账键集（新增调用面漏补键在此炸响）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_TOOL_INPUT } from '../../src/ai/mock-tool.js'
import {
  OUTLINE_SPEC,
  ONBOARD_SPEC,
  LEAD_UPDATE_SPEC,
  SUMMARY_CHAPTER_SPEC,
  SUMMARY_VOLUME_SPEC,
  streamSpec,
  REWRITE_SPEC,
  reviewSpec,
  analysisSpec,
  selfHealSpec,
  CHAT_SPEC,
  RELATION_MINE_SPEC,
} from '../../src/ai/tasks/specs.js'
import type { AnalysisKind } from '../../src/ai/contract/analysis.js'
import type { TaskSpec } from '../../src/ai/tasks/spec.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** AnalysisKind 穷举守卫：漏一个 kind 即编译错（TS excess/missing property 双向拦） */
const ALL_ANALYSIS_KINDS: Record<AnalysisKind, true> = {
  score: true,
  emotion: true,
  hooks: true,
  style: true,
  tags: true,
  infer_meta: true,
}

/** 收集一个 spec 的 tool 型 mock toolName（text 型返回 null 不入账） */
function toolMockName(spec: TaskSpec): string | null {
  return spec.mock?.kind === 'tool' ? spec.mock.toolName : null
}

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

describe('R26-27：mock 快路零计费契约对账', () => {
  const keys = new Set(Object.keys(MOCK_TOOL_INPUT))

  it('运行时：全部 spec 声明（静态导出 + 工厂样例调用）的 tool 型 mock 都有 mock input 键', () => {
    const staticSpecs: Array<[string, TaskSpec]> = [
      ['OUTLINE_SPEC', OUTLINE_SPEC],
      ['ONBOARD_SPEC', ONBOARD_SPEC],
      ['LEAD_UPDATE_SPEC', LEAD_UPDATE_SPEC],
      ['SUMMARY_CHAPTER_SPEC', SUMMARY_CHAPTER_SPEC],
      ['SUMMARY_VOLUME_SPEC', SUMMARY_VOLUME_SPEC],
      ['REWRITE_SPEC', REWRITE_SPEC],
      ['CHAT_SPEC', CHAT_SPEC],
      ['RELATION_MINE_SPEC', RELATION_MINE_SPEC],
    ]
    // 工厂：lens/kind 形参只影响 system prompt 或 tier，toolName 不随形参漂移的
    // 工厂（review/selfHeal/stream）各取一个样例即可；analysis 的 toolName 随
    // kind 变，须按穷举守卫逐 kind 调用。
    const factorySpecs: Array<[string, TaskSpec]> = [
      ['streamSpec(long)', streamSpec('示例角色', 'long')],
      ['reviewSpec(示例镜)', reviewSpec('示例镜')],
      ['selfHealSpec(long)', selfHealSpec('long')],
      ['selfHealSpec(short)', selfHealSpec('short')],
      ...Object.keys(ALL_ANALYSIS_KINDS).map(
        (k) => [`analysisSpec(${k})`, analysisSpec(k as AnalysisKind)] as [string, TaskSpec],
      ),
    ]
    const missing: string[] = []
    for (const [label, spec] of [...staticSpecs, ...factorySpecs]) {
      const name = toolMockName(spec)
      if (name && !keys.has(name)) missing.push(`${label} → ${name}`)
    }
    expect(missing, `缺 mock input 键的 spec（mock 模式会漏斗到真实计费）：\n${missing.join('\n')}`).toEqual([])
  })

  it('静态扫：src/ 全部 toolName/mockTool 字面量与 analysisSpec 调用面都在键集内', () => {
    const litRe = /(?:toolName|mockTool):\s*'([a-z_]+)'/g
    const kindRe = /analysisSpec\('([a-z_]+)'\)/g
    const missing: string[] = []
    let litHits = 0
    let kindHits = 0
    for (const f of listTs(join(root, 'src'))) {
      const src = readFileSync(f, 'utf-8')
      for (const m of src.matchAll(litRe)) {
        litHits++
        if (!keys.has(m[1]!)) missing.push(`${relative(root, f)} → ${m[1]}`)
      }
      for (const m of src.matchAll(kindRe)) {
        kindHits++
        if (!keys.has(`submit_${m[1]}`)) missing.push(`${relative(root, f)} → analysisSpec('${m[1]}') ⇒ submit_${m[1]}`)
      }
    }
    expect(litHits, '扫描面非空（防 src 布局大改后空转绿灯）').toBeGreaterThan(0)
    expect(missing, `字面量对账失败：\n${missing.join('\n')}`).toEqual([])
    // kindHits 可为 0（调用点经变量传 kind），字面量键对账已由 litRe 覆盖该面
    void kindHits
  })
})
