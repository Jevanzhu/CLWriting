/**
 * providers.json 读写——应用级（userDataPath），跨书共享（方案 §四①）。
 *
 * 不进书库目录：供应商是「这台机器的作者用什么服务」，不是「这本书的属性」。
 * 书库可能进 git，凭据不能跟着走。
 *
 * S4 加密落地（凭据存储设计 §四–七）：
 * - API Key 经 vault 信封加密（HKDF→KEK→DEK→AES-GCM），不明文落盘
 * - 加解密只发生在 load/save 边界，内存中 ProviderConf 仍含明文 apiKey
 * - 上层 API（providers.ts）零改动
 * - load 时自动迁移明文→密文 + 半迁移状态收敛（§五）
 *
 * 写入健壮性（原子写/备份/损坏不静默）属于 S5；凭据文件权限统一 0600 且随创建即生效（ee-P2-1）。
 */
import { readFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs'
import { atomicWriteFile, rmQuietly } from '../../fs/atomic.js'
// RC 源码重审 A-7（Opus-5.5 轮）：备份恢复段与写侧共用同一把跨进程写锁——同步非阻塞
// 占锁原语（loadProviders 是同步函数，不能用异步孪生；见 tryRestoreFromBak 注②）
import { tryAcquireCrossProcessLock } from '../../fs/cross-process-lock.js'
// 复审-0914-优化修复批（C1）：写链队列 + 跨进程锁机械收编 serializedLockedWrite 单源
//（R30-3 快路同步尝试 + 锁等待异步孪生语义不变——生成收尾路径与设置页保存在
// CLI+桌面双进程争用窗口不再冻结事件循环，机制见该文件头注）。R0916-7-P3-3：该原语
// 迁 src/fs/lock-file.ts——设置域不再经记账模块（ai/calls.ts）借用 fs 锁原语。
import { serializedLockedWrite } from '../../fs/lock-file.js'
// W-重评P3（重评-win适配修复批）：写链键折叠单源 writeChainKey——case-only/NFD 路径在
// win/darwin 折叠同链（linux 原样），双进程争用时同链排队
import { platformCaseFold } from '../../fs/safe-path.js'
import { dirname, join } from 'node:path'
import type { ProviderConf, ModelConf, TierSlot, TierConfig, RagProviderConf } from './types.js'
import { builtinKeyMaterial } from './vault-key.js'
// 0918三拍板批（KEK v2）：OS 凭据通道 IKM（env CLW_OS_KEK 解析，主进程 safeStorage 产出）
import { osKeyMaterial } from './os-kek.js'
import { errMsg, log } from '../../log/index.js'
import {
  createVault,
  openVault,
  sealKey,
  openKey,
  migrateVaultToOsChannel,
  type Vault,
} from './vault.js'

const FILE = 'providers.json'

/**
 * 0918独立重评修复批（D002）：写前基线复验失败——盘上 revision 已 ≠ 本操作基于的
 * revision（他进程/他写方在本操作 load 之后、落盘之前已写入；跨进程锁争用时快路转
 * 异步排队，排队段执行时盘上已是别的写方的结果，按旧快照整态覆盖即丢更新）。
 *
 * 上抛给 API 层映射既有 409 REVISION_CONFLICT 信封（providers.ts/rag-providers.ts 的
 * saveProvidersOr500 消费；文案对齐 revision-guard.ts revisionError 的人话口径，不新增
 * 错误码）。diskRevision/baseRevision 留作程序化诊断面，不进用户可见文案。
 */
export class ProviderRevisionConflictError extends Error {
  constructor(
    /** 复验时读到的盘上 revision */
    readonly diskRevision: number,
    /** 本操作基于的 revision（store 落盘快照的 revision） */
    readonly baseRevision: number,
  ) {
    super('配置已在其他窗口被修改，请刷新')
    this.name = 'ProviderRevisionConflictError'
  }
}

/** 0918独立重评修复批（D002）：读盘上当前 revision。文件缺失 → 0（与 loadProviders
 *  「无该键视为 0」同口径）；读失败/解析失败 → null（调用方跳过复验——文件损坏时
 *  无有意义的基线可护，保持既有 bak 自愈/覆盖写通道，不因复验挡死自愈）。 */
function readDiskRevisionLocked(fp: string): number | null {
  if (!existsSync(fp)) return 0
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as { revision?: number }
    return raw.revision ?? 0
  } catch {
    return null
  }
}

/**
 * mtime 缓存——避免每次 AI 生成重复 readFileSync + AES-256-GCM 解密。
 * saveProviders 写后失效；外部改动经 mtime 检测自动失效。
 *
 * 四轮-A404（2026-09-18 全量源码独立重评四轮修复批）：单槽 `_cache` 改小 LRU——原单槽
 * （path 不匹配即弃用）在双书库（双 userDataPath）交错生成时反复互相击穿，每次
 * loadProviders 都重付全量 readFileSync + AES 解密。键 = join 后绝对路径，值含 mtime
 * 做命中校验（mtime 不同即 miss 的既有语义逐位保持；A105 登记的同毫秒粒度窗原样保留）。
 * 容量 8 对齐 registry.ts CACHE_CAPACITY 先例。写侧/恢复侧/文件缺失三个失效点由
 * `_cache = null` 全量清除改按键清除：单文件操作不涉他路径条目（他路径命中仍受 mtime
 * 校验兜底，内容语义零变化），全量清除正是多库交错场景的击穿源。
 */

/** LRU 上限（registry.ts CACHE_CAPACITY=8 同量级——同进程同时活跃的书库很少） */
const CACHE_CAPACITY = 8

const _cache = new Map<string, { store: ProviderStore; mtime: number }>()

/** 读时提升（Map 迭代序 = 插入序，get 后重插即 LRU；registry.ts cacheGet 同构） */
function cacheGet(fp: string): { store: ProviderStore; mtime: number } | undefined {
  const hit = _cache.get(fp)
  if (hit) {
    _cache.delete(fp)
    _cache.set(fp, hit)
  }
  return hit
}

function cachePut(fp: string, store: ProviderStore, mtime: number): void {
  _cache.delete(fp)
  _cache.set(fp, { store, mtime })
  while (_cache.size > CACHE_CAPACITY) {
    const oldest = _cache.keys().next().value as string
    _cache.delete(oldest)
  }
}

/** 按键失效（写后/备份恢复后/文件缺失——四轮-A404 起不再全表清除，见上注） */
function cacheDelete(fp: string): void {
  _cache.delete(fp)
}

