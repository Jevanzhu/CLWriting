/**
 * 阶段 55：发布资产解析（纯函数面）——releases JSON → 便携 zip / 校验清单的选取。
 *
 * 检查（`check.ts`）与主进程下载链共用本面：展示的版本与实际下载的资产必须出自同一
 * 次判定（各自解析会漂移成「提示 v1.2.0、下载的却是别的 tag 的包」）。零 IO、零网络，
 * 输入一律 `unknown` 做防御式解析——GitHub 响应可被中间人/DNS 劫持篡改，字段缺失或
 * 类型漂移只该让本面返回 null（降级为「只有发布页链接」），不该抛。
 *
 * 资产名口径与 electron-builder 打出的 `artifactName` 单源对齐：release tag `v1.0.0`
 * 对应资产 `CLWriting-1.0.0-x64.zip`（版本号不带前导 v）；`SHA256SUMS.txt` 是同批发布的
 * 校验清单资产（`desktop.yml` 发布步骤生成，含每个产物的 sha256 行）。
 */

/** 便携包目标架构（与 electron-builder.yml 的 win portable 目标 arch 一致） */
export const PORTABLE_ZIP_ARCH = 'x64'

/** 校验清单资产名（发布步骤产物，sha256sum 文本格式） */
export const CHECKSUMS_ASSET_NAME = 'SHA256SUMS.txt'

export interface UpdateAsset {
  /** 资产文件名（GitHub 侧，下载时用作本地文件名） */
  name: string
  /** 浏览器下载地址（browser_download_url） */
  url: string
  /** 字节数（GitHub 报的 size；非法/缺失 → null） */
  size: number | null
  /** 资产自校验值（GitHub API `digest` 字段的 `sha256:<hex>` 形态，去前缀小写；缺失 → null） */
  sha256: string | null
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/** 便携 zip 资产名（版本号不带前导 v） */
export function portableZipName(version: string): string {
  return `CLWriting-${version.replace(/^v/, '')}-${PORTABLE_ZIP_ARCH}.zip`
}

/** 资产数组的防御式取项（非数组/非对象项一律丢弃） */
function assetEntries(assets: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(assets)) return []
  return assets.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
}

/** 单条资产 JSON → UpdateAsset（name/url 缺失即作废；digest 只认 sha256 形态） */
export function toUpdateAsset(raw: unknown): UpdateAsset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>
  const name = entry['name']
  const url = entry['browser_download_url']
  if (typeof name !== 'string' || name === '' || typeof url !== 'string' || url === '') return null
  const size = entry['size']
  const digest = entry['digest']
  let sha256: string | null = null
  if (typeof digest === 'string' && digest.startsWith('sha256:')) {
    const hex = digest.slice('sha256:'.length).toLowerCase()
    if (SHA256_HEX_RE.test(hex)) sha256 = hex
  }
  return {
    name,
    url,
    size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null,
    sha256,
  }
}

/** 按版本挑便携 zip 资产（名字精确匹配；挑不到 → null = 「只有发布页链接」降级态） */
export function pickPortableAsset(assets: unknown, version: string): UpdateAsset | null {
  const want = portableZipName(version)
  for (const entry of assetEntries(assets)) {
    const asset = toUpdateAsset(entry)
    if (asset && asset.name === want) return asset
  }
  return null
}

/**
 * 该发布是否提供校验清单资产（**只判有无**；地址不从这里取——响应可被篡改，地址一律由
 * `releaseChecksumsUrl(tag)` 派生，与下载链同源）。
 */
export function hasChecksumsAsset(assets: unknown): boolean {
  return assetEntries(assets).some((entry) => entry['name'] === CHECKSUMS_ASSET_NAME)
}

/**
 * 解析 sha256sum 文本取指定文件名行的 hex（小写；无该行/格式不符 → null）。
 * 格式：`<64hex>␣␣<文件名>`；`*` 二进制标记（sha256sum -b）容忍，文件名可含空格——
 * 故按「首个空白段之后整段」取，再逐字比对（不用 split 全切，避免文件名含空格时截断）。
 */
export function parseChecksums(text: string, fileName: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)[ \t]*$/.exec(rawLine)
    const hex = m?.[1]
    const name = m?.[2]
    if (hex !== undefined && name === fileName) return hex.toLowerCase()
  }
  return null
}
