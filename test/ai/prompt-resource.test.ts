/**
 * C2 资源层单测：
 * - 一致性（离线重算，cherry catalog-source-sync 同族）：versions.json 末位哈希
 *   = 实际资源文件哈希；每个键有对应文件
 * - 资源化零失真：loadBuiltinPrompt 逐字等于 C1 金测夹具（迁移链的证据）
 * - overlay 解析：存在即优先生效
 * - 迁移（A6）：未改动旧版拷贝升级、用户改过保留、已是当前版跳过
 * - 精确匹配：命中历史哈希定位内置名；runner 入口换 overlay/当前内置
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const golden = JSON.parse(
  readFileSync(new URL('./__fixtures__/prompts-golden.json', import.meta.url), 'utf8'),
) as Record<string, string>
import { bundledResource } from '../../src/fs/resources.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  promptHash,
  loadBuiltinPrompt,
  builtinPromptNames,
  resolvePrompt,
  migratePromptOverlays,
  matchBuiltinPrompt,
  resolveBuiltinSystemPrompt,
  type PromptRegistry,
} from '../../src/ai/prompts/resource.js'

const NAMES = [
  'writer-long',
  'writer-short',
  'rewriter',
  'analyst',
  'review-common',
  'review-reader',
  'review-editor',
  'review-continuity',
  'review-hook',
  'review-emotion_peak',
  'review-payoff',
]

describe('C2 一致性（离线重算）', () => {
  it('versions.json：每键有文件、末位哈希 = 当前文件哈希（内容哈希版本戳不失真）', () => {
    const versions = JSON.parse(readFileSync(bundledResource('prompts', 'versions.json'), 'utf8')) as Record<string, string[]>
    expect(Object.keys(versions).sort()).toEqual(NAMES.map((n) => `${n}.md`).sort())
    for (const [file, hashes] of Object.entries(versions)) {
      const raw = readFileSync(bundledResource('prompts', file), 'utf8')
      const canonical = raw.endsWith('\n') ? raw.slice(0, -1) : raw
      expect(hashes![hashes!.length - 1]).toBe(promptHash(canonical))
    }
    expect(builtinPromptNames().sort()).toEqual([...NAMES].sort())
  })

  it('资源化零失真：loadBuiltinPrompt 逐字等于重构前快照', () => {
    for (const n of NAMES) {
      expect(loadBuiltinPrompt(n).text).toBe(golden[n])
    }
  })

  it('promptHash 内容寻址：同文同哈希、异文异哈希', () => {
    expect(promptHash('abc')).toBe(promptHash('abc'))
    expect(promptHash('abc')).not.toBe(promptHash('abd'))
    expect(promptHash('abc')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('C2 overlay 解析', () => {
  it('无 overlay → 内置；有 overlay → overlay 优先生效', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'clwriting-prompt-ov-'))
    try {
      expect(resolvePrompt('writer-long', ud).source).toBe('builtin')
      mkdirSync(join(ud, 'prompts'), { recursive: true })
      writeFileSync(join(ud, 'prompts', 'writer-long.md'), '我的自定义写手人设\n', 'utf8')
      const r = resolvePrompt('writer-long', ud)
      expect(r.source).toBe('overlay')
      expect(r.text).toBe('我的自定义写手人设')
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })
})

/** 造 mini 捆绑源：v1 旧版文案 + 当前 v2 文案，历史表含两版哈希 */
function miniRegistry(): { registry: PromptRegistry; v1: string; v2: string } {
  const v1 = '内置写手 prompt 第 1 版'
  const v2 = '内置写手 prompt 第 2 版（改进）'
  const registry: PromptRegistry = {
    readBuiltin: () => v2,
    versions: () => ({ 'writer-long.md': [promptHash(v1), promptHash(v2)] }),
  }
  return { registry, v1, v2 }
}

describe('C2 迁移（A6：升级不覆盖用户改动）', () => {
  it('未改动的旧版拷贝 → 升级为当前内置', () => {
    const { registry, v1, v2 } = miniRegistry()
    const ud = mkdtempTracked(join(tmpdir(), 'clwriting-prompt-mig-'))
    try {
      mkdirSync(join(ud, 'prompts'), { recursive: true })
      writeFileSync(join(ud, 'prompts', 'writer-long.md'), v1 + '\n', 'utf8')
      const r = migratePromptOverlays(ud, registry)
      expect(r.upgraded).toEqual(['writer-long'])
      expect(r.kept).toEqual([])
      expect(readFileSync(join(ud, 'prompts', 'writer-long.md'), 'utf8')).toBe(v2 + '\n')
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('用户改过的拷贝 → 原样保留；已是当前版 → 不写盘不报告；无 overlay → no-op', () => {
    const { registry, v1, v2 } = miniRegistry()
    const ud = mkdtempTracked(join(tmpdir(), 'clwriting-prompt-mig2-'))
    try {
      mkdirSync(join(ud, 'prompts'), { recursive: true })
      writeFileSync(join(ud, 'prompts', 'writer-long.md'), v1 + '\n但用户加了私货\n', 'utf8')
      let r = migratePromptOverlays(ud, registry)
      expect(r.upgraded).toEqual([])
      expect(r.kept).toEqual(['writer-long'])
      expect(readFileSync(join(ud, 'prompts', 'writer-long.md'), 'utf8')).toBe(v1 + '\n但用户加了私货\n')

      writeFileSync(join(ud, 'prompts', 'writer-long.md'), v2 + '\n', 'utf8')
      r = migratePromptOverlays(ud, registry)
      expect(r.upgraded).toEqual([]) // 已当前版：跳过
      expect(r.kept).toEqual([])

      rmSync(join(ud, 'prompts'), { recursive: true, force: true })
      r = migratePromptOverlays(ud, registry)
      expect(r.upgraded).toEqual([])
      expect(existsSync(join(ud, 'prompts'))).toBe(false)
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })
})

describe('C2 哈希精确匹配（CS-19）', () => {
  it('旧版内置文本 → 定位内置名；无关文本 → null', () => {
    const { registry, v1 } = miniRegistry()
    expect(matchBuiltinPrompt(v1, registry)).toBe('writer-long')
    expect(matchBuiltinPrompt(loadBuiltinPrompt('writer-long').text)).toBe('writer-long')
    expect(matchBuiltinPrompt('随便的动态 prompt', registry)).toBeNull()
  })

  it('runner 入口：旧版内置 → overlay 优先，无 overlay → 当前内置；动态 prompt 原样', () => {
    const { registry, v1, v2 } = miniRegistry()
    expect(resolveBuiltinSystemPrompt(v1, undefined, registry)).toBe(v2)
    const ud = mkdtempTracked(join(tmpdir(), 'clwriting-prompt-swap-'))
    try {
      mkdirSync(join(ud, 'prompts'), { recursive: true })
      writeFileSync(join(ud, 'prompts', 'writer-long.md'), '用户改版\n', 'utf8')
      expect(resolveBuiltinSystemPrompt(v1, ud, registry)).toBe('用户改版')
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
    expect(resolveBuiltinSystemPrompt('动态 chat prompt', undefined, registry)).toBe('动态 chat prompt')
    expect(resolveBuiltinSystemPrompt(undefined)).toBeUndefined()
  })
})
