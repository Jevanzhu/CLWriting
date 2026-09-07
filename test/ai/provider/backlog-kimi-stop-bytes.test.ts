/**
 * R59 清偿批（R55-C-7）回归：kimi trimStop 补齐官方上限「各 ≤32 字节」（R35-15 登记）。
 *
 * 原实现只截「≤5 条」（slice(0, 5)），单条超 32 字节原样发出。修复后逐条按 UTF-8
 * 字节口径安全截断（先按 32 字节截断，再回退尾部续字节/被劈序列首字节，不劈多字节
 * 序列产生乱码半字）。目录探针样本（'一''二''三'，各 3 字节）输出不变，
 * catalog.gen.ts 快照不受影响。
 */
import { describe, expect, it } from 'vitest'
import { quirksFor } from '../../../src/ai/provider/model-quirks.js'

describe('R55-C-7: kimi stopSequences「各 ≤32 字节」截断', () => {
  it('超 32 字节条目按 UTF-8 安全切点截断（汉字 3 字节 → 最多 10 个全字）', () => {
    const q = quirksFor('kimi-k3')
    const out = q.trimStop(['一二三四五六七八九十一']) // 11 字 = 33 字节
    expect(out).toHaveLength(1)
    const w = out![0]!
    expect(Buffer.byteLength(w, 'utf8')).toBeLessThanOrEqual(32)
    // 修复前：11 字整条原样发出（33 字节超限）；修复后截到 10 个完整汉字（30 字节）
    expect(w).toBe('一二三四五六七八九十')
  })

  it('≤32 字节条目原样保留；条数上限 5 不变', () => {
    const q = quirksFor('kimi-k3')
    expect(q.trimStop(['重启', '天命'])).toEqual(['重启', '天命'])
    expect(q.trimStop(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('多字节序列不在中间劈开（emoji 4 字节场景）', () => {
    const q = quirksFor('kimi-k3')
    const emojis = '😀'.repeat(8) // 8 × 4 = 32 字节
    const out = q.trimStop([`${emojis}x`]) // 33 字节 → 尾部 ASCII 被截，emoji 序列完整
    expect(out![0]).toBe(emojis)
  })
})
