/**
 * prepared 语句缓存的跨域关库契约（结构不变量）。
 *
 * 根因：node:sqlite 的 StatementSync 强引用其 DatabaseSync，与 shared/sqlite-prepared.ts 的
 * WeakMap 弱键构成 ephemeron 环——裸 db.close() 断不开环，每次开/关都滞留一份已编译语句
 * （实测 ~0.65KB/轮线性堆积）。唯一复发路径就是「有 prepared 调用面的连接裸关」。
 *
 * 为何住 governance 而不进各域：events / rag / check 三域各有自己的 closeXxxDb 包装，域内
 * 断言即可覆盖；本档守的是**无域包装、直调单源**的读取面——凡是自己开缓存库再走
 * assembleStatus / prepared 的文件，都必须经 closeWithPrepared 关。这类文件随重构漂移
 * （新增判态/工具/备料入口即新增一处），故扫描面按「开库 + 用缓存语句」自动派生而非
 * 枚举名单：新增同类关库点自动入网，落成裸 close 即红。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const srcRoot = join(import.meta.dirname, '../../src')

/** src 下全部 .ts（递归）——按相对路径记，便于报错定位。 */
function listTs(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listTs(join(dir, entry.name), rel))
    else if (entry.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

/** 逐行剥注释后的代码文本（注释里对关库时序的描述不算调用点）。 */
function stripComments(src: string): string {
  return src
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join(String.fromCharCode(10))
}

/** 裸关形态：`db.close()` 与可选链 `db?.close()`（后者断环同样不成立）。 */
const BARE_CLOSE_RE = /\bdb\??\.close\(\)/

/** 自己开库的文件：`new DatabaseSync(` 在位。接收外来 db 的函数不在此面内。 */
const OPENS_DB = 'new DatabaseSync('
/** 消费缓存语句的两条面：直调 prepared() 与经 assembleStatus 间接消费。 */
const USES_PREPARED = ['prepared(', 'assembleStatus(']

describe('prepared 缓存关库契约：有缓存语句面的库不得裸关', () => {
  const files = listTs(srcRoot)
    .map((rel) => ({ rel, src: readFileSync(join(srcRoot, rel), 'utf8') }))
    .filter((f) => f.rel !== 'shared/sqlite-prepared.ts') // 单源本体自身即 db.close 的定义处

  it('扫描面无缺失（防根路径漂移导致空跑通过）', () => {
    expect(files.length).toBeGreaterThan(200)
    expect(
      files.some((f) => f.rel === 'state/state.ts'),
      'state/state.ts 须在扫描面内',
    ).toBe(true)
  })

  it('开缓存库且消费 prepared 语句的文件，零裸 db.close()', () => {
    const offenders: string[] = []
    for (const { rel, src } of files) {
      const code = stripComments(src)
      if (!code.includes(OPENS_DB)) continue
      if (!USES_PREPARED.some((mark) => code.includes(mark))) continue
      if (BARE_CLOSE_RE.test(code)) offenders.push(rel)
    }
    expect(
      offenders,
      `以下文件自己开库、消费 prepared 语句，却裸 db.close()（环断不开，每次开/关滞留语句）：${offenders.join(', ')}`,
    ).toEqual([])
  })
})