/** 测试辅助（registry.ts clearProviderCache/providerCacheSize 先例；生产零调用）：
 *  清空 mtime LRU，防跨用例残留；占用量供 LRU 容量/逐出断言。 */
export function __clearProvidersCacheForTest(): void {
  _cache.clear()
}
export function __providersCacheSizeForTest(): number {
  return _cache.size
}

/** 深拷贝 store——structuredClone 将 Buffer 降级为 Uint8Array，dek 须恢复（P2-AI-1） */
function cloneStore(store: ProviderStore): ProviderStore {
  const cloned = structuredClone(store)
  if (cloned.dek) cloned.dek = Buffer.from(cloned.dek)
  return cloned
}

/**
 * 内存中的供应商存储——ProviderSettings 超集。
 *
 * load 时解密得到明文 apiKey + vault/dek（复用避免重解）；
 * save 时用 dek 加密、剥离明文、写回 vault。
 * vault/dek 为 null 表示无存量 vault（首次启动 / 全新配置）。
 */
export interface ProviderStore {
  providers: ProviderConf[] // 含明文 apiKey（仅内存）
  currentId: string | null
  currentModel: string | null // 全局模型选择（方案 A：model 独立于供应商）
  /**
   * 表驱动重构（§6.5）：modelCaps 探测退役后，此槽复用为「400 降级记忆」——
   * 记录该 provider+model 已确认不支持 structured 输出，下次直接跳过（避免重复 400）。
   * key = `${providerId}/${model}`，值只用 structured:false 布尔。
   */
  modelCaps: Record<string, { structured: false }>
  /** 任务档位（D 档：创作档/助手档；端点按任务类型取档） */
  tiers: TierConfig
  /** RAG（嵌入）服务商——应用级多服务商，书按 rag.provider 引用（key 同走 vault） */
  ragProviders: RagProviderConf[]
  /** 并发修订号（P4）：save 写前 +1，读侧无该键视为 0；写端点带 expectedRevision 校验 */
  revision: number
  vault: Vault | null
  dek: Buffer | null
}

/** 默认档位配置（首次启动 / 文件无 tiers 字段时） */
function defaultTiers(model: string | null): TierConfig {
  return {
    creative: { model: model ?? '', effort: 'xhigh' },
    assistant: null,
    chat: null,
  }
}

/** 空 store（首次启动 / 文件缺失时） */
export function emptySettings(): ProviderStore {
  return { providers: [], currentId: null, currentModel: null, modelCaps: {}, tiers: defaultTiers(null), ragProviders: [], revision: 0, vault: null, dek: null }
}


/** 磁盘文件结构——providers 不含 apiKey，密文统一在 vault.keys */
interface DiskFormat {
  providers: Array<Omit<ProviderConf, 'apiKey'> & { apiKey?: string }>
  currentId: string | null
  currentModel?: string | null
  /** 400 降级记忆槽（表驱动重构后复用原 modelCaps 槽，见 ProviderStore.modelCaps） */
  modelCaps?: Record<string, { structured: false }>
  tiers?: TierConfig
  /** RAG（嵌入）服务商（同 vault 加密；形状坏容错为 []，不触发整文件 bak 恢复） */
  ragProviders?: Array<Omit<RagProviderConf, 'apiKey'> & { apiKey?: string }>
  /** 并发修订号（P4）；存量文件无该键 → 0 */
  revision?: number
  vault?: Vault
}

/**
 * RC 源码重审 A-7（Opus-5.5 轮）：恢复段的 fs 依赖——**逐调用显式参数**（R0916-7-P3-6
 * 钩子收敛：原为模块级注入口 __setProvidersRestoreDepsForTest，模块级可变状态让同进程
 * 两个调用方互相污染，且测试钩子挂在生产模块导出面上）。缺省即生产口径；风格照
 * fs/atomic.ts rmQuietly(path, { rm }) / renameWithRetry(from, to, { rename, sleep }) 先例。
 */
export interface ProvidersRestoreFsDeps {
  /** 读 bak 字节（缺省 readFileSync）——注入抛错覆盖「bak 存在但不可读」分支。 */
  readBak?: (path: string) => Buffer
  /** 写回主文件（缺省 atomicWriteFile + fsync + 0600，即生产口径）——注入抛错覆盖
   *  「改名留证成功但写回失败」分支（该分支下主文件已不在原名，必须断言留证路径）。 */
  writeMain?: (path: string, bytes: Buffer) => void
}

/** RC 源码重审 A-7（Opus-5.5 轮）：锁内复核判据——主文件此刻是否已是「可解析且形状
 *  正常」的配置（providers 为数组，与 loadProviders 的形状校验同口径；ragProviders
 *  形状坏按容错为 [] 处理，不在此判据内）。 */
function isMainLoadable(fp: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as { providers?: unknown }
    return Array.isArray(raw.providers)
  } catch {
    return false
  }
}

/**
 * W-P2-9：主文件损坏时的备份恢复引导。
 * 从 providers.bak.json 读回字节经 atomicWriteFile 落主文件（0600+fsync，与写侧
 * ee-P2-1 同口径）。
 * R2W-4（win 平台专项复审 R2）：原 copyFileSync 覆盖写在 win 有两条失效边——目标只读
 * 属性（libuv 不清位）与目标被他进程瞬时打开（CopyFileW EPERM），都会把「主文件损坏 →
 * bak 自愈」打断成持续 500。改为先除旧主文件（rename 改名保留；改名失败才退回 rmQuietly
 * ——libuv 对只读属性自动清位删除）+ atomicWriteFile（tmp+rename+EPERM/EBUSY 退避）；
 * 删除/改名仍失败（真占用）时落下方 catch 的「备份恢复亦失败」既有收口，.bak 全程只读不动。
 *
 * RC 源码重审 A-7（Opus-5.5 轮）：处置顺序重排为「先读 bak → 取写锁 → 锁内复核 → 改名
 * 留证 → 写回」。修复前 rmQuietly(fp) 先删主文件再 readFileSync(bakFp)——bak 读/写失败
 * 时主文件已被无痕销毁，而两处调用点文案却称「损坏文件保留」（文案与处置相反，用户数据
 * 亦无痕丢失）；且全段不持锁，可与并发 saveProviders 的写段交错（旧 bak 快照覆盖新配置 /
 * 半态）。不变量：① 任何失败分支都不比进入前更差——bak 缺失/不可读、写锁被占 → 主文件
 * 原封不动（此时「保留原文件」才为真）；② 一旦进入「留证 + 写回」段，原损坏字节必在
 * <fp>.corrupt-<ts> 留证（改名失败才退回旧口径 rmQuietly 删除——batch-pause R29-n/C-7
 * 二段式先例；路径用 Date.now() 数值，toISOString 含 ':' 在 win 是非法文件名）；
 * ③ 复核 + 留证 + 写回全段与写侧 saveProvidersRaw 同一把锁文件（其 lockPath 单源）。
 *
 * @returns null=主文件已是可用配置（恢复成功，或锁内复核发现并发写方已修复/替换）；
 *  string=失败原因（进入过留证段时原因串内含留证路径，供调用点文案如实透出）。
 */
