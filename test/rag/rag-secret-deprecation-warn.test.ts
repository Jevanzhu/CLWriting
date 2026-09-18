/**
 * 0918二轮修复批（G101）：旧版明文 embedding 密钥通道 .clwriting/rag.secret 的
 * 弃用提示回归。
 *
 * 修前：readApiKey 直读明文文件零提示——与新链路（ragProviders → vault 加密存储）
 * 保护等级不一，工作目录在同步盘时明文 key 随之上云，且作者无从知晓该通道将移除。
 * 修后：文件存在且 key 被实际取用（env 未覆盖、文件非空）时打一次性 deprecation
 * warn 引导迁移；读取行为逐位不变（存量用户不破坏）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApiKey } from '../../src/rag/config.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** 落一个明文 rag.secret（返回工作目录） */
function workDirWithSecret(content: string): string {
  const wd = mkdtempTracked(join(tmpdir(), 'clw-rag-secret-deprecate-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  writeFileSync(join(wd, '.clwriting', 'rag.secret'), content, 'utf-8')
  return wd
}

describe('rag.secret 弃用提示（一次性 warn，读取行为不变）', () => {
  it('文件存在且 key 被实际取用 → key 正常返回 + 弃用 warn 恰一次（重复读取不刷屏）', () => {
    vi.stubEnv('CLWRITING_RAG_API_KEY', '')
    const wd = workDirWithSecret('sk-legacy-plain-key\n')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    // 读取行为不变：两次读取都拿到文件里的明文 key
    expect(readApiKey(wd)).toBe('sk-legacy-plain-key')
    expect(readApiKey(wd)).toBe('sk-legacy-plain-key')

    const hits = warn.mock.calls.filter((c) => String(c[1]).includes('rag.secret'))
    expect(hits).toHaveLength(1) // 模块级一次性标志：第二次读取不再 warn
    expect(String(hits[0]![1])).toContain('供应商配置')
    expect(String(hits[0]![1])).toContain('后续版本将移除')
  })

  it('无 rag.secret → null 且零弃用 warn；空文件（key 未被取用）同样不 warn', () => {
    vi.stubEnv('CLWRITING_RAG_API_KEY', '')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    const empty = mkdtempTracked(join(tmpdir(), 'clw-rag-secret-none-'))
    expect(readApiKey(empty)).toBeNull()
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('rag.secret'))).toHaveLength(0)

    // 文件在但内容空白：key 未被取用（原行为返回 null），不触发弃用提示
    const blank = workDirWithSecret('   \n')
    expect(readApiKey(blank)).toBeNull()
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('rag.secret'))).toHaveLength(0)
  })

  it('env 覆盖时文件未被读用 → key 来自 env、不 warn（优先级行为不变）', () => {
    vi.stubEnv('CLWRITING_RAG_API_KEY', 'sk-from-env')
    const wd = workDirWithSecret('sk-legacy-plain-key\n')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    expect(readApiKey(wd)).toBe('sk-from-env')
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('rag.secret'))).toHaveLength(0)
  })
})
