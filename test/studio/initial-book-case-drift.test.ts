/**
 * R1W-7（win 平台专项复审 R1）：--book 直达路径匹配的大小写漂移回归。
 *
 * win 夹具：登记 path 与传入 ref 大小写漂移（盘符/目录手工输入常态）→ 路径命中
 * 登记书（修复前全等比较落 null，--book 被静默丢弃）。posix 上该漂移在语义上
 * 是不同目录，it.skipIf 限定 win（J3 范式）；精确命中/未命中两臂跨平台跑。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveInitialBook } from '../../src/desktop/initial-book.js'

const workDir = mkdtempSync(join(tmpdir(), 'clw-r1w7-initbook-'))
mkdirSync(join(workDir, '.clwriting'), { recursive: true })
mkdirSync(join(workDir, 'Libs', 'MyBook'), { recursive: true })
writeFileSync(
  join(workDir, '.clwriting', 'books.jsonl'),
  JSON.stringify({ name: 'MyBook', path: 'Libs/MyBook', kind: 'long' }) + '\n',
)

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('resolveInitialBook 路径大小写漂移（R1W-7）', () => {
  it.skipIf(process.platform !== 'win32')(
    'win：目录大小写漂移 → 路径命中登记书',
    () => {
      expect(resolveInitialBook(workDir, join(workDir, 'libs', 'mybook'))).toBe('MyBook')
      expect(resolveInitialBook(workDir, 'Libs/MYBOOK')).toBe('MyBook')
    },
  )

  it('精确大小写 → 路径命中（跨平台）', () => {
    expect(resolveInitialBook(workDir, join(workDir, 'Libs', 'MyBook'))).toBe('MyBook')
    expect(resolveInitialBook(workDir, 'Libs/MyBook')).toBe('MyBook')
  })

  it('未登记路径 → null（跨平台，防误放行）', () => {
    expect(resolveInitialBook(workDir, 'Libs/Other')).toBeNull()
    expect(resolveInitialBook(workDir, join(workDir, '不存在'))).toBeNull()
  })
})
