/**
 * 同物理文件判定单一真相源（dev+ino 物理身份）——大小写不敏感卷上「纯大小写改名」
 * 与「同一物理目录/文件」识别的共用口径（书目录改名 / 文档移动重命名 / 章纲同步 /
 * 库安装判重 / 崩溃恢复中间态判定消费）。
 *
 * （win 平台专项）ino 必须走 bigint 形态比较：NTFS 的 File ID 是 64 位，而缺省
 * `statSync()` 返回的 `Stats.ino` 是 Number（IEEE double，53 位尾数）——File ID 超过
 * 2^53 后经 Number 转换低位塌缩，两个不同文件可得到同一个值（实测 ~2^56 量级 ID 差
 * 2~3 个单位即同值，double 在该量级的 ULP 恰为 4）。拿塌缩值做 dev+ino 判等会假阳性：
 * 「目标位已被占」被误判为「与源是同一物理文件（纯大小写变体）」→ 原位 rename
 * （REPLACE 语义）把占位文件静默覆盖；「link 独占探测已拦下 EEXIST、复核判等又放行」
 * 的交替形态即此。bigint 形态的 dev/ino 为无损整数，判等无此精度面。
 *
 * 三种收口口径（调用方按语义取用）：
 *  - samePhysicalFileExact：stat 失败按原错误上抛（调用方按自有错误链收口的路径，
 *    如崩溃恢复的中间态判定）；
 *  - isSamePhysicalFile：stat 失败按「非同文件」保守收口（冲突检查路径——不赌，
 *    走既有冲突分支）；
 *  - fs/user-data-path 的 samePhysicalPath：stat 失败回落 samePath 字符串口径
 *    （路径判重面，磁盘不可探测时维持既有判重面）。
 */
import { statSync } from 'node:fs'

/** 精确判定（stat 失败上抛）——调用方各自决定失败口径时用本函数。 */
export function samePhysicalFileExact(a: string, b: string): boolean {
  const sa = statSync(a, { bigint: true })
  const sb = statSync(b, { bigint: true })
  return sa.dev === sb.dev && sa.ino === sb.ino
}

/** 保守判定（任一 stat 失败 → false「非同文件」）——冲突检查路径的收口口径。 */
export function isSamePhysicalFile(a: string, b: string): boolean {
  try {
    return samePhysicalFileExact(a, b)
  } catch {
    return false
  }
}
