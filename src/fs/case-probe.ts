/**
 * 文件系统大小写敏感性探测（平台 E）。
 *
 * 背景：win（NTFS）与 mac（默认 APFS 卷）均大小写不敏感，书库跨机互拷依赖这一
 * 前提；mac 手动开启大小写敏感的 APFS 卷 / Linux 常态敏感卷上使用书库，两台机器
 * 各自创建的仅大小写异名文件会劈裂成双存（win 上合并回一个）。samePath/relPathKey
 * 的折叠口径按 process.platform 静态判定、无法感知这类宿主卷，故在选择/切换书库时
 * 实测探测 + 警告（不能消除宿主属性，只能拒于门外）。
 *
 * 探测法：目标目录写一个小写探针文件，检查其大写形是否存在（不敏感卷 lookup 恒
 * 命中）。win 的按目录大小写敏感标记（fsutil file setcasesensitiveinfo）也被本探测
 * 正确覆盖——探测的就是目标目录本身。
 * 探针文件名改按 atomic 崩溃残留
 * 命名模式生成（见 probePair），残留可被 sweepAbandonedTmpFiles 回收。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// 探针文件名对齐崩溃残留清扫模式
// （atomic.ts ABANDONED_TMP_RE = `.<name>.<pid>.<uuid>.tmp`）——原固定名 `.clw-case-probe.tmp`
// 不匹配该模式（缺 pid/uuid 两段），进程恰在写探针与 finally 清理之间崩溃（硬杀/断电）
// 时残留文件永不被 sweepAbandonedTmpFiles 扫掉，随每次「选书库»探测累积。现按同款命名
// 生成：pid 段令的活进程守卫对该探针恒判「写者在途」（探测是毫秒级、清理在
// finally，残留只在崩溃时出现——崩溃后 pid 已死，年龄门 5 分钟后即可清扫）。
// 大写形 = 小写形整串大写（不敏感卷 lookup 命中同一文件，敏感卷首字符被改名区分）。
function probePair(): { lower: string; upper: string } {
  const lower = `.clw-case-probe.${process.pid}.${randomUUID()}.tmp`
  return { lower, upper: lower.toUpperCase() }
}

/** 探测依赖（测试注入用；生产走 node:fs）。 */
export interface CaseProbeDeps {
  writeFile(path: string, data: string): void
  exists(path: string): boolean
  remove(path: string): void
}

const NODE_DEPS: CaseProbeDeps = {
  writeFile: (p, d) => writeFileSync(p, d),
  exists: (p) => existsSync(p),
  remove: (p) => rmSync(p, { force: true }),
}

/**
 * 探测目录所在卷是否区分文件名大小写。
 * @returns true = 敏感（建议警告）；false = 不敏感；null = 探测失败（目录不可写等，
 *          按「不警告」fail-open 处理——探测本身不应挡住书库选择主流程）
 */
export function probeCaseSensitive(dir: string, deps: CaseProbeDeps = NODE_DEPS): boolean | null {
  const { lower: lowerName, upper: upperName } = probePair()
  const lower = join(dir, lowerName)
  const upper = join(dir, upperName)
  try {
    deps.writeFile(lower, 'probe')
    // 大写形可见 = 大小写不敏感（同一文件的两个名）；不可见 = 敏感
    return !deps.exists(upper)
  } catch {
    return null
  } finally {
    try {
      deps.remove(lower)
    } catch {
      /* best-effort 清理 */
    }
    try {
      deps.remove(upper)
    } catch {
      /* 敏感卷上大写形不存在，remove 兜底 */
    }
  }
}
