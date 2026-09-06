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
 *   1  ai-degrade     2  ai-provider     3  auto-write     4  usage-card（R76-10
 *   独立 server：主 server 无 userDataPath，trace 统计恒空——表格臂需自有事件库）
 *  13  overview-short 14  short-full-flow 15  batch-finalize 16  release-smoke
 *
 * 注意：独立 server spec 各自持有独立 workDir、分端口是为互不抢占（release-smoke
 * 头注 R63-15：勿与 auto-write 合并端口）；平移基址不改偏移间隔即可维持该契约。
 */
const DEFAULT_PORT_BASE = 18999

/** 独立 server spec 相对基址的最大端口偏移（与偏移表同源：release-smoke=16，越界即坏基址） */
export const MAX_PORT_OFFSET = 16

/** 非法/越界 env 回落缺省（防御性：基址坏值不应把整套 e2e 打挂） */
const parsed = Number(process.env['CLW_E2E_PORT_BASE'])
export const E2E_PORT_BASE =
  // R33D-35（三十三轮）：上界留偏移余量——独立 server spec 的派生端口最大 +16，
  // 放行 65520+ 会让 e2ePort(16) 越 65535 起服必挂（违背「坏值回落缺省」自述意图）
  Number.isInteger(parsed) && parsed > 0 && parsed < 65536 - MAX_PORT_OFFSET ? parsed : DEFAULT_PORT_BASE

/** 基址 + 偏移派生端口（独立 server spec 用；偏移表见头注）。
 *  R51-J-5（五十一轮）：偏移上界改运行时断言——MAX_PORT_OFFSET 原先只在
 *  E2E_PORT_BASE 的 env 校验里被引用（注释性守卫），调用方传超表偏移（新增独立
 *  server 忘登偏移表/抄错号）会静默派生出与偏移表无关的端口：独立 server 相互
 *  抢占、e2e 假红难排查。超界 fail-fast 抛人话错误，指路本文件偏移表。 */
export function e2ePort(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PORT_OFFSET) {
    throw new Error(
      `e2ePort 偏移越界：${offset}（合法范围 0..${MAX_PORT_OFFSET}）。` +
        `新独立 server 请在 test/e2e/e2e-ports.ts 头注偏移表登记并同步上调 MAX_PORT_OFFSET（同时核对 E2E_PORT_BASE 上界 65535 不越）`,
    )
  }
  return E2E_PORT_BASE + offset
}
