/**
 * 0918三轮修复批（D201）回归：corpus-commit 缺省语料目录解析单源。
 *
 * 修复前按 cwd 相对解析——「从子目录直跑 npx tsx scripts/corpus-commit.ts」把语料
 * 落进仓外 <cwd>/test/corpus/checks/（脚本看似成功、CI 回归门读真仓目录零新增、
 * 静默）。修复后缺省以脚本文件位置锚定仓库根；显式传参原样透传。
 * 抽离缘由：corpus-commit.ts 顶层即执行不可被测试安全 import——解析逻辑单源至
 * scripts/corpus-paths.ts 供直测。
 * 锚：0918三轮修复批 D201。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveCorpusDir } from '../../scripts/corpus-paths.js'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（断言口径靠用例锚定）
import { REPO_ROOT } from '../../scripts/repo-root.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('D201（0918三轮修复批）：corpus 语料目录解析', () => {
  it('缺省解析 = <仓库根>/test/corpus/checks（绝对路径、与 cwd 无关）', () => {
    const dir = resolveCorpusDir(undefined)
    // 修复前缺省走相对路径（cwd 形态），isAbsolute 即判别
    expect(isAbsolute(dir)).toBe(true)
    expect(dir.startsWith(repoRoot)).toBe(true)
    expect(dir.endsWith(join('test', 'corpus', 'checks'))).toBe(true)
  })

  it('显式传参原样透传（不并置仓库根）', () => {
    expect(resolveCorpusDir('/tmp/custom-corpus')).toBe('/tmp/custom-corpus')
    expect(resolveCorpusDir('rel-corpus')).toBe('rel-corpus')
  })
})

/**
 * 评审余面批 E3：scripts 侧仓根定位单源（锚点 = 本档位置，不取 cwd）。
 *
 * test-related.mjs 此前以 `process.cwd()` 当仓根——从子目录/仓外调用时在错误根上做
 * 存在性判定与文本兜底扫描，或直接裸 ENOENT 崩于 scandir `<cwd>/test`（实测），
 * 行为取决于站在哪而非显式报错。现锚点取脚本文件位置（scripts/repo-root.mjs 单源），
 * vitest 子进程亦以仓根为 cwd 起（种子解析与配置发现不随调用处漂移）。
 * 注：scripts/dev-api.ts 的 `process.cwd()` 是「目标工作区缺省」语义（用户在哪本书上跑），
 * 不是仓根推导，不在此面。
 */
describe('评审余面批 E3：scripts 侧仓根单源', () => {
  it('REPO_ROOT = 测试侧独立推导的仓根（与调用处无关）', () => {
    expect(REPO_ROOT).toBe(resolve(repoRoot))
  })

  it('已接单源的六档不再以 cwd 作仓根（回退即红）', () => {
    const wired = [
      'test-related.mjs',
      'check-counts.mjs',
      'check-comments.mjs',
      'check-docs.mjs',
      'check-harness-copy.mjs',
      'check-packaging.mjs',
    ]
    for (const f of wired) {
      const code = readFileSync(join(repoRoot, 'scripts', f), 'utf-8')
      expect(code.includes("from './repo-root.mjs'"), `${f} 未接仓根单源`).toBe(true)
      expect(code.includes('process.cwd()'), `${f} 仍以 cwd 作仓根`).toBe(false)
    }
  })
})
