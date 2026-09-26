/**
 * R0916-6-P3-3（2026-09-16 全库重评五轮修复批）：chat 任务按书预算闸。
 *
 * 背景：book.yaml 预算闸此前仅对写稿链生效（self-heal 前置 checkAiCallBudget +
 * runTask chapter 块记账），chat 路径（task:'chat'，无 chapter）只受 5 轮 × 重试 +
 * deadline 兜底，长对话成功轮次累积无按书配额。修复：book.yaml budget 段新增可选键
 * chat_max_calls，runner runTask 入口闸检（task==='chat' 且有 bookRoot 时）。
 *
 * 覆盖：缺省不限（零行为变化）/ 配了未达限放行且记账 / 达限拦截（不触 run、GEN_FAIL
 * 人话文案、日志留痕）/ 非法值 parse 面 fail-closed 落 0（宁拦勿放）/ 账本损坏保守阻断
 * （V-P2-10 同款）/ 键为 chat 专属（self-heal 链不受该键影响）/ schema 三面形态
 * （往返落行、短篇 budget 段保留判定）。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTask } from '../../src/ai/runner.js'
import { parseBookConfig, stringifyBookConfig, readBookConfig } from '../../src/format/yaml.js'
import { processProviderRuntime } from '../../src/ai/provider/store.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function tempBook(bookYaml: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'clwriting-chat-budget-'))
  writeFileSync(join(root, 'book.yaml'), bookYaml, 'utf-8')
  return root
}

function tempUserData(): string {
  return mkdtempTracked(join(tmpdir(), 'clwriting-chat-budget-ud-'))
}

/** 写最小 providers.json（run 回调桩不触网络，baseUrl 形参而已） */
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
          baseUrl: 'http://127.0.0.1:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-test',
      currentModel: 'gpt-4o',
    }),
  )
}

/** 预置合法形状的 ai-calls.json（readRecord 对缺 chapter 块/坏值判损坏） */
function seedLedger(bookRoot: string, chatUsed: number): void {
  mkdirSync(join(bookRoot, '.cache'), { recursive: true })
  writeFileSync(
    join(bookRoot, '.cache', 'ai-calls.json'),
    JSON.stringify({
      chapter: { num: 0, used: 0, inputTokens: 0, outputTokens: 0 },
      tasks: { chat: { used: chatUsed, inputTokens: 0, outputTokens: 0 } },
    }),
    'utf-8',
  )
}

const RUN_RET = { text: 'ok', usage: { inputTokens: 11, outputTokens: 7 } }

afterEach(() => {
  vi.restoreAllMocks()
  processProviderRuntime().__resetForTest()
})