function tryRestoreFromBak(fp: string, bakFp: string, fsDeps: ProvidersRestoreFsDeps = {}): string | null {
  const readBak = fsDeps.readBak ?? ((p: string) => readFileSync(p))
  const writeMain =
    fsDeps.writeMain ??
    ((p: string, bytes: Buffer) => atomicWriteFile(p, bytes, { fsync: true, mode: 0o600 }))

  // ① 先读后删：bak 缺失/不可读 → 直接返回原因，绝不触碰主文件（修复前此步在
  // rmQuietly 之后——bak 读失败时主文件已被删，「损坏文件保留」的文案因此为假）
  if (!existsSync(bakFp)) return '备份文件不存在'
  let bakBytes: Buffer
  try {
    bakBytes = readBak(bakFp)
  } catch (e) {
    return `备份文件不可读：${errMsg(e)}`
  }

  // ② 与写侧同一把锁（lockPath 与 saveProvidersRaw 同源）：同步非阻塞占锁。拿不到 =
  // 他进程写段在途（文件 IO 级毫秒）→ 本轮放弃、主文件原状，交上层既有错误/空配置出口，
  // 下次 load 自然重试。不取有界等待（acquireCrossProcessLockWithTimeout）的理由：
  // Atomics.wait 同步微睡会冻结承载 SSE 的服务进程，而本恢复面是罕见降级路径，不值得
  // 按毫秒换冻结（document/journal.ts 非阻塞 best-effort 同款口径）。持锁段 = 复核 +
  // 留证 + 原子写回，全程同步、无 await 点。
  const lockPath = join(dirname(fp), `${FILE}.lock`)
  const release = tryAcquireCrossProcessLock(lockPath)
  if (!release) {
    log.warn(
      'providers',
      `providers.json 备份恢复跳过：写锁被占用（并发写入中）——主文件保持原状，下次 load 重试：${lockPath}`,
    )
    return '写锁被占用（并发写入中），本轮跳过'
  }
  const corruptFp = `${fp}.corrupt-${Date.now()}`
  let preserved = false
  try {
    // ③ 锁内复核：「解析失败 → 取锁」窗口内并发写方可能已修复/替换主文件——此刻已是
    // 可用配置即视为恢复完成（两处调用点成功后本就重读主文件，语义天然兼容）。不做复核
    // 会把更新的配置覆盖成旧 bak 快照（bak = 上一次 save 前的内容，天然落后一拍）。
    if (isMainLoadable(fp)) return null
    // ④ 留证改名（batch-pause 二段式）：原字节留在 .corrupt-<ts> 供排查/手动回填，不再
    // 无痕删除；改名失败（占用等）才退回旧口径删除——写回是 tmp+rename 原子写，失败也
    // 不留半截主文件，且 bak 始终只读不动、天然兜底
    try {
      renameSync(fp, corruptFp)
      preserved = true
    } catch {
      rmQuietly(fp)
    }
    // ⑤ 写回 bak 字节（fsync 落盘 + 0600，与写侧 ee-P2-1 同口径）
    writeMain(fp, bakBytes)
    cacheDelete(fp) // 恢复后强制重读（四轮-A404：按键失效，原 _cache = null）
    log.warn(
      'providers',
      `providers.json 损坏，已从备份恢复（${preserved ? `原损坏文件留证为 ${corruptFp}` : '原损坏文件留证改名失败、已按旧口径删除'}）：${fp}`,
    )
    return null
  } catch (e) {
    // ⑥ 失败原因如实带出留证路径——调用点文案据此陈述实际处置，不得再声称「保留原文件」
    return preserved ? `${errMsg(e)}（原损坏文件已留证为 ${corruptFp}）` : errMsg(e)
  } finally {
    release()
  }
}

/**
 * 复审-0914-优化修复批（C7）：providers / ragProviders 两列共用的「解密 + 半迁移收敛」
 * 循环单源（S4 §五）——vault 有条目 → openKey 解密（R31-28：providerId 绑 AAD；存量
 * 未绑密文经 legacy 通道打开并标记重封；残留明文字段标记清理）；vault 缺条目但明文有 →
 * 收明文补迁移。任一命中 needsRewrite 由返回值带出（两列在 loadProviders 汇总）。
 */
function decryptConfs<T extends { id: string; apiKey: string }>(
  raws: Array<Omit<T, 'apiKey'> & { apiKey?: string }>,
  vault: Vault | null,
  dek: Buffer | null,
): { confs: T[]; needsRewrite: boolean } {
  let needsRewrite = false
  const confs = raws.map((p) => {
    const conf = { ...p, apiKey: '' } as T
    if (vault && dek && vault.keys[conf.id]) {
      // vault 有 → 解密（vault 永远优先）；R31-28（三十一轮）：providerId 绑 AAD，
      // 存量未绑密文经 legacy 通道打开并标记重封
      const opened = openKey(dek, vault.keys[conf.id]!, conf.id)
      conf.apiKey = opened.apiKey
      if (opened.legacy) needsRewrite = true
      // 残留明文 apiKey 字段 → 标记清理
      if (p.apiKey) needsRewrite = true
    } else if (p.apiKey) {
      // vault 缺该条目但明文有 → 补迁移
      conf.apiKey = p.apiKey
      needsRewrite = true
    }
    return conf
  })
  return { confs, needsRewrite }
}

/**
 * 读 providers.json → 解密 → ProviderStore（含明文 apiKey）。
 *
 * 解密失败（版本过高 / 认证失败）抛错——S5 会兜住"损坏不静默"，
 * 当前版本向上传播，由调用方（server API）转成错误响应。
 *
 * R0916-7-P3-6：恢复段 fs 依赖走逐调用参数（opts.restoreFs）——生产调用方不传即生产
 * 口径，测试用其覆盖「bak 不可读 / 写回失败」分支（原模块级注入口已删）。
 */
