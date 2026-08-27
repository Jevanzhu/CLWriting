/**
 * Y-2（第五十七轮）回归：runSpec 的 rules 注入段源文件进 llm/call promptMeta.files。
 *
 * 铁律①「模型可见⟺已记录」：rulesToPrompt 拼入 system 的两个动态源——条目库
 * AI味标签禁词与 .cache/rule-hits.json（Top-N 预防指令）——此前既不进 promptFiles
 * 也没有 digest 事件，事后仅凭合并哈希无法重建当时的注入词表。修复后随 runSpec
 * 一并登记（与 user prompt 材料 promptFiles 同通道）；空源（无词表/无命中）不登记
 * （Q-5「空段不登记」口径）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/ai/gen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/gen.js')>()
  return {
    ...actual,
    generate: vi.fn(async () => ({ text: 'ok', reasoning: '', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 }, stopReason: 'end_turn' })),
  }
})

import { runSpec, type TaskSpec } from '../../src/ai/tasks/spec.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'

const workDirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(d)
  return d
}

function writeProviders(userDataPath: string): void {
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-test',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-test',
      currentModel: 'gpt-4o',
    }),
  )
}

const TEXT_SPEC: TaskSpec = {
  name: 'spawn-write',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: '你是网文写作引擎',
}

interface CallEvent {
  data: { promptMeta?: { files?: string[] } }
}

function readCallFiles(ud: string, bookRoot: string): string[] {
  const store = openSessionStore(ud, bookRoot)!
  const evs = store.listEvents(bookHash(bookRoot))
  const call = evs.find((e) => e.type === 'llm/call') as CallEvent | undefined
  expect(call).toBeDefined()
  return call!.data.promptMeta!.files ?? []
}

describe('Y-2（第五十七轮）：rules 注入段源文件登记', () => {
  afterEach(() => {
    try { for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true }) } catch {
          // Windows 清理竞态（防病毒/句柄占用偶发 EPERM）——best-effort 忽略
        }
  })

  it('AI味词表与 rule-hits 均注入时，两源进 promptMeta.files', async () => {
    const ud = tempDir('clw-y2-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-y2-book-')
    // 条目库：一条 AI味标签禁词（fm + 正文）
    mkdirSync(join(bookRoot, '文风', '条目', '禁词'), { recursive: true })
    writeFileSync(
      join(bookRoot, '文风', '条目', '禁词', 'a.md'),
      '---\n类型: 禁词\n场景: 通用\n标签: [AI味]\n说明: 删掉\n---\n仿佛命运的齿轮开始转动\n',
    )
    // rule-hits：一条高频命中
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    writeFileSync(
      join(bookRoot, '.cache', 'rule-hits.json'),
      JSON.stringify({ 'ai-cliche': { ruleId: 'ai-cliche', hits: 4, lastHit: '2026-08-24T00:00:00Z', recentMessages: ['开头雷同'] } }),
    )

    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第二章', bookRoot })
    expect(out.ok).toBe(true)
    const files = readCallFiles(ud, bookRoot)
    expect(files).toContain('文风/条目/禁词')
    expect(files).toContain('.cache/rule-hits.json')
  })

  it('空源不登记（无词表、无命中 → files 不含两源）', async () => {
    const ud = tempDir('clw-y2-ud2-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-y2-book2-')

    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第二章', bookRoot })
    expect(out.ok).toBe(true)
    const files = readCallFiles(ud, bookRoot)
    expect(files).not.toContain('文风/条目/禁词')
    expect(files).not.toContain('.cache/rule-hits.json')
  })
})

// ── A8（五十九轮）：rules 注入文本与登记清单同一次读盘派生（单源）────────────────
// 修复背景：rulesToPrompt 与 rulesPromptFiles 各自独立读盘（loadAiFlavorRule ×2、
// topRuleHits ×2），微观窗口文件变更可使「注入文本」与「登记清单」撕裂。修复：新增
// rulesPromptParts 单源派生，runSpec 内一次读出文本+清单；旧两导出为同源薄壳。
import { rulesToPrompt, rulesPromptFiles, rulesPromptParts } from '../../src/ai/rules/index.js'
import { topRuleHits } from '../../src/ai/rule-hits.js'

vi.mock('../../src/ai/rule-hits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/rule-hits.js')>()
  return { ...actual, topRuleHits: vi.fn(actual.topRuleHits) }
})

describe('A8（五十九轮）：rules 注入与登记单源派生', () => {
  afterEach(() => {
    try { for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true }) } catch {
          // Windows 清理竞态（防病毒/句柄占用偶发 EPERM）——best-effort 忽略
        }
    vi.mocked(topRuleHits).mockClear()
  })

  it('rulesPromptParts 单源：prompt === rulesToPrompt、files === rulesPromptFiles（两薄壳不撕裂）', () => {
    const ud = tempDir('clw-a8-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-a8-book-')
    mkdirSync(join(bookRoot, '文风', '条目', '禁词'), { recursive: true })
    writeFileSync(
      join(bookRoot, '文风', '条目', '禁词', 'a.md'),
      '---\n类型: 禁词\n场景: 通用\n标签: [AI味]\n说明: 删掉\n---\n仿佛命运的齿轮开始转动\n',
    )
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    writeFileSync(
      join(bookRoot, '.cache', 'rule-hits.json'),
      JSON.stringify({ 'ai-cliche': { ruleId: 'ai-cliche', hits: 4, lastHit: '2026-08-24T00:00:00Z', recentMessages: ['开头雷同'] } }),
    )
    const parts = rulesPromptParts('spawn-write', bookRoot)
    // 两薄壳与单源产物逐字相等——任一侧单独读盘的撕裂窗口不存在
    expect(parts.prompt).toBe(rulesToPrompt('spawn-write', bookRoot))
    expect(parts.files).toEqual(rulesPromptFiles('spawn-write', bookRoot))
    expect(parts.files).toContain('文风/条目/禁词')
    expect(parts.files).toContain('.cache/rule-hits.json')
    expect(parts.prompt).toContain('仿佛命运的齿轮开始转动')
    expect(parts.prompt).toContain('开头雷同')
  })

  it('runSpec 一次调用只读一次 rule-hits（原两函数各自读盘 = 2 次）', async () => {
    const ud = tempDir('clw-a8-ud2-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-a8-book2-')
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    writeFileSync(
      join(bookRoot, '.cache', 'rule-hits.json'),
      JSON.stringify({ 'ai-cliche': { ruleId: 'ai-cliche', hits: 2, lastHit: '2026-08-24T00:00:00Z', recentMessages: ['开头雷同'] } }),
    )
    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第三章', bookRoot })
    expect(out.ok).toBe(true)
    // 单源：文本派生与清单登记共用同一次 topRuleHits 读盘
    expect(topRuleHits).toHaveBeenCalledTimes(1)
  })
})
