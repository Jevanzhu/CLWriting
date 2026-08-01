/**
 * ⚠️ 内置密钥材料——凭据存储设计 §4.3。
 *
 * ╔══════════════════════════════════════════════════════════╗
 * ║  改动此文件 = 摧毁所有存量用户凭据，且无任何恢复途径。       ║
 * ║  老用户升级后 vault.dek 解不开 → 全部 API Key 报废。       ║
 * ║  任何 diff 须显式确认。发布检查清单必检此文件。              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * 设计要点（凭据存储设计 §4.3）：
 * - 不硬编码裸密钥字符串（strings 命令可扒出）
 * - 从多个分散碎片在运行时组合派生
 * - 不得掺入版本号 / 构建时间戳 / 随机数等随构建变化的量
 * - 可注入：此模块导出函数返回 IKM，vault.ts 接收为参数，不直接引用
 */

/** 碎片 A——分散在常量池中的固定字节（单独无意义） */
const SHARD_A = Buffer.from(
  '7a9c3f1e8b4d2065adfe3c187b629044ca1e7d3058bf2a963710ec4d9f8a3b71',
  'hex',
)
/** 碎片 B——与 A 异或后才是完整 IKM */
const SHARD_B = Buffer.from(
  '2e5b8a07c1f9354a96d0637e2f4a17bca0e89c5fbe14096b8d3a725f6c05d486',
  'hex',
)
/** 命名空间隔离串——防止与其他应用的 IKM 碰撞 */
const NAMESPACE = 'clwriting::credential-vault::fixed-seed'

/**
 * 内置密钥材料——运行时从碎片异或 + 命名空间混合派生。
 *
 * 返回的 IKM 经 HKDF-SHA256（vault.ts）派生 KEK，再解 DEK。
 * 组合构造细节不记录在设计文档中（§4.3）。
 */
export function builtinKeyMaterial(): Buffer {
  if (SHARD_A.length !== SHARD_B.length) throw new Error('密钥碎片长度不一致')
  const mixed = Buffer.allocUnsafe(SHARD_A.length)
  for (let i = 0; i < SHARD_A.length; i++) {
    mixed[i] = SHARD_A[i]! ^ SHARD_B[i]!
  }
  // 追加命名空间散列增加熵——不依赖碎片单独的随机性
  return Buffer.concat([mixed, Buffer.from(NAMESPACE, 'utf8')])
}
