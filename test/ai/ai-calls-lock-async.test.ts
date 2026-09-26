/**
 * ai-calls / providers.json 跨进程写锁异步等待（R30-3）：锁被占时记账/配置写等待
 * 期间事件循环可响应（定时器正常触发）；无争用快路保持同步完成（「记完即读」/
 * 「存完即读」不变）；超时语义不变（封顶上抛→改为旁挂留痕、不写盘）。
 *
 * 档源：r30-batch-a.test.ts（三十轮批 A）拆分——R30-3 半（本文件）与 R30-4/10/12
 * provider 半（anthropic-degrade-request-guards.test.ts）按被测域分家。断言逐条
 * 保留、去重 0 条。P3-5 确定性化：原 sleep(40/60) 定长睡改 vi.waitFor 轮询定时器
 * 翻转（「等待窗内事件循环可响应」的观察面不变，慢腿不再赌定长窗）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { recordAiCall, __setAiCallsLockTimeoutForTest } from '../../src/ai/calls.js'
import { saveProviders, loadProviders, emptySettings, type ProviderStore } from '../../src/ai/provider/store.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'

const workDirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempTracked(join(tmpdir(), prefix))
  workDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  __setAiCallsLockTimeoutForTest(5_000) // 防超时注入泄漏到他用例
})

// ── R30-3：ai-calls 记账锁 ──────────────────────────────────────────────

describe('R30-3：ai-calls 跨进程锁等待改异步', () => {
  it('锁被占：recordAiCall 等待期间定时器照常触发；释放后账目落地', async () => {
    const bookRoot = tempDir('r30-calls-')
    const callsFp = join(bookRoot, '.cache', 'ai-calls.json')
    // 模拟另一进程持锁（同源锁原语，测试进程自身持有 = 对记账写段表现为「他者在持」）
    const release = tryAcquireCrossProcessLock(`${callsFp}.lock`)
    expect(release).not.toBeNull()
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 30)
    // 锁被占 → 进入异步轮询等待，同步立即返回（不冻结事件循环）
    recordAiCall(bookRoot, 3, { inputTokens: 7, outputTokens: 9 })
    // 等待窗口内事件循环可响应（P3-5：轮询定时器翻转替代 sleep(60) 定长窗；实现若
    // 同步阻塞事件循环，waitFor 轮询同样无法在窗内见到翻转 → 超时红，语义不弱化）
    await vi.waitFor(() => expect(timerFired).toBe(true))
    expect(existsSync(callsFp)).toBe(false) // 锁未放 → 账目未写
    release!()
    // 释放后在途写段落地（异步轮询 20ms 级拿到锁）
    await vi.waitFor(() => expect(existsSync(callsFp)).toBe(true))
    const rec = JSON.parse(readFileSync(callsFp, 'utf8')) as {
      chapter: { num: number; used: number; inputTokens: number; outputTokens: number }
    }
    expect(rec.chapter).toMatchObject({ num: 3, used: 1, inputTokens: 7, outputTokens: 9 })
  }, 15_000)

  it('锁被占至超时：无同步抛出、账目未记、失败 warn 留痕', async () => {
    const bookRoot = tempDir('r30-calls-timeout-')
    const callsFp = join(bookRoot, '.cache', 'ai-calls.json')
    __setAiCallsLockTimeoutForTest(80) // 注入短超时保测试快
    const release = tryAcquireCrossProcessLock(`${callsFp}.lock`)
    expect(release).not.toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 20)
    // 超时路径不再同步抛（在途 promise rejection 由 serializedWrite 旁挂留痕处理）
    expect(() => recordAiCall(bookRoot, 3, { inputTokens: 1, outputTokens: 1 })).not.toThrow()
    // 等待期间事件循环可响应（同上：轮询定时器翻转替代 sleep(40) 定长窗）
    await vi.waitFor(() => expect(timerFired).toBe(true))
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(120) 真实睡眠定长追赶注入的
    // 80ms 锁超时——慢机/事件循环停滞下竞速翻车；改小步轮询直到超时 warn 留痕落地
    // （deadline 2s 到点未达即红：「超时未触发」的回归仍能被抓到，语义不弱化）
    const warnText = () => warn.mock.calls.map((a) => a.map(String).join(' ')).join('\n')
    await vi.waitFor(() => expect(warnText()).toContain('超时'), { timeout: 2_000, interval: 5 })
    expect(existsSync(callsFp)).toBe(false) // 本轮账目未记（避免交错覆盖丢账的保守口径不变）
    release!()
    warn.mockRestore()
  }, 15_000)

  it('无争用快路：recordAiCall 调用返回时账目已同步落盘（记完即读不变）', () => {
    const bookRoot = tempDir('r30-calls-fast-')
    const callsFp = join(bookRoot, '.cache', 'ai-calls.json')
    recordAiCall(bookRoot, 1, { inputTokens: 5, outputTokens: 6 })
    expect(existsSync(callsFp)).toBe(true)
    const rec = JSON.parse(readFileSync(callsFp, 'utf8')) as { chapter: { used: number } }
    expect(rec.chapter.used).toBe(1)
  })
})

// ── R30-3：providers.json 配置写锁 ──────────────────────────────────────

function storeOf(id: string): ProviderStore {
  const s = emptySettings()
  s.providers = [
    {
      id,
      name: 'r30',
      protocol: 'openai',
      auth: 'bearer',
      baseUrl: 'https://api.test.com/v1',
      model: 'test-model',
      apiKey: `sk-${id}-secret`,
      caps: null,
      sortIndex: 0,
    },
  ]
  s.currentId = id
  return s
}

describe('R30-3：providers.json 跨进程锁等待改异步', () => {
  it('锁被占：saveProviders 返回在途 promise，等待期间定时器触发；释放后配置落盘', async () => {
    const dir = tempDir('r30-store-')
    const fp = join(dir, 'providers.json')
    const release = tryAcquireCrossProcessLock(`${fp}.lock`)
    expect(release).not.toBeNull()
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 30)
    const p = saveProviders(dir, storeOf('prov-r30'))
    let settled = false
    void p.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    // 等待窗口内事件循环可响应（同上：轮询定时器翻转替代 sleep(60) 定长窗）
    await vi.waitFor(() => expect(timerFired).toBe(true))
    expect(settled).toBe(false) // 锁未放 → 写段在途
    expect(existsSync(fp)).toBe(false)
    release!()
    await expect(p).resolves.toBeUndefined()
    const loaded = loadProviders(dir)
    expect(loaded.providers.map((x) => x.id)).toEqual(['prov-r30'])
  }, 15_000)

  it('无争用快路：saveProviders 调用返回时配置已同步落盘（存完即读不变）', () => {
    const dir = tempDir('r30-store-fast-')
    const fp = join(dir, 'providers.json')
    const p = saveProviders(dir, storeOf('prov-sync'))
    // 快路同步完成——loadProviders 迁移写回的 R71-18 紧邻读回校验依赖此同步性
    expect(existsSync(fp)).toBe(true)
    expect(loadProviders(dir).providers[0]!.id).toBe('prov-sync')
    return expect(p).resolves.toBeUndefined()
  })
})