export function loadProviders(userDataPath: string, opts: { restoreFs?: ProvidersRestoreFsDeps } = {}): ProviderStore {
  // 通用-2（复审-0913-mac适配）：路径拼接统一 join()（posix 下与手拼 '/' 逐字节等价）
  const fp = join(userDataPath, FILE)
  if (!existsSync(fp)) {
    cacheDelete(fp) // 四轮-A404：按键失效（原 _cache = null）
    return emptySettings()
  }

  // mtime 缓存命中——跳过 readFileSync + vault 解密（高频 AI 生成场景核心优化）
  // P2-SEC-4：返回副本而非同一引用——调用方（API 端点）会直接 mutate store 后 saveProviders，
  // 若缓存返回原引用，未 save 的中间态会泄漏给后续 loadProviders 调用方
  // 0918二轮修复批（A105 登记）：mtimeMs 为失效判据存在同毫秒粒度窗——外部工具在
  // 同一毫秒内改写 providers.json 时 mtime 不变、命中陈旧缓存（读侧一次调用影响；
  // 写侧已有 D002 锁内 revision 复验兜底，读侧单次陈旧下次重读自愈，不另修）。
  try {
    const mtime = statSync(fp).mtimeMs
    // 四轮-A404：键 = fp（path 等价性由键查找承载，原 `_cache.path === fp` 判定收编）；
    // mtime 不同即 miss 的语义逐位保持
    const hit = cacheGet(fp)
    if (hit && hit.mtime === mtime) return cloneStore(hit.store)
  } catch {
    cacheDelete(fp)
  }

  let raw: DiskFormat
  // 通用-2（复审-0913-mac适配）：同上收编 join()（与 saveProvidersLocked 侧 bak 写同款）
  const bakFp = join(dirname(fp), 'providers.bak.json')
  try {
    raw = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
  } catch (e) {
    // W-P2-9：损坏不静默，且不再直接放弃——主文件解析失败时尝试从 bak 恢复
    // （save 每次写前都会生成 providers.bak.json，理论上是最新一份完整配置）。
    // 恢复成功 → 用备份内容继续（并在下方用恢复后的内容重写主文件，重建一致状态）。
    const bakErr = tryRestoreFromBak(fp, bakFp, opts.restoreFs)
    if (bakErr) {
      // D6：备份也不可用 → 向上报错（router 全局 catch 转 500 响应）。
      // RC 源码重审 A-7（Opus-5.5 轮）：文案校正——修复前写「保留原文件」，但恢复段已
      // 先 rmQuietly(fp)，该声称只对「bak 缺失/不可读、写锁被占」两条前置失败分支为真
      // （现在它们才真的不触碰主文件）；进入「留证 + 写回」段后失败时原字节在
      // <fp>.corrupt-<ts>，路径由 bakErr 带出（不再声称留在原名可手动恢复）。
      throw new Error(`providers.json 解析失败，文件可能损坏（备份恢复亦失败）：${e instanceof Error ? e.message : ''}${bakErr ? '；bak: ' + bakErr : ''}`)
    }
    try {
      raw = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
    } catch (e2) {
      throw new Error(`providers.json 备份恢复后仍无法解析：${e2 instanceof Error ? e2.message : ''}`)
    }
  }
  // RB-AI-P2-6：JSON 合法但形状坏（providers 非数组）——不再静默 emptySettings
  //（用户视角 = Key 无故消失、无任何损坏提示），走与解析失败相同的 bak 恢复链；
  // bak 也不可用才重置为空，且 log.warn 显式告警（不静默）
  if (!Array.isArray(raw.providers)) {
    const bakErr = tryRestoreFromBak(fp, bakFp, opts.restoreFs)
    let restored: DiskFormat | null = null
    if (!bakErr) {
      try {
        const reread = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
        if (Array.isArray(reread.providers)) restored = reread
      } catch {
        /* bak 内容亦不可解析 */
      }
    }
    if (restored) {
      raw = restored
    } else {
      // RC 源码重审 A-7（Opus-5.5 轮）：文案按实际处置生成——修复前称「损坏文件保留，
      // 可从 providers.bak.json 手动恢复」，两句皆失真：进入恢复段后原文件已改名留证
      //（改名失败才退回删除），而本分支恰是「bak 内容亦不可用」（bakErr 为空 = bak 字节
      // 已写回主文件但仍不可解析，指向 bak 手抄的指引同样无效）。两态分述，恢复失败时
      // 主文件的实际处置由 bakErr 自身陈述（不再有与处置相反的声称）。
      log.warn(
        'providers',
        `providers.json 形状损坏（providers 非数组）${bakErr ? `，备份恢复失败：${bakErr}` : '，备份内容亦不可用（原损坏文件已改名留证为 providers.json.corrupt-<时间戳>，路径见上一条 providers 日志；主文件现为 bak 字节）'}——已重置为空配置`,
      )
      return emptySettings()
    }
  }

  const vault: Vault | null = raw.vault ?? null
  let dek: Buffer | null = null

  if (vault) {
    // 版本守卫 + HKDF 派生 KEK + 解封 DEK（可能抛 VaultVersionError / VaultDecryptError /
    // VaultOsKeyMissingError）——0918三拍板批（KEK v2）：os 通道可用时传入，v2 vault
    // 由此解锁；v1 vault 走内置通道（语义不变）。
    dek = openVault(vault, builtinKeyMaterial(), osKeyMaterial())
  }

  // 逐条提取明文 apiKey，按 §五半迁移规则收敛（复审-0914-优化修复批 C7：两列循环
  // 单源 decryptConfs，逐字段行为不变）
  const { confs: providers, needsRewrite: providersMigrated } = decryptConfs<ProviderConf>(raw.providers, vault, dek)

  // 无 vault 但有明文 apiKey → 全量首次迁移
  let needsRewrite = providersMigrated || (!vault && providers.some((p) => p.apiKey))

  // RAG（嵌入）服务商——同款解密/明文迁移规则（C7 同源）。形状坏容错为 []：
  // ragProviders 是后加段，不能因它拖累 chat providers 走整文件 bak 恢复链。
  const ragRaw = Array.isArray(raw.ragProviders) ? raw.ragProviders : []
  const { confs: ragProviders, needsRewrite: ragMigrated } = decryptConfs<RagProviderConf>(ragRaw, vault, dek)
  if (ragMigrated || (!vault && ragProviders.some((p) => p.apiKey))) {
    needsRewrite = true
  }

  // 0918三拍板批（KEK v2）：OS 通道迁移——os key 可用且盘上 vault 仍 v1（内置混淆级
  // 通道）→ 同一 DEK 重封 byOs、摘除 byApp（各 API Key 密文零重加密），needsRewrite
  // 触发内联迁移写（§五同款）。迁移落盘后旧构建按 VaultVersionError 拒读（§4.4 防降级
  // 毁配置，既有守卫语义）；os key 不可用（纯 node / env 未注入）→ 保持 v1 零行为变化。
  const osKey = osKeyMaterial()
  if (vault && dek && osKey && migrateVaultToOsChannel(vault, dek, osKey)) {
    needsRewrite = true
  }

  const store: ProviderStore = { providers, currentId: raw.currentId ?? null, currentModel: raw.currentModel ?? null, modelCaps: raw.modelCaps ?? {}, tiers: raw.tiers ?? defaultTiers(raw.currentModel ?? null), ragProviders, revision: raw.revision ?? 0, vault, dek }

  // 迁移写回——剥离明文、加密进 vault（§五）
  if (needsRewrite) {
    // R29-2（二十九轮）：saveProviders 现返回 promise——迁移写是 load 的内联副作用：
    // 快路同步异常照旧向上抛（本行表达式同步求值，语义不变）；排队段（存在在途写时）
    // 的拒绝在此收口（saveProviders 内部已 log.warn 留痕），不再成为未处理 rejection。
    // 0918二轮修复批（A103）：走 saveProvidersRaw（透传 serializedLockedWrite 快路
    // undefined 信号）——bak 覆写挂到「本次迁移写入落盘成功之后」：快路（写已同步完成）
    // 同步执行，排队路径挂 promise then 段。修复前迁移后同步 readFileSync 直读校验：
    // 排队窗口内直读拿到的是迁移前旧文件（明文无 vault）→ 校验必失败/跳过 → 明文 bak
    // 残留到下次任意 save。
    const r = saveProvidersRaw(userDataPath, store)
    if (r === undefined) {
      overwriteBakIfCiphertextRoundtrip(fp, bakFp, providers, ragProviders)
    } else {
      r.then(
        () => overwriteBakIfCiphertextRoundtrip(fp, bakFp, providers, ragProviders),
        () => { /* 排队段失败已留痕（serializedLockedWrite 旁挂 warn），迁移写不向 load 异步上抛；bak 保持现状 */ },
      )
    }
  }

  // 更新 mtime 缓存（四轮-A404：cachePut 入 LRU，原 `_cache = { path, store, mtime }`）
  try {
    cachePut(fp, store, statSync(fp).mtimeMs)
  } catch { /* 迁移写后 stat 失败忽略，下次 loadProviders 自然 miss */ }

  // P2-AI-3：缓存未命中也返回 clone（与缓存命中路径 structuredClone 一致）——
  // 否则调用方（API 端点）直接 mutate store 后 saveProviders 前，未保存的中间态会泄漏给后续 loadProviders
  return cloneStore(store)
}

