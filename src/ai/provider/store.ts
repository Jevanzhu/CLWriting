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
import { readFileSync, mkdirSync, existsSync, chmodSync, copyFileSync, statSync } from 'node:fs'
import { atomicWriteFile } from '../../fs/atomic.js'
import { dirname, join } from 'node:path'
import type { ProviderConf, ModelConf, TierSlot, TierConfig, RagProviderConf } from './types.js'
import { builtinKeyMaterial } from './vault-key.js'
import { log } from '../../log/index.js'
import {
  createVault,
  openVault,
  sealKey,
  openKey,
  type Vault,
} from './vault.js'

const FILE = 'providers.json'

/**
 * mtime 缓存——避免每次 AI 生成重复 readFileSync + AES-256-GCM 解密。
 * saveProviders 写后失效；外部改动经 mtime 检测自动失效。
 */
let _cache: { path: string; store: ProviderStore; mtime: number } | null = null

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
 * W-P2-9：主文件损坏时的备份恢复引导。
 * 从 providers.bak.json 复制回主文件（并尝试保持 0600 权限）。
 * @returns null=恢复成功；string=恢复失败原因（bak 缺失/读失败/复制失败）。
 */
function tryRestoreFromBak(fp: string, bakFp: string): string | null {
  if (!existsSync(bakFp)) return '备份文件不存在'
  try {
    copyFileSync(bakFp, fp)
    try {
      chmodSync(fp, 0o600)
    } catch {
      /* 平台不支持 chmod 则忽略 */
    }
    _cache = null // 恢复后强制重读
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * 读 providers.json → 解密 → ProviderStore（含明文 apiKey）。
 *
 * 解密失败（版本过高 / 认证失败）抛错——S5 会兜住"损坏不静默"，
 * 当前版本向上传播，由调用方（server API）转成错误响应。
 */
export function loadProviders(userDataPath: string): ProviderStore {
  const fp = `${userDataPath}/${FILE}`
  if (!existsSync(fp)) {
    _cache = null
    return emptySettings()
  }

  // mtime 缓存命中——跳过 readFileSync + vault 解密（高频 AI 生成场景核心优化）
  // P2-SEC-4：返回副本而非同一引用——调用方（API 端点）会直接 mutate store 后 saveProviders，
  // 若缓存返回原引用，未 save 的中间态会泄漏给后续 loadProviders 调用方
  try {
    const mtime = statSync(fp).mtimeMs
    if (_cache && _cache.path === fp && _cache.mtime === mtime) return cloneStore(_cache.store)
  } catch {
    _cache = null
  }

  let raw: DiskFormat
  const bakFp = `${dirname(fp)}/providers.bak.json`
  try {
    raw = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
  } catch (e) {
    // W-P2-9：损坏不静默，且不再直接放弃——主文件解析失败时尝试从 bak 恢复
    // （save 每次写前都会生成 providers.bak.json，理论上是最新一份完整配置）。
    // 恢复成功 → 用备份内容继续（并在下方用恢复后的内容重写主文件，重建一致状态）。
    const bakErr = tryRestoreFromBak(fp, bakFp)
    if (bakErr) {
      // D6：备份也不可用 → 保留原文件、向上报错（router 全局 catch 转 500 响应）
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
    const bakErr = tryRestoreFromBak(fp, bakFp)
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
      log.warn(
        'providers',
        `providers.json 形状损坏（providers 非数组）${bakErr ? `，备份恢复失败：${bakErr}` : '，备份内容亦不可用'}——已重置为空配置（损坏文件保留，可从 providers.bak.json 手动恢复）`,
      )
      return emptySettings()
    }
  }

  const vault: Vault | null = raw.vault ?? null
  let dek: Buffer | null = null

  if (vault) {
    // 版本守卫 + HKDF 派生 KEK + 解封 DEK（可能抛 VaultVersionError / VaultDecryptError）
    dek = openVault(vault, builtinKeyMaterial())
  }

  // 逐条提取明文 apiKey，按 §五半迁移规则收敛
  let needsRewrite = false
  const providers: ProviderConf[] = raw.providers.map((p) => {
    const conf = { ...p, apiKey: '' } as ProviderConf
    if (vault && dek && vault.keys[conf.id]) {
      // vault 有 → 解密（vault 永远优先）
      conf.apiKey = openKey(dek, vault.keys[conf.id]!)
      // 残留明文 apiKey 字段 → 标记清理
      if (p.apiKey) needsRewrite = true
    } else if (p.apiKey) {
      // vault 缺该条目但明文有 → 补迁移
      conf.apiKey = p.apiKey
      needsRewrite = true
    }
    return conf
  })

  // 无 vault 但有明文 apiKey → 全量首次迁移
  if (!vault && providers.some((p) => p.apiKey)) {
    needsRewrite = true
  }

  // RAG（嵌入）服务商——同款解密/明文迁移规则。形状坏容错为 []：
  // ragProviders 是后加段，不能因它拖累 chat providers 走整文件 bak 恢复链。
  const ragRaw = Array.isArray(raw.ragProviders) ? raw.ragProviders : []
  const ragProviders: RagProviderConf[] = ragRaw.map((p) => {
    const conf = { ...p, apiKey: '' } as RagProviderConf
    if (vault && dek && vault.keys[conf.id]) {
      conf.apiKey = openKey(dek, vault.keys[conf.id]!)
      if (p.apiKey) needsRewrite = true
    } else if (p.apiKey) {
      conf.apiKey = p.apiKey
      needsRewrite = true
    }
    return conf
  })
  if (!vault && ragProviders.some((p) => p.apiKey)) {
    needsRewrite = true
  }

  const store: ProviderStore = { providers, currentId: raw.currentId ?? null, currentModel: raw.currentModel ?? null, modelCaps: raw.modelCaps ?? {}, tiers: raw.tiers ?? defaultTiers(raw.currentModel ?? null), ragProviders, revision: raw.revision ?? 0, vault, dek }

  // 迁移写回——剥离明文、加密进 vault（§五）
  if (needsRewrite) {
    saveProviders(userDataPath, store)
  }

  // 更新 mtime 缓存
  try {
    _cache = { path: fp, store, mtime: statSync(fp).mtimeMs }
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
 */
export function saveProviders(userDataPath: string, store: ProviderStore): void {
  const fp = `${userDataPath}/${FILE}`
  mkdirSync(dirname(fp), { recursive: true })

  // 确保 vault + DEK（首次创建或迁移时新建）
  let vault = store.vault
  let dek = store.dek
  if (!vault || !dek) {
    const created = createVault(builtinKeyMaterial())
    vault = created.vault
    dek = created.dek
    store.vault = vault
    store.dek = dek
  }

  // 以 providers + ragProviders 为准重建 vault.keys——加密每个 apiKey。
  // 两类 key 必须同批收齐：漏收任一类 = 存另一类时静默抹掉它的密文。
  vault.keys = {}
  const sealKeyOf = (id: string, apiKey: string): void => {
    if (apiKey) vault!.keys[id] = sealKey(dek!, apiKey)
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

  // 写后失效缓存（下次 loadProviders 自动重读 + 更新缓存）
  _cache = null
}

/**
 * 400 降级记忆落盘回调（U-P2-2）——适配器深处只持有 store 的内存 clone
 * （P2-SEC-4：loadProviders 返回副本），mutate 不回缓存也无人保存。
 * runner 侧注册落盘函数（load→改→save 读盘最新，防覆盖并发改动），
 * 适配器经 persistDegraded 转发；未注册（如单测直接构造 store）时静默跳过。
 */
let _persistDegraded: ((key: string) => void) | null = null
export function registerDegradedPersist(fn: (key: string) => void): void {
  _persistDegraded = fn
}
export function persistDegraded(key: string): void {
  if (!_persistDegraded) return
  try {
    _persistDegraded(key)
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
 */
let _lookupDegraded: ((key: string) => boolean | undefined) | null = null
export function registerDegradedLookup(fn: (key: string) => boolean | undefined): void {
  _lookupDegraded = fn
}
export function lookupDegraded(key: string): boolean | undefined {
  return _lookupDegraded?.(key)
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
