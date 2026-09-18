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
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveCorpusDir } from '../../scripts/corpus-paths.js'

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