/**
 * 写 providers.json——加密 apiKey 进 vault + 剥离明文 + mode 0600 创建即生效（ee-P2-1）。
 *
 * 每次 save 以 providers 列表为准重建 vault.keys（D4：删除的 provider 自动清除密文）。
 * 若 store 无 vault（首次 / 迁移），创建新 vault + 随机 DEK。
 *
 * R73-2（二十一轮 A-2）：全部写路径（loadProviders 迁移回写 / runner 降级持久化 /
 * 设置页保存）统一收口到本函数 → 按 userDataPath 的串行写队列 + 跨进程文件锁
 * （范式同 ai/calls.ts serializedWrite + J7 跨进程锁）。修复前读-改-写三段无串行化，
 * 与设置页保存并发时旧快照整态覆盖新写，用户配置丢失。
 *
 * 语义变化（R73-2 原口径，R29-2 二十九轮修订）：队列空闲时同步直行（同步调用方
 * 「存完即读」与「revision 写后 +1 立即可读」语义不变、IO 异常照旧同步上抛）；存在
 * 在途段时排队为微任务执行。R29-2：签名 void → Promise<void>——快路同步写完后
 * resolve（IO 异常仍同步抛，对 `try { await saveProviders(...) } catch` 两侧等价捕获）；
 * 排队段返回链式 promise，失败 log.warn 留痕后随 promise 上抛（修复前仅 warn 吞掉：
 * 设置页保存 API 已按成功返回而配置未落盘）。端点侧（批 D）约定按
 * `try { await saveProviders(...) } catch → 500` 消费。
 *
 * 残余窗口（登记，0918独立重评修复批 D002 收口）：读路径 loadProviders 不参与互斥——
 * 排队写未落地的窗口内并发 load 读到旧快照、改动后再 save 会按调用序排在后面；原口径
 * 「后写覆盖前写」丢更新由 saveProvidersLocked 的锁内写前 revision 复验收口（基线漂移
 * 即拒绝落盘、上抛 ProviderRevisionConflictError，API 层映射 409 REVISION_CONFLICT）。
 * 设置页写端点的 P4 expectedRevision 校验（陈旧快照 409 重读）管「请求发起时刻」，
 * 本复验管「落盘执行时刻」，两闸互补；降级持久化等无 revision 校验的路径同样被本
 * 复验兜住（漂移即拒 + 旁挂 warn 留痕，下次 persistDegraded 自然重试）。跨进程窗口
 * 由文件锁互斥（写段不交错），锁内不重读合并（与 calls.ts 同口径，读合并在锁外做
 * 收益为零）。残余洞（如实记）：盘上文件读失败/解析失败时复验跳过（保 bak 自愈
 * 通道）＋双方基线同为缺失文件（revision 0 的双建竞态）不设防——前者自愈语义优先，
 * 后者仅在「首次配置双端同刻创建」窄窗，可接受。
 *
 * RC 源码重审 A-7（Opus-5.5 轮）补记「读路径不参与互斥」的唯一例外：损坏恢复段——
 * tryRestoreFromBak 的「复核 + 留证 + 写回」已纳入本函数同一把锁文件（同步非阻塞占锁，
 * 拿不到即放弃本轮、主文件原状），恢复写不再与在途写交错。
 *
 * R33-17（三十三轮）现状校正（RC 源码重审 A-7（Opus-5.5 轮）按 tree 实况复校）：锁获取
 * 走 serializedLockedWrite 的快/慢双路——空闲且锁空闲时同步直行（控制流不归还）；
 * 锁被他进程持有时快路转**异步孪生**（acquireCrossProcessLockAsync，setTimeout 轮询，
 * R0916-7-P3-3 起该机理的实现居 fs/lock-file.ts crossProcessLockedWrite）并返回在途
 * promise。故下方排队分支
 *（prev 非 undefined）**可达**：在途段未落地期间的新写者按链排队，队列非空窗口 =
 * 他进程持锁窗口。R33-17 原文「全同步串行、排队不可达」只对无争用快路成立，已作废。
 */
