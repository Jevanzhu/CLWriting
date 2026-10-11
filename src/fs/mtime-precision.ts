/**
 * 文件系统 mtime 精度判定单源（指纹缓存降级策略）。
 *
 * 背景：多处指纹缓存以 (mtimeNs,size) 判「文件未变」（document/manifest.ts 文档清单、
 * install/books-store.ts books.jsonl）。FAT/exFAT/部分 SMB 等低精度时间戳卷上，同尺寸
 * 改写落在粗粒度窗口内 mtime 不变 → 缓存陈旧命中——清单类 RMW 场景会以旧表整文件
 * 回写、把外部修改静默回滚。
 *
 * 判据：低精度卷的 mtime 恒对齐到粒度边界（FAT 2s、exFAT 10ms、SMB/HFS+ 1s），即
 * mtimeNs 是整毫秒倍数；真 ns 精度卷（APFS/NTFS 100ns/ext4）落在毫秒边界上的概率
 * ~1e-6（NTFS 100ns 档 ~1e-4），误判方向安全——仅该次读放弃缓存（重读重解析），
 * 正确性不受影响。消费方：低精度命中即降级不缓存（get/set 两侧都绕）。
 *
 * 零内部依赖（只算一个 bigint 取模），任意层可引。
 */
const MS_NS = 1_000_000n

/** mtimeNs 是否疑似低精度（整毫秒对齐）。true = 该卷时间戳粒度粗于毫秒，
 *  同尺寸写的陈旧窗仍在 → 指纹缓存降级不缓存；false = ns 级精度，指纹判据可信。 */
export function isCoarseMtimeNs(mtimeNs: bigint): boolean {
  return mtimeNs % MS_NS === 0n
}
