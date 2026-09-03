/**
 * 书库文本规范形原语（平台规范化批，2026-09-03 拍板）。
 *
 * 规范形定义：UTF-8、无 BOM、LF 行尾（\r\n 与孤立 \r 一律归一 \n）。
 *
 * 动机：win/mac 书库互拷要求「同一书库在任一台机器上写一次，字节都一致」。
 * 此前 md/yaml 主数据走「保真」语义（R38-11 主导行尾 / MP2-4 补丁行尾 /
 * R39-10 BOM 补回），两侧机器各自保留本机形态——win 写 CRLF、mac 写 LF，
 * 同一书库在两台机器各编辑一次即字节分叉（迁移无 diff 基准、同步盘噪声）。
 * 本批推翻保真语义改规范形：各写点经 canonicalizeText 收口，新库生而规范。
 * （原配套的存量启动迁移 v4 已裁决拆除：RC 阶段无存量用户书库，裁决记档见
 * Dev/Main/02-执行/书库平台规范化-实施方案-2026-09-03.md §一 D。）
 *
 * 边界：读侧容忍（剥 BOM / CRLF 双认）不在此模块、各读点既有防线维持——外部
 * 编辑器仍可能造出 BOM/CRLF 文件，「容忍读 + 规范写」= 经应用保存自然收敛。
 * 字节档（版本快照原文/spill/byteRestore 反悔通道）不经本模块——档案保真。
 */
/** 文本规范形：剥前导 BOM + 行尾归一 LF。幂等（已是规范形的文本零变化）。 */
export function canonicalizeText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n')
}

/** 字节级规范形探测：前导 UTF-8 BOM 或任一 0x0D（\r）即非规范形。不做完整
 *  UTF-8 合法性校验（读侧解码另有严格闸）。 */
export function bufferNeedsCanonical(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return true
  return buf.includes(0x0d)
}

/** 文件名 NFC 归一（R31-17 备案的收敛落地）：mac APFS 存 NFD、win/NTFS 惯 NFC，
 *  同名不同形跨机即「找不到文件」。只归一**文件名**——正文内容里的兼容字符
 *  可能是作者有意使用，不归一。 */
export function toNfcName(name: string): string {
  return name.normalize('NFC')
}

/** 文件名是否已是 NFC 形。 */
export function isNfcName(name: string): boolean {
  return name === name.normalize('NFC')
}