const writeChains = new Map<string, Promise<unknown>>()

/** R0913-win P3-3（折叠键族，2026-09-13 全库源码重评 win 适配修复批）：写链键折叠
 *  ——键此前为原始 userDataPath，同一目录以两种 case 寻址（盘符/路径大小写漂移）会
 *  拆成两条进程内串行链，进程内互斥退化（跨进程文件锁仍兜底）。platformCaseFold
 *  单源（win/darwin 折叠，linux 原样）；仅作进程内 Map 键，磁盘路径派生不受影响。 */
function writeChainKey(userDataPath: string): string {
  return platformCaseFold(userDataPath)
}

/** R73-2 跨进程锁等待超时（毫秒）——写段为本地文件 IO 级毫秒，5s 已极保守（同 calls.ts） */
const PROVIDERS_WRITE_LOCK_TIMEOUT_MS = 5_000

/** 测试辅助：向写链注入一段在途 promise（R29-2 排队路径回归用——空闲快路永不入链，
 *  生产代码无从触达排队段；生产零调用）。 */
export function __seedProvidersWriteChainForTest(userDataPath: string, pending: Promise<unknown>): void {
  writeChains.set(writeChainKey(userDataPath), pending)
}

/**
 * R71-18：迁移后收敛 bak 明文残留——saveProviders 的 D7 写前备份会把迁移前的明文
 * 主文件原样拷进 providers.bak.json，用户此后不改配置则明文 Key 在 bak 永久残留
 * （直到下次 save 才被密文覆盖）。迁移写入落盘后重新读回校验（openVault 重开 +
 * openKey 逐条解密比对明文），通过才用刚落盘的密文内容覆写一次 bak
 * （atomicWriteFile 与 D7/ee-P2-1 同款 0600+fsync）；校验失败保持 bak 现状
 * （明文 bak 是恢复通道，下次 saveProviders 自然覆盖）。
 *
 * 0918二轮修复批（A103）：自 loadProviders 迁移分支内联段提取为单源 helper，且执行
 * 时机由「load 内同步直读」改为「本次迁移写入落盘成功之后」（快路同步 / 排队路径
 * promise then 段，见迁移分支注）——修复前排队窗口内同步直读拿到迁移前旧明文文件，
 * roundtrip 校验必失败/跳过，明文 bak 残留到下次任意 save。
 */
function overwriteBakIfCiphertextRoundtrip(
  fp: string,
  bakFp: string,
  providers: ProviderConf[],
  ragProviders: RagProviderConf[],
): void {
  try {
    const savedRaw = readFileSync(fp, 'utf8')
    const saved = JSON.parse(savedRaw) as DiskFormat
    const savedVault = saved.vault
    if (savedVault) {
      // 0918三拍板批（KEK v2）：v2 vault 须有 os key 才能重开（v1 通道已摘）
      const savedDek = openVault(savedVault, builtinKeyMaterial(), osKeyMaterial())
      const roundtripOk = [...providers, ...ragProviders].every((p) => {
        if (!p.apiKey) return true // 空 key 无密文可校
        const sealed = savedVault.keys[p.id]
        return !!sealed && openKey(savedDek, sealed, p.id).apiKey === p.apiKey
      })
      if (roundtripOk) {
        atomicWriteFile(bakFp, savedRaw, { fsync: true, mode: 0o600 })
      }
    }
  } catch {
    /* 读回/解密校验失败：bak 保持现状（恢复通道），不向调用方传播 */
  }
}

export function saveProviders(userDataPath: string, store: ProviderStore): Promise<void> {
  const r = saveProvidersRaw(userDataPath, store)
  return r === undefined ? Promise.resolve() : r
}

/** 0918二轮修复批（A103）：内部变体——透传 serializedLockedWrite 的快路 undefined
 *  信号（快路 = 写已同步落盘；Promise = 在途/排队段），供 loadProviders 迁移分支把
 *  bak 覆写挂到「本次写入落盘成功之后」（快路同步执行保持 R71-18 既有同步语义，
 *  排队路径挂 promise then 段）。对外 saveProviders 恒 Promise（R29-2 语义不变）。 */
function saveProvidersRaw(userDataPath: string, store: ProviderStore): void | Promise<void> {
  // 复审-0914-优化修复批（C1）：快/慢双路、在途入链、cleanup 身份比对、旁挂 warn 防
  // unhandled rejection 收编 serializedLockedWrite 单源（R0916-7-P3-3 起居 fs/lock-file.ts；
  // 记账侧 serializedWrite 同构薄壳）。R73-2 串行队列 + R30-3 锁异步化 + R29-2 排队段失败
  // 随 promise 上抛语义逐位不变：returnInflight=true（在途/排队 promise 原样返回给 await 方）；
  // 快路同步完成返回 undefined，saveProviders 转 Promise.resolve()（R29-2：IO 异常照旧同步
  // 上抛，await 侧 try/catch 同样接得住）。
  // W-重评P3 并合注：链键走 writeChainKey 折叠（case-only/NFD 路径同链排队，win 侧
  // 修复与 C1 收编单源的接合点；__seedProvidersWriteChainForTest 同键口径）。
  const lockPath = join(userDataPath, `${FILE}.lock`)
  return serializedLockedWrite(
    writeChains,
    writeChainKey(userDataPath),
    lockPath,
    () => saveProvidersLocked(userDataPath, store),
    {
      warnTag: 'providers',
      fastWarn: (m) => `providers.json 写入失败（本次写未落盘）：${m}`,
      queuedWarn: (m) => `排队 providers.json 写入失败（本轮写未落盘）：${m}`,
      lockTimeoutMs: () => PROVIDERS_WRITE_LOCK_TIMEOUT_MS,
      lockTimeoutMsg: `providers.json 跨进程锁获取超时（${lockPath}）——本次写入未落盘，避免与其他进程交错覆盖`,
      returnInflight: true,
    },
  )
}

