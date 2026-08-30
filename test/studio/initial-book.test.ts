/**
 * RB-SV-P2-4 回归：--book 直进参数解析（src/desktop/initial-book.ts）。
 *
 * argv 优先、env 回落；书名直命中 / 相对、绝对路径命中登记 path；未命中返回 null。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { initialBookArg, initialBookArgvOnly, resolveInitialBook } from '../../src/desktop/initial-book.js'

let workDir = ''
const prevEnv = process.env['CLWRITING_INITIAL_BOOK']

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-initbook-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  // 嵌套 path 登记（entry.path 可含子目录）与平级登记各一
  mkdirSync(join(workDir, '平级书'), { recursive: true })
  mkdirSync(join(workDir, '书库', '嵌套书'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [
      JSON.stringify({ name: '平级书', path: '平级书', kind: 'long' }),
      JSON.stringify({ name: '嵌套书', path: '书库/嵌套书', kind: 'long' }),
    ].join('\n') + '\n',
  )
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevEnv === undefined) delete process.env['CLWRITING_INITIAL_BOOK']
  else process.env['CLWRITING_INITIAL_BOOK'] = prevEnv
})

describe('initialBookArg', () => {
  it('argv --book 值优先', () => {
    process.env['CLWRITING_INITIAL_BOOK'] = 'env书'
    expect(initialBookArg(['electron', '.', '--book', 'argv书'])).toBe('argv书')
  })

  it('无 argv 时回落 env', () => {
    process.env['CLWRITING_INITIAL_BOOK'] = 'env书'
    expect(initialBookArg(['electron', '.'])).toBe('env书')
  })

  it('都没有 → undefined；空值（缺参/纯空白）不生效', () => {
    delete process.env['CLWRITING_INITIAL_BOOK']
    expect(initialBookArg(['electron', '.'])).toBeUndefined()
    expect(initialBookArg(['electron', '.', '--book'])).toBeUndefined()
    process.env['CLWRITING_INITIAL_BOOK'] = '   '
    expect(initialBookArg(['electron', '.'])).toBeUndefined()
    delete process.env['CLWRITING_INITIAL_BOOK']
  })
})

describe('resolveInitialBook', () => {
  it('书名直命中', () => {
    expect(resolveInitialBook(workDir, '平级书')).toBe('平级书')
  })

  it('相对路径（平级与嵌套登记）命中登记 path', () => {
    expect(resolveInitialBook(workDir, '平级书/')).toBe('平级书')
    expect(resolveInitialBook(workDir, join('书库', '嵌套书'))).toBe('嵌套书')
  })

  it('绝对路径命中', () => {
    expect(resolveInitialBook(workDir, join(workDir, '平级书'))).toBe('平级书')
  })

  it('未登记的名/路径 → null（前端回落默认页）', () => {
    expect(resolveInitialBook(workDir, '不存在的书')).toBeNull()
    expect(resolveInitialBook(workDir, join(workDir, '不存在目录'))).toBeNull()
  })
})

describe('initialBookArgvOnly（R27-97：second-instance 只认 argv）', () => {
  it('argv 带 --book → 取值；无 --book → 不回落 env（普通二次拉起不误导航）', () => {
    process.env['CLWRITING_INITIAL_BOOK'] = '首实例env书'
    expect(initialBookArgvOnly(['electron', '.', '--book', '新参书'])).toBe('新参书')
    // 修复前：此场景回落到首实例 env「首实例env书」，无参双开被误导航
    expect(initialBookArgvOnly(['electron', '.'])).toBeUndefined()
    expect(initialBookArgvOnly(['electron', '.', '--book'])).toBeUndefined()
  })
})
