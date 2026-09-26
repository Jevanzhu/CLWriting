/**
 * 阶段 53：版本号解析与比较（自研，零新依赖）。
 *
 * 为什么自研（设计 §3.2）：更新检查只比「X.Y.Z」三方组 + 预发布串的序，语义面窄且
 * 必须可直测；引 semver 包会为一个十行级判定新增运行时依赖（本仓生产依赖仅 3 个、
 * tsup 全 bundle + asar 排除 node_modules 的打包形态会被波及）。
 *
 * 判定口径（设计）：**只认严格三方组**——去前导 v、可选预发布串（`-rc.0`）、可选
 * 构建元数据（`+build`，忽略）；缺段/非数字/多余尾巴（`v1.0` / `nightly` / `1.2.3.4`）
 * 一律 null。宁漏不误：不可解析的 tag 当不存在，绝不当成版本参与比较（垃圾 tag 若被
 * 宽松解析成 0.0.0 会造出假「有新版」提示）。
 *
 * 预发布序按 semver 规范：`1.0.0-rc.0 < 1.0.0`（无预发布串者更大——rc 用户会收到
 * 首个正式版提示，设计 §3.2 的正向行为），两个预发布串逐段比（数字段 < 字母段，同段
 * 数字比数值、字母比字典序）；段数短者小。生产调用图里被比较的候选恒为正式版（筛选
 * 在 pickLatestStable 内完成），预发布互比只为函数自洽。
 */

export interface ParsedSemver {
  major: number
  minor: number
  patch: number
  /** 预发布串（不含 `-`）；null = 正式版 */
  prerelease: string | null
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本串；不可解析（含非字符串输入）返回 null，不抛。 */
export function parseSemver(v: string): ParsedSemver | null {
  if (typeof v !== 'string') return null
  const m = SEMVER_RE.exec(v.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  }
}

/** 预发布串比较（协议见文件头）；a===b 时 0。 */
function comparePrerelease(a: string | null, b: string | null): -1 | 0 | 1 {
  if (a === b) return 0
  if (a === null) return 1 // 正式版 > 预发布版
  if (b === null) return -1
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1 // 段数短者小
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    if (nx !== ny) return nx ? -1 : 1 // 数字段 < 字母段
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 比较两版本串（含预发布序，见文件头）。
 * 任一侧不可解析 → 0（保守相等：当前版本读不出时不提示更新，垃圾候选不比大）。
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (const [x, y] of [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

/**
 * 从 tag 列表里取最大**正式版** tag（原串返回；设计：只提示正式版）。
 * 含 `-` 的（rc/nightly 形态）与不可解析的一并忽略；空表/全垃圾 → null。
 */
export function pickLatestStable(tags: readonly string[]): string | null {
  let best: string | null = null
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.includes('-')) continue
    if (!parseSemver(tag)) continue
    if (best === null || compareSemver(tag, best) > 0) best = tag
  }
  return best
}