/** 原 saveProviders 主体（R73-2 改名入锁；逻辑逐行不变） */
function saveProvidersLocked(userDataPath: string, store: ProviderStore): void {
  // 通用-2（复审-0913-mac适配）：路径拼接统一走 join()（与下方 bak 写同款），posix 下
  // 与手拼 '/' 逐字节等价，零行为变化
  const fp = join(userDataPath, FILE)

  // 0918独立重评修复批（D002）：锁内写前基线复验——读盘得当前 revision，与本操作基于
  // 的 revision（store 快照的 revision；全部生产调用方均为 loadProviders 派生，端点
  // mutate 不动 revision，save 成功才写后 +1）比对，不等即拒绝对本操作落盘并上抛
  // ProviderRevisionConflictError（API 层映射 409 REVISION_CONFLICT，前端刷新重读）。
  // 修复窗口：跨进程锁争用时快路转异步排队（serializedLockedWrite 保调用序 = 落盘序），
  // 后到请求在先者落盘前 loadProviders 读到旧 revision、双方 expectedRevision 各自过闸，
  // 队列序落盘后到者按旧快照整态覆盖先者（丢更新）——快路同刻 race 由 R73-2 串行链与
  // 跨进程锁兜住，本复验补的是「排队段执行时刻基线已漂移」的窗口。盘上读失败/解析失败
  // → null 跳过复验（损坏文件走既有 bak 自愈通道，见 readDiskRevisionLocked 注）。
  // 复验在 vault 重建/密文改写之前——拒绝路径不留下任何半改写状态，store.revision 不
  // 被 bump（调用方刷新重读后重放）。
  const diskRevision = readDiskRevisionLocked(fp)
  const baseRevision = store.revision ?? 0
  if (diskRevision !== null && diskRevision !== baseRevision) {
    log.warn(
      'providers',
      `providers.json 写入拒绝：盘上 revision=${diskRevision} ≠ 本操作基于的 ${baseRevision}（他写方已先行落盘），要求调用方刷新重读`,
    )
    throw new ProviderRevisionConflictError(diskRevision, baseRevision)
  }

  mkdirSync(dirname(fp), { recursive: true })

  // 确保 vault + DEK（首次创建或迁移时新建）
  // 0918三拍板批（KEK v2）：os key 可用 → 新建即 v2（仅 byOs，OS 凭据承载）；存量
  // v1 vault（旁路构造的 store 快照直存，load 迁移已覆盖常规链）就地迁移随本写落盘。
  let vault = store.vault
  let dek = store.dek
  if (!vault || !dek) {
    const created = createVault(builtinKeyMaterial(), osKeyMaterial())
    vault = created.vault
    dek = created.dek
    store.vault = vault
    store.dek = dek
  } else {
    const osKey = osKeyMaterial()
    if (osKey) migrateVaultToOsChannel(vault, dek, osKey)
  }

  // 以 providers + ragProviders 为准重建 vault.keys——加密每个 apiKey。
  // 两类 key 必须同批收齐：漏收任一类 = 存另一类时静默抹掉它的密文。
  vault.keys = {}
  const sealKeyOf = (id: string, apiKey: string): void => {
    // R31-28（三十一轮）：providerId 绑 AAD——密文换位到其他条目认证失败
    if (apiKey) vault!.keys[id] = sealKey(dek!, apiKey, id)
  }
  const diskProviders = store.providers.map((p) => {
    sealKeyOf(p.id, p.apiKey)
    // 剥离明文 apiKey（落盘不含）
    return { ...p, apiKey: undefined } as Omit<ProviderConf, 'apiKey'>
  })
  const ragProviders = store.ragProviders ?? []
  const diskRagProviders = ragProviders.map((p) => {
    sealKeyOf(p.id, p.apiKey)
    return { ...p, apiKey: undefined } as Omit<RagProviderConf, 'apiKey'>
  })

  const disk: DiskFormat = { providers: diskProviders, currentId: store.currentId, currentModel: store.currentModel, modelCaps: store.modelCaps, tiers: store.tiers, ragProviders: diskRagProviders, revision: (store.revision ?? 0) + 1, vault }
  // P4：写前 +1，内存 store 同步（调用方随后刷新时读到新号）
  store.revision = disk.revision!
  const json = JSON.stringify(disk, null, 2) + '\n'

  // D7：写前备份（文件已存在时）。ee-P2-1：bak 改走 atomicWriteFile + mode 0600 创建即生效——
  // 此前 copyFileSync 建文件后再补 chmodSync，chmod 前受 umask 影响（默认 0644 短暂全局可读，
  // 虽是密文仍是纪律缺口）；与主文件统一到「mode 随临时文件创建生效」纪律（CC-P2-3 / RB-IF-P2-6），
  // 且顺带获得原子性（不再可能留下半截 bak）。
  if (existsSync(fp)) {
    atomicWriteFile(join(dirname(fp), 'providers.bak.json'), readFileSync(fp, 'utf8'), { fsync: true, mode: 0o600 })
  }

  // D5+D8：原子写（atomicWriteFile: PID+UUID tmp 防冲突 + fsync 落盘）。
  // ee-P2-1：mode 0600 随临时文件创建即生效（rename 保留 mode），删除写后 chmodSync——
  // 后者存在 umask 窗口（默认 0644 短暂全局可读），与 CC-P2-3（src/ai/calls.ts 记账文件）同款修法。
  atomicWriteFile(fp, json, { fsync: true, mode: 0o600 })

  // 写后失效缓存（下次 loadProviders 自动重读 + 更新缓存；四轮-A404：按键失效，
  // 原 `_cache = null`——本次写只落本路径文件，不再全表清除击穿他库缓存）
  cacheDelete(fp)
}

/**
 * 400 降级记忆落盘回调（U-P2-2）——适配器深处只持有 store 的内存 clone
 * （P2-SEC-4：loadProviders 返回副本），mutate 不回缓存也无人保存。
 * runner 侧注册落盘函数（load→改→save 读盘最新，防覆盖并发改动），
 * 适配器经 persistDegraded 转发；未注册（如单测直接构造 store）时静默跳过。
 *
 * R30-4（三十轮）：通道补显式 path 维度——同进程双库并发生成时，适配器携
 * 来源 userDataPath（resolveProvider 经 createProvider 注入）调用，分发按显式
 * path 路由；未传（旧形态/单测直调）由 runner 分发器回落「最近 resolve 的活跃
 * path」（进程内口径 = 活跃库优先，兼容不变）。
 */
let _persistDegraded: ((key: string, userDataPath?: string) => void) | null = null
export function registerDegradedPersist(fn: (key: string, userDataPath?: string) => void): void {
  _persistDegraded = fn
}
export function persistDegraded(key: string, userDataPath?: string): void {
  if (!_persistDegraded) return
  try {
    _persistDegraded(key, userDataPath)
  } catch {
    // AA-P3-5：降级记忆是优化通道——写失败（load/save 抛错）不向调用方传播，不得中断
    // 已成功的建流；失败由 runner 侧「不标记」承载，下次 persistDegraded 自然重试。
  }
}