describe('chat 按书预算闸（budget.chat_max_calls）', () => {
  it('缺省（未设键）= 不限：放行且零闸行为', async () => {
    const root = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n')
    const ud = tempUserData()
    writeProviders(ud)
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<{ text: string }>({
      userDataPath: ud,
      task: 'chat',
      bookRoot: root,
      run: () => {
        calls++
        return Promise.resolve(RUN_RET)
      },
    })
    expect(out.ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('配了未达限 → 放行，tasks.chat 记账照常累计', async () => {
    const root = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 2\n')
    seedLedger(root, 1)
    const ud = tempUserData()
    writeProviders(ud)
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<{ text: string }>({
      userDataPath: ud,
      task: 'chat',
      bookRoot: root,
      run: () => {
        calls++
        return Promise.resolve(RUN_RET)
      },
    })
    expect(out.ok).toBe(true)
    expect(calls).toBe(1)
    // 记账面：本次 runTask 已入 tasks.chat 块（闸与账同源）
    const ledger = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf-8')) as {
      tasks: { chat: { used: number } }
    }
    expect(ledger.tasks.chat.used).toBe(2)
  })

  it('达到上限 → 拦截：GEN_FAIL 人话文案，不触 run，日志留痕', async () => {
    const root = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 2\n')
    seedLedger(root, 2)
    const ud = tempUserData()
    writeProviders(ud)
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<{ text: string }>({
      userDataPath: ud,
      task: 'chat',
      bookRoot: root,
      run: () => {
        calls++
        return Promise.resolve(RUN_RET)
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    if (!out.ok) {
      expect(out.error).toContain('chat_max_calls')
      expect(out.error).toContain('上限')
    }
    expect(calls).toBe(0)
    const gateWarns = warnSpy.mock.calls.map((c) => String(c[1])).filter((m) => m.includes('chat 任务预算闸拦截'))
    expect(gateWarns).toHaveLength(1)
    expect(JSON.parse(gateWarns[0]!)).toMatchObject({ code: 'BUDGET_EXCEEDED', used: 2, task: 'chat' })
  })

  it('键值非法 → parse 面 fail-closed 落 0 = 全部阻断（宁拦勿放）', async () => {
    const root = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: abc\n')
    const ud = tempUserData()
    writeProviders(ud)
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    // parse 面哨兵：坏值落 0（闸侧 0 = 一次都不许调，R40-8 同语义）；走 readBookConfig
    // 与 runner 闸检同一取值路径
    const parsed = readBookConfig(join(root, 'book.yaml'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.budget.chat_max_calls).toBe(0)
    // 随批评审夹紧（2026-09-16 nano-2）：正小数同走 fail-closed 落 0——次数口径键
    // 只收正整数（0.5 此前直穿、实效 ≈1 次，安全方向怪形），warn 文案同步非正整数
    const warns: string[] = []
    warnSpy.mockImplementation((_ch: string, msg: string) => {
      warns.push(String(msg))
    })
    const fracRoot = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 0.5\n')
    const frac = readBookConfig(join(fracRoot, 'book.yaml'))
    expect(frac.ok).toBe(true)
    if (frac.ok) expect(frac.config.budget.chat_max_calls).toBe(0)
    expect(warns.some((w) => w.includes('值非正整数'))).toBe(true)
    // 合法正整数不受夹紧影响
    const okRoot = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 3\n')
    const okc = readBookConfig(join(okRoot, 'book.yaml'))
    expect(okc.ok).toBe(true)
    if (okc.ok) expect(okc.config.budget.chat_max_calls).toBe(3)
    let calls = 0
    const out = await runTask<{ text: string }>({
      userDataPath: ud,
      task: 'chat',
      bookRoot: root,
      run: () => {
        calls++
        return Promise.resolve(RUN_RET)
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    if (!out.ok) expect(out.error).toContain('一次都不许调')
    expect(calls).toBe(0)
  })

  it('账本损坏 + 配了闸 → 保守阻断（V-P2-10 同款）', async () => {
    const root = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 5\n')
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), '{ broken', 'utf-8')
    const ud = tempUserData()
    writeProviders(ud)
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<{ text: string }>({
      userDataPath: ud,
      task: 'chat',
      bookRoot: root,
      run: () => {
        calls++
        return Promise.resolve(RUN_RET)
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    if (!out.ok) expect(out.error).toContain('损坏')
    expect(calls).toBe(0)
  })

  it('键为 chat 专属：self-heal 链（带 chapter）不受 chat_max_calls 影响', async () => {
    const root = tempBook('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 0\n')
    const ud = tempUserData()
    writeProviders(ud)
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<{ text: string }>({
      userDataPath: ud,
      task: 'self-heal',
      bookRoot: root,
      chapter: 1,
      run: () => {
        calls++
        return Promise.resolve(RUN_RET)
      },
    })
    expect(out.ok).toBe(true)
    expect(calls).toBe(1)
  })
})

describe('chat_max_calls schema 三面形态', () => {
  it('设了才落行；往返保真', () => {
    const set = parseBookConfig('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 3\n')
    expect(set.ok).toBe(true)
    if (!set.ok) return
    expect(set.config.budget.chat_max_calls).toBe(3)
    const text = stringifyBookConfig(set.config)
    expect(text).toContain('chat_max_calls: 3')
    const back = parseBookConfig(text)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.config.budget.chat_max_calls).toBe(3)
  })

  it('未设不落行；显式 0（fail-closed 哨兵）落行保真', () => {
    const unset = parseBookConfig('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n')
    expect(unset.ok).toBe(true)
    if (unset.ok) {
      expect(unset.config.budget.chat_max_calls).toBeUndefined()
      expect(stringifyBookConfig(unset.config)).not.toContain('chat_max_calls')
    }
    const zero = parseBookConfig('spec_version: 1\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 0\n')
    expect(zero.ok).toBe(true)
    if (!zero.ok) return
    expect(zero.config.budget.chat_max_calls).toBe(0)
    const text = stringifyBookConfig(zero.config)
    expect(text).toContain('chat_max_calls: 0')
  })

  it('短篇只设 chat_max_calls → budget 段保留（R26-10 判定并入该键）', () => {
    const cfg = parseBookConfig(
      'spec_version: 1\nkind: short\n\nhost: cc\n\nbook:\n  title: X\n\nbudget:\n  chat_max_calls: 3\n',
    )
    expect(cfg.ok).toBe(true)
    if (!cfg.ok) return
    const text = stringifyBookConfig(cfg.config)
    expect(text).toContain('budget:')
    expect(text).toContain('chat_max_calls: 3')
  })
})
