/**
 * R73-75（批 F-8）：e2e 端口族统一派生。
 *
 * 此前 18999/19000/19001/19002/19012/19013/19014/19015 八个端口散落硬编码在
 * playwright.config.ts / global-setup / 各独立 server spec——端口被环境争用时只能
 * 逐文件手改。现以 CLW_E2E_PORT_BASE（缺省 18999，与历史值一致）为基址、按偏移
 * 派生全部端口：设置该环境变量即整套平移；缺省行为与旧硬编码逐字节一致。
 *
 * 偏移表（= 旧端口 − 18999，刻意保持既有端口对齐不换号）：
 *   0  global-setup 主 server（playwright.config 的 baseURL 同源同值）
 *   1  ai-degrade     2  ai-provider     3  auto-write
 *  13  overview-short 14  short-full-flow 15  batch-finalize 16  release-smoke
 *
 * 注意：独立 server spec 各自持有独立 workDir、分端口是为互不抢占（release-smoke
 * 头注 R63-15：勿与 auto-write 合并端口）；平移基址不改偏移间隔即可维持该契约。
 */
const DEFAULT_PORT_BASE = 18999

/** 非法/越界 env 回落缺省（防御性：基址坏值不应把整套 e2e 打挂） */
const parsed = Number(process.env['CLW_E2E_PORT_BASE'])
export const E2E_PORT_BASE =
  Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT_BASE

/** 基址 + 偏移派生端口（独立 server spec 用；偏移表见头注） */
export function e2ePort(offset: number): number {
  return E2E_PORT_BASE + offset
}