/**
 * 降级记忆新鲜读（批次 D2）——与 persistDegraded 对称的查通道。
 *
 * 缘由：适配器缓存（registry 按 settings hash 复用实例）后，适配器捕获的 store
 * 是创建时刻的快照，降级记忆会读到旧值。runner 注册本回调后，适配器经
 * lookupDegraded 读「此刻磁盘上的记忆」（loadProviders 有 mtime 缓存，代价可忽略），
 * 适配器不再依赖捕获的 store 快照。未注册（单测直接构造 store）时返回 undefined，
 * 由适配器回落到捕获 store 的快照读。
 * R30-4（三十轮）：显式 path 维度同 persistDegraded（见上注）。
 */
let _lookupDegraded: ((key: string, userDataPath?: string) => boolean | undefined) | null = null
export function registerDegradedLookup(fn: (key: string, userDataPath?: string) => boolean | undefined): void {
  _lookupDegraded = fn
}
export function lookupDegraded(key: string, userDataPath?: string): boolean | undefined {
  return _lookupDegraded?.(key, userDataPath)
}
/** 测试辅助：清空注册的查/写回调（防跨用例泄漏） */
export function resetDegradedChannels(): void {
  _lookupDegraded = null
  _persistDegraded = null
}

/** 当前启用的供应商；未配置 / currentId 指向已删条目 → null */
export function currentProvider(userDataPath: string): ProviderConf | null {
  const s = loadProviders(userDataPath)
  if (!s.currentId) return null
  return s.providers.find((p) => p.id === s.currentId) ?? null
}

// ── R0916-7-P3-6：provider 运行时端口（组装根注入面）──────────────────────

/**
 * 链路消费面 + 降级记忆回调注册面。服务端组装根（server/index.ts 的 createStudioServer）
 * 取一份传给路由 ctx（档位解析 / 当前供应商查询），并注入 AI 执行器（runner 经
 * configureProviderRuntime 取用注册面）——「用哪个运行时」的选择与 driver 同款：
 * 只在组装根做一次，下游不再各自取模块单例。
 *
 * 所有权：端口对象的生命周期归组装根；进程单例缺省（processProviderRuntime）即生产口径。
 * 残余（如实记）：适配器深处（src/ai/provider/*-adapter.ts）直接 import 本模块的
 * lookupDegraded/persistDegraded——那是本批改动面之外的实现文件，故「每实例一套降级记忆
 * 注册表」不可端到端成立；端口覆盖的是注册入口与读侧决策面。
 */
export interface ProviderRuntime {
  /** 读配置（含 vault 解密；mtime LRU 缓存） */
  loadProviders(userDataPath: string): ProviderStore
  /** 写配置（串行写链 + 跨进程锁；失败随 promise 上抛） */
  saveProviders(userDataPath: string, store: ProviderStore): Promise<void>
  /** 当前启用的供应商 */
  currentProvider(userDataPath: string): ProviderConf | null
  /** 档位解析（assistant/chat 未配 → 回落 creative + currentModel） */
  resolveTier(userDataPath: string | null, kind: 'creative' | 'assistant' | 'chat'): TierSlot
  /** 降级记忆落盘回调注册面（runner 侧注册；见 registerDegradedPersist） */
  registerDegradedPersist(fn: (key: string, userDataPath?: string) => void): void
  /** 降级记忆新鲜读回调注册面（见 registerDegradedLookup） */
  registerDegradedLookup(fn: (key: string, userDataPath?: string) => boolean | undefined): void
}

/** 进程单例运行时（组装根缺省值）：直连模块级实现，缺省即生产口径、零行为差异。 */
export function processProviderRuntime(): ProviderRuntime {
  return {
    loadProviders,
    saveProviders,
    currentProvider,
    resolveTier,
    registerDegradedPersist,
    registerDegradedLookup,
  }
}

/** 建运行时（覆盖项缺席即取进程单例实现）——多实例隔离 / 测试注入用。 */
export function createProviderRuntime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return { ...processProviderRuntime(), ...overrides }
}

/** 从已加载 store 算档位（纯函数，不读磁盘——供 resolveProvider 复用，避免重复 loadProviders） */
export function tierFromStore(s: ProviderStore, kind: 'creative' | 'assistant' | 'chat'): TierSlot {
  const fallback = s.currentModel ?? ''
  // RB-AI-P2-6：tiers 缺 creative 键（providers.json 直灌/半迁移）防御性访问——
  // 此前直接 .creative.model 抛 TypeError → API 500；缺键回落默认档位（currentModel + xhigh）
  if (kind === 'assistant' && s.tiers?.assistant) {
    return s.tiers.assistant.model ? s.tiers.assistant : { ...s.tiers.assistant, model: fallback }
  }
  if (kind === 'chat' && s.tiers?.chat) {
    return s.tiers.chat.model ? s.tiers.chat : { ...s.tiers.chat, model: fallback }
  }
  const creative = s.tiers?.creative
  if (!creative) return { model: fallback, effort: 'xhigh' }
  return creative.model ? creative : { ...creative, model: fallback }
}

/** 取档位配置（assistant/chat 未配 / model 为空 → 回落 creative + currentModel） */
export function resolveTier(userDataPath: string | null, kind: 'creative' | 'assistant' | 'chat'): TierSlot {
  if (!userDataPath) return { model: '', effort: 'xhigh' }
  return tierFromStore(loadProviders(userDataPath), kind)
}

/** 新供应商 ID */
export function newProviderId(): string {
  return `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 新 RAG 服务商 ID（rag- 前缀与 chat 服务商区分，vault 槽天然不撞） */
export function newRagProviderId(): string {
  return `rag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** key 遮蔽：只留前 4 后 4，不足 8 位 → *** */
export function maskKey(key: string): string {
  if (key.length < 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

/**
 * 当前供应商 + 当前模型的模型行覆盖（P9 §7.2 显式 resolve 链第 1 层）。
 * 运行时 `provider.conf.model` 已由 resolveProvider 注入实际档位模型。
 * 无行（供应商没配 / 行没有该 id）→ undefined，消费者回落 quirks 表/协议兜底。
 */
export function modelConfOf(conf: ProviderConf): ModelConf | undefined {
  return conf.models?.find((m) => m.id === conf.model)
}
