/**
 * B-18（第六十轮补修）回归：bookHash 路径形态归一化。
 *
 * 原先 sha256 原样入参——尾分隔符 / '.'/'..' 段变体会让同一本书分裂成两个事件
 * 库（六十轮登记维持项，本次补修：哈希前 resolve 归一化）。同时锁死「存量无
 * 孤儿化」红线：对既有调用形态（books.json 单源的绝对无尾斜杠路径），归一化
 * 必须恒等 → 存量库键不变（不得重键）。
 */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { bookHash } from '../../src/events/store.js'

const base = resolve(join(tmpdir(), 'clwriting-bookhash'))
const plain = join(base, '我的书')

describe('B-18: bookHash 路径形态归一化', () => {
  it('尾分隔符 / "."、".." 段变体 → 同一 hash（不再分裂两库）', () => {
    const h = bookHash(plain)
    expect(bookHash(plain + '/')).toBe(h)
    expect(bookHash(plain + '/./')).toBe(h)
    expect(bookHash(join(base, '别的书', '..', '我的书'))).toBe(h)
  })

  it('存量无孤儿化红线：对已归一的绝对路径，hash 与对原始串直接 sha256 完全一致', () => {
    // 既有调用形态（books.json 单源、join 产出的绝对无尾斜杠路径）在修复前后
    // 必须产出同一键——归一化只吸收形态变体，绝不重键存量库
    const raw = resolve(plain) // 修复前调用点实况：已是归一形态
    const legacy = createHash('sha256').update(raw).digest('hex').slice(0, 16)
    expect(bookHash(raw)).toBe(legacy)
  })

  it('不同书仍分库（归一化不引入碰撞）', () => {
    expect(bookHash(join(base, '我的书'))).not.toBe(bookHash(join(base, '我的书2')))
  })
})
