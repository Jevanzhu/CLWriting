/**
 * 确定性死 pid：起一个立即退出的子进程取其 pid——清扫器（sweepAbandonedTmpFiles
 * 的 R65-37 活 pid 探测）对「文件名 pid 段仍存活」的 tmp 按他进程在途写拒清，夹具
 * 硬编码 pid（atomic-sweep 原先的 12345、r43 原先的 123）在 pid 恰被占用的机器上
 * 会让「清扫」断言随机红（2026-09-17 CI 复验批实证：GitHub macOS runner 有 pid 123
 * 常驻进程，r43 CI mac 双腿必红而本机恒绿）。spawnSync 返回即子进程已退出；pid 即时
 * 复用概率可忽略（atomic-sweep R65-37 先例口径）。
 */
import { spawnSync } from 'node:child_process'

export function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  const pid = r.pid ?? 0
  return pid > 0 ? pid : 999_999 // spawn 失败兜底：极高位 pid 几乎必死
}

/**
 * 确定性活 pid（「他进程持有句柄」侧夹具；此前 2 档逐字复制同一常量与同一段理由）。
 *
 * POSIX 下 pid 1（launchd/init）恒活；win 下 pid 4（System）恒在——pid 1 在 win 无
 * 主进程语义（多半不存在，活标记会被误判死 → 拦迁失效假红），kill(4,0) 即便 EPERM
 * 也被 J7 语义按存活保守放行。J0（win 适配）实测修正。
 */
export const LIVE_FOREIGN_PID: number = process.platform === 'win32' ? 4 : 1
