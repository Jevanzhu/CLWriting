/**
 * 四轮-F402（2026-09-18 全量源码独立重评四轮修复批）+ 抄本同步纪律：
 * 全局 fetch 包装的 GET token 豁免表抄本 ↔ 服务端正本的双向同步机器门。
 *
 * 背景：test/helpers/studio-token-setup.ts 的 GET_TOKEN_EXEMPT 抄自
 * src/studio/server/index.ts 的 GET_TOKEN_EXEMPT_PATHS（X-19 显式豁免清单，唯一事实
 * 源）。抄本不能换成 import 正本——helper 是 vitest setupFiles（挂全部测试 worker），
 * 直连 server/index 会把整个 studio server 模块图拉进每个 worker，不成比例；故抄本以
 * 字面量存在，注释约定「保持同步」但此前无守卫（对比：coverage EXCLUDE 抄本有
 * coverage-threshold-globs 反向守卫）。正本改路（如 R0912-P3-⑥ 式豁免模式搬家）时
 * 抄本静默漂移——豁免路径被注入 token 属无害空转，但「豁免路径上断言 403」类用例会
 * 被注入行为误导排障（R72-20 锚注原始动因），事后零线索。
 *
 * 本测试钉住同步：正本多表/抄本缺、抄本多表/正本缺、模式 source 或 flags 漂移全红；
 * 「名不符」（任一侧改名/删导出）在本文件 import 面直接红（收集失败），不设单独用例。
 */
import { describe, it, expect } from 'vitest'
import { GET_TOKEN_EXEMPT_PATHS } from '../../src/studio/server/index.js'
import { GET_TOKEN_EXEMPT } from '../helpers/studio-token-setup.js'

/** 正则 → `source::flags` 签名（集合比对与漂移点名共用；flags 漂移同红） */
const sig = (re: RegExp): string => `${re.source}::${re.flags}`

describe('studio fetch 包装 GET 豁免表抄本同步守卫（四轮-F402）', () => {
  it('抄本 GET_TOKEN_EXEMPT 与正本 GET_TOKEN_EXEMPT_PATHS 双向集合相等（多/少/漂移全红）', () => {
    // 非空地板：两侧同时清空会让「集合相等」退化为恒真（同步门静默失明）
    expect(GET_TOKEN_EXEMPT_PATHS.length, '正本豁免表为空——X-19 显式路径表被误删').toBeGreaterThan(0)
    expect(GET_TOKEN_EXEMPT.length, '抄本豁免表为空——studio-token-setup 抄本被误删').toBeGreaterThan(0)

    const canonical = new Set(GET_TOKEN_EXEMPT_PATHS.map(sig))
    const copy = new Set(GET_TOKEN_EXEMPT.map(sig))
    const drift: string[] = []
    for (const s of canonical) {
      if (!copy.has(s)) drift.push(`正本有而抄本缺——studio-token-setup.ts 抄本须随动补入：/${s}`)
    }
    for (const s of copy) {
      if (!canonical.has(s)) drift.push(`抄本有而正本无——抄本删项或 index.ts 正本补表：/${s}`)
    }
    expect(drift, '\n' + drift.join('\n')).toEqual([])
  })
})
