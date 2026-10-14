/**
 * 供应商端点编排体（providers.ts 的 handler 落地档）。
 *
 * 内容 = providers.ts 十个端点的 handler 全量业务与 body 解析器：列表（key 遮蔽）、新增、
 * 设为当前启用、任务档位（creative/assistant）、chat 单档、编辑、provider 级价格表、删除、
 * 拉模型列表、测试连接（探测 + 指纹核验写回）。method/path 声明与 parse/handler 的接线留
 * providers.ts，本档只承载被接线体。
 *
 * 行为不变量（纯下沉，逐字等价）：
 * - 统一前置：userDataPath 缺失 → 400 NO_USERDATA；随后 loadProviders → revisionError
 *   （409 REVISION_CONFLICT）→ 目标查找（404 NOT_FOUND）→ 变更 → saveProvidersOr500
 *   （500 WRITE_ERROR / 409 择一，见 provider-save-guard.ts）→ 200。各端点的判定次序与
 *   复用面逐位不变：`providers.current` 的 caps 前置校验（未探测不许启用 400）、
 *   `providers.put` 的 baseUrl 主机变更拒改 key（host-change-guard 单源）、
 *   `providers.delete` 的回落首项 caps 校验与 modelCaps 前缀清、`providers.test` 的
 *   探测指纹核验（窗口内配置已变则丢弃回写并留痕）全部原样。
 * - `providers.delete` / `providers.test` 的 body 读取保持**容错语义**（无 body 放行、
 *   仅 HttpError 透传），不经 defineRoute 的 parse 位——readJson 失败先于 parse 短路统一回
 *   400 的形状在 parse 化后不可表达，容错路径逐位保留。
 * - `providers.test` 的探测函数取注入档（ctx.probeCapabilities，undefined = 真探测）、
 *   第三参为组装根判定的 mock 结果（本档不读环境变量）。
 *
 * 依赖方向单向（无环）：本文件 → http / ai/provider（store 读写、id 生成、遮蔽、key 归一、
 * 模型清单、真探测、redact）/ 同目录 revision-guard + provider-save-guard + host-change-guard；
 * providers.ts 单向 import 本文件（本文件对 providers.ts 只有 type 面回引 ProvidersCtx）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, reply, HttpError, replyError, replyHttpError } from '../http.js'
import { revisionError } from './revision-guard.js'
import { saveProvidersOr500 } from './provider-save-guard.js'
import { sameEndpointHost, API_KEY_HOST_CHANGE_CODE, API_KEY_HOST_CHANGE_MESSAGE } from './host-change-guard.js'
import {
  loadProviders,
  newProviderId,
  maskKey,
  normalizeApiKey,
  apiKeyRefusal,
  type ProviderConf,
  type ModelConf,
  type Protocol,
  type AuthStrategy,
  type TierSlot,
  type EffortLevel,
} from '../../../ai/provider/index.js'
import type { Vault } from '../../../ai/provider/vault.js'
import { listModels } from '../../../ai/provider/models.js'
import { probeCapabilities as realProbeCapabilities } from '../../../ai/provider/probe.js'
import { redactSecret } from '../../../ai/provider/redact.js' // API 错误脱敏
import { log, errMsg } from '../../../log/index.js'
import type { ProvidersCtx } from './providers.js'

/** 下一可用排序号：max(现有)+1（防删除中间项后 length 撞号） */
function nextSortIndex(existing: Array<number | undefined>): number {
  let max = -1
  for (const x of existing) max = Math.max(max, x ?? 0)
  return max + 1
}

/** caps 有效性相关字段指纹（protocol/auth/baseUrl/apiKey）——这四个字段决定探测目标
 *  （服务端点 + 认证），变了则探测出的 caps 不再描述现配置。单源覆盖两处消费：
 *  ① PUT 端点 fieldsChanged（编辑后清 caps/capsProbedAt 与 modelCaps 前缀键）；
 *  ② POST /providers/:id/test 探测前抓指纹、探测后（可能被并发编辑）核验同一函数。 */
function capsFingerprint(p: Pick<ProviderConf, 'protocol' | 'auth' | 'baseUrl' | 'apiKey'>): string {
  return JSON.stringify([p.protocol, p.auth, p.baseUrl, p.apiKey])
}

/** key 遮蔽 + 凭据状态点——真实 key 从不回传前端（编辑不改 key 就传回空 = 保留）；
 * hasKey 以 vault 条目存在性推导（口径）：状态不依赖内存明文，半迁移收敛后必然一致 */
export function maskProvider(
  conf: ProviderConf,
  vault: Vault | null,
): ProviderConf & { apiKeyMasked: string; hasKey: boolean } {
  return {
    ...conf,
    apiKey: '', // 不回传原始 key（前端编辑时如不改 key 则传回空=保留原 key）
    apiKeyMasked: maskKey(conf.apiKey),
    hasKey: vault?.keys[conf.id] != null,
  }
}

/** DELETE 无 body 场景的 best-effort 读取（同 POST /providers/:id/test 容错口径） */
async function readExpectedRevisionOrNull(req: IncomingMessage): Promise<unknown> {
  try {
    const body = await readJson(req)
    return body['expectedRevision']
  } catch (e) {
    if (e instanceof HttpError) throw e
    return undefined
  }
}

/** 解析供应商输入（增/改共用）
 * §7.1：models 行——id 必填且供应商内唯一（trim 后）；contextWindow / maxTokens 若有须为正整数。
 *  models 缺省（undefined）= 不改模型行（编辑保留原值 / 新增不设）；传 [] = 清空。
 */
function parseProviderInput(body: Record<string, unknown>):
  | {
      ok: true
      name: string
      protocol: Protocol
      auth: AuthStrategy
      baseUrl: string
      apiKey: string
      models?: ModelConf[]
    }
  | { ok: false; error: string } {
  const name = String(body['name'] ?? '').trim()
  if (!name) return { ok: false, error: 'name 必填' }
  const conn = parseConnectionInput(body)
  if (!conn.ok) return conn
  const models = parseModels(body['models'])
  if (models === 'invalid') return { ok: false, error: 'models 行不合法：id 必填且供应商内唯一，容量须为正整数' }
  return { ...conn, name, models: models === undefined ? undefined : models }
}

/** 连接参数校验单源（增/改与 /models 手输探测共用）——此前只
 *  parseProviderInput 侧有校验，/models 对 protocol/auth 直接 as 断言、不校 baseUrl
 *  scheme，非法值原样透给 listModels/probe（打错目标）后以 500 GEN_FAIL 收场；
 *  两处各写一份校验必然漂移，故抽本函数。字段序 / 文案与 parseProviderInput 原实现
 *  逐位一致（name 与 models 的校验仍在调用方，本函数只管连接四要素）。 */
function parseConnectionInput(
  body: Record<string, unknown>,
):
  { ok: true; protocol: Protocol; auth: AuthStrategy; baseUrl: string; apiKey: string } | { ok: false; error: string } {
  const protocolRaw = String(body['protocol'] ?? '')
  // openai-responses 恢复放行，三选一校验（曾随误判拒配）
  const protocol = protocolRaw as Protocol
  if (protocol !== 'anthropic' && protocol !== 'openai' && protocol !== 'openai-responses') {
    return { ok: false, error: 'protocol 需为 anthropic / openai / openai-responses' }
  }
  // auth 从 body 读（UI 无该控件，兼容手改 providers.json 的旧数据）；缺省回落协议推断
  const authRaw = String(body['auth'] ?? '')
  const auth: AuthStrategy =
    authRaw === 'anthropic' || authRaw === 'claudeAuth' || authRaw === 'bearer'
      ? authRaw
      : protocol === 'anthropic'
        ? 'anthropic'
        : 'bearer'
  const baseUrl = String(body['baseUrl'] ?? '').trim()
  if (!baseUrl) return { ok: false, error: 'baseUrl 必填' }
  // scheme 校验（与 rag-providers 同口径）——防任意串当 URL 使 listModels/probe 打错目标
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'baseUrl 须以 http(s):// 开头' }
  // 已提交的 key 过传输不变量单点；留空是配置态（新增必填/编辑保留），由调用方按语义处理
  const keyChecked = normalizeApiKey(String(body['apiKey'] ?? ''))
  if (!keyChecked.ok && keyChecked.reason === 'illegalCharacters') {
    return { ok: false, error: apiKeyRefusal('illegalCharacters') }
  }
  const apiKey = keyChecked.ok ? keyChecked.value : ''
  return { ok: true, protocol, auth, baseUrl, apiKey }
}

/** 解析并校验模型行数组；undefined=未传，'invalid'=不合法 */
function parseModels(raw: unknown): ModelConf[] | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) return 'invalid'
  const ids = new Set<string>()
  const out: ModelConf[] = []
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) return 'invalid'
    const row = r as Record<string, unknown>
    const id = String(row['id'] ?? '').trim()
    if (!id || ids.has(id)) return 'invalid'
    ids.add(id)
    if (row['contextWindow'] !== undefined && row['contextWindow'] !== null) {
      if (
        typeof row['contextWindow'] !== 'number' ||
        !Number.isInteger(row['contextWindow']) ||
        row['contextWindow'] <= 0
      ) {
        return 'invalid'
      }
    }
    if (row['maxTokens'] !== undefined && row['maxTokens'] !== null) {
      if (typeof row['maxTokens'] !== 'number' || !Number.isInteger(row['maxTokens']) || row['maxTokens'] <= 0) {
        return 'invalid'
      }
    }
    const m: ModelConf = { id }
    if (typeof row['name'] === 'string' && row['name'].trim()) m.name = row['name'].trim()
    if (row['contextWindow'] !== undefined && row['contextWindow'] !== null) m.contextWindow = row['contextWindow']
    if (row['maxTokens'] !== undefined && row['maxTokens'] !== null) m.maxTokens = row['maxTokens']
    out.push(m)
  }
  return out
}

/** 解析档位槽输入（模型 + 推理等级 + 可选超时） */
function parseTierSlot(raw: Record<string, unknown>): { ok: true; slot: TierSlot } | { ok: false; error: string } {
  const model = String(raw['model'] ?? '').trim()
  if (!model) return { ok: false, error: 'model 必填' }
  const effort = String(raw['effort'] ?? 'xhigh')
  const VALID = ['low', 'medium', 'high', 'xhigh', 'max']
  if (!VALID.includes(effort)) {
    return { ok: false, error: `effort 需为 ${VALID.join('/')}` }
  }
  const slot: TierSlot = { model, effort: effort as EffortLevel }
  // P10：timeoutMs 可选——正整数 ms；非法显式拒绝（不静默丢用户输入）
  if (raw['timeoutMs'] !== undefined && raw['timeoutMs'] !== null) {
    if (typeof raw['timeoutMs'] !== 'number' || !Number.isInteger(raw['timeoutMs']) || raw['timeoutMs'] <= 0) {
      return { ok: false, error: 'timeoutMs 须为正整数毫秒' }
    }
    slot.timeoutMs = raw['timeoutMs']
  }
  return { ok: true, slot }
}

// ── body 解析器（全量：新增/current/档位/chat 档/编辑/拉模型清单）────────────
// providers.ts 的 parse 位按名引用本段——解析体（含各自的错误文案与字段序）单源本档。

/** 新增：models 与连接四要素共用 parseProviderInput；apiKey 必填（编辑才允许留空保留）。
 *  D10：新增时 apiKey 必填；expectedRevision 原样透传交 handler 判 409。 */
export function parseProviderCreateInput(raw: unknown): {
  name: string
  protocol: Protocol
  auth: AuthStrategy
  baseUrl: string
  apiKey: string
  models?: ModelConf[]
  expectedRevision: unknown
} {
  const body = (raw ?? {}) as Record<string, unknown>
  const parsed = parseProviderInput(body)
  if (!parsed.ok) throw new Error(parsed.error)
  // D10：新增时 apiKey 必填（编辑时留空 = 保留原 key）
  if (!parsed.apiKey) throw new Error('apiKey 必填')
  return { ...parsed, expectedRevision: body['expectedRevision'] }
}

/** 设为当前启用：纯抽取（无形状校验，零错误翻转） */
export function parseProvidersCurrentInput(raw: unknown): { id: string; expectedRevision: unknown } {
  const body = (raw ?? {}) as Record<string, unknown>
  return { id: String(body['id'] ?? ''), expectedRevision: body['expectedRevision'] }
}

/** 任务档位配置（创作档/助手档）——creative 必填，assistant 可缺省或显式 null */
export function parseTiersInput(raw: unknown): {
  creative: TierSlot
  assistant: TierSlot | null
  expectedRevision: unknown
} {
  const body = (raw ?? {}) as Record<string, unknown>
  const creativeRaw = body['creative']
  if (typeof creativeRaw !== 'object' || creativeRaw === null) {
    throw new Error('creative 档位必填')
  }
  const creative = parseTierSlot(creativeRaw as Record<string, unknown>)
  if (!creative.ok) throw new Error(creative.error)

  let assistant: TierSlot | null = null
  const assistantRaw = body['assistant']
  if (assistantRaw !== null && assistantRaw !== undefined) {
    if (typeof assistantRaw !== 'object') {
      throw new Error('assistant 档位需为对象或 null')
    }
    const a = parseTierSlot(assistantRaw as Record<string, unknown>)
    if (!a.ok) throw new Error(a.error)
    assistant = a.slot
  }
  return { creative: creative.slot, assistant, expectedRevision: body['expectedRevision'] }
}

/** chat 单档：{clear:true} / 空 {} = 清档（回落 creative）；其余进 parseTierSlot */
export function parseTiersChatInput(raw: unknown): {
  clear: boolean
  slot: TierSlot | null
  expectedRevision: unknown
} {
  // {clear:true} / 空 {} = 清除 chat 档（回落 creative）——对象形态可携带 expectedRevision。
  // readJson 已把字面 null 归一为 {}（http.ts `JSON.parse ?? {}`），旧注释的
  // 「null /」形态实际不可达；空对象即等价清档口径，死分支删除
  // 低-1：清档/解析两分支都以「body 是 JSON 对象」为前提——readJson 只归一
  // 字面 null，数字/布尔/数组/字符串等原语原样透出，`Object.keys(原语).length === 0`
  // 会把 5/true/[]/"" 误判成空对象静默清档（revision 还 bump）。原语一律 400 拒绝
  const body = (raw ?? {}) as Record<string, unknown>
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('body 需为 JSON 对象')
  }
  if (body['clear'] === true || Object.keys(body).length === 0) {
    return { clear: true as const, slot: null, expectedRevision: body['expectedRevision'] }
  }
  const parsed = parseTierSlot(body)
  if (!parsed.ok) throw new Error(parsed.error)
  return { clear: false as const, slot: parsed.slot, expectedRevision: body['expectedRevision'] }
}

/** 编辑（parseProviderInput 全量——body 校验先于 409/404 前置门发生） */
export function parseProviderUpdateInput(raw: unknown): {
  name: string
  protocol: Protocol
  auth: AuthStrategy
  baseUrl: string
  apiKey: string
  models?: ModelConf[]
  expectedRevision: unknown
} {
  const body = (raw ?? {}) as Record<string, unknown>
  const parsed = parseProviderInput(body)
  if (!parsed.ok) throw new Error(parsed.error)
  return { ...parsed, expectedRevision: body['expectedRevision'] }
}

/** 拉模型列表：id 分支只抽取，手输分支经 parseConnectionInput 单源校验 */
export function parseProvidersModelsInput(
  raw: unknown,
): { id: string } | { protocol: Protocol; auth: AuthStrategy; baseUrl: string; apiKey: string } {
  const body = (raw ?? {}) as Record<string, unknown>
  if (typeof body['id'] === 'string' && body['id']) return { id: body['id'] }
  const conn = parseConnectionInput(body)
  if (!conn.ok) throw new Error(conn.error)
  return conn
}

// ── handler 编排体（provider-save-guard 承接保存失败信封；revision 冲突 409）──

/** 列表（key 遮蔽）——按 sortIndex 排序后回 maskProvider 形状 + 当前档位/模型/价格表/revision。 */
export function handleProvidersList(ctx: ProvidersCtx, res: ServerResponse): void {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const s = loadProviders(ctx.userDataPath)
  reply(res, 200, {
    providers: s.providers.map((p) => maskProvider(p, s.vault)).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)),
    currentId: s.currentId,
    currentModel: s.currentModel,
    tiers: s.tiers,
    revision: s.revision,
  })
}

/** 新增供应商——新 id + caps 置空待探测 + sortIndex 取 max+1；首个供应商自动设为当前。 */
export async function handleProviderCreate(
  ctx: ProvidersCtx,
  routeCtx: {
    input: {
      name: string
      protocol: Protocol
      auth: AuthStrategy
      baseUrl: string
      apiKey: string
      models?: ModelConf[]
      expectedRevision: unknown
    }
  },
  res: ServerResponse,
): Promise<void> {
  const { input } = routeCtx
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const s = loadProviders(ctx.userDataPath)
  const revErr = revisionError(input.expectedRevision, s.revision)
  if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
  const conf: ProviderConf = {
    id: newProviderId(),
    name: input.name,
    protocol: input.protocol,
    auth: input.auth,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    ...(input.models !== undefined ? { models: input.models } : {}),
    caps: null,
    // max+1 防撞号——s.providers.length 在删过中间项后与存量 sortIndex 重复，排序不稳
    sortIndex: nextSortIndex(s.providers.map((p) => p.sortIndex)),
  }
  s.providers.push(conf)
  // 首个供应商自动设为当前——（ 裁定不采纳）：曾试「自动接任同样
  // 要求 caps 已探测」以对齐 PUT /current 的不变量，但 POST 首条语义是
  // e2e 钉死的引导性产品行为（ai-provider.spec：添加即「当前」徽章，测试连接之前），
  // caps 前置会让首用旅程出现「无当前供应商」空窗。两者并不冲突：caps 不变量管
  // 「手动切换/删任后改派」（防未验证顶掉已验证），空态首条接任是引导性默认，
  // 未验证即生成的风险由测试连接→工作台解灰动线自兜。
  if (!s.currentId) s.currentId = conf.id
  if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return
  reply(res, 200, { provider: maskProvider(conf, s.vault), revision: s.revision })
}

/** 设为当前启用——caps 未探测者不许启用（服务端校验，前端守卫可绕过）。 */
export async function handleProvidersCurrent(
  ctx: ProvidersCtx,
  routeCtx: { input: { id: string; expectedRevision: unknown } },
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const id = routeCtx.input.id
  const s = loadProviders(ctx.userDataPath)
  const revErr = revisionError(routeCtx.input.expectedRevision, s.revision)
  if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
  const target = id ? s.providers.find((p) => p.id === id) : undefined
  if (id && !target) {
    return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
  }
  // 未探测不许启用——服务端校验 caps（前端守卫可绕过）
  if (target && !target.caps) {
    return replyError(res, 400, 'BAD_INPUT', `供应商「${target.name}」尚未测试连接，请先探测能力`)
  }
  s.currentId = id || null
  if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return
  // saveProviders bump revision——回传新值，前端 activate() 同步，否则后续写因陈旧 expectedRevision 409
  reply(res, 200, { ok: true, currentId: s.currentId, revision: s.revision })
}

/** 任务档位配置（创作档/助手档）——chat 档保持原值；同步 currentModel 兼容 resolveTier 回落。 */
export async function handleTiersPut(
  ctx: ProvidersCtx,
  routeCtx: { input: { creative: TierSlot; assistant: TierSlot | null; expectedRevision: unknown } },
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const input = routeCtx.input
  const s = loadProviders(ctx.userDataPath)
  const revErr = revisionError(input.expectedRevision, s.revision)
  if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
  s.tiers = { creative: input.creative, assistant: input.assistant, chat: s.tiers.chat }
  // 同步 currentModel（兼容 resolveTier 回落逻辑）
  s.currentModel = input.creative.model || null
  if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return

  // 表驱动重构（§6.3）：不再触发模型级探测——能力由静态表判定
  reply(res, 200, { ok: true, tiers: s.tiers, revision: s.revision, details: {} })
}

/** chat 单档——改 chat 档不动 creative/assistant/currentModel；clear 与 slot 两分支同参 reply。 */
export async function handleTiersChatPut(
  ctx: ProvidersCtx,
  routeCtx: { input: { clear: boolean; slot: TierSlot | null; expectedRevision: unknown } },
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const input = routeCtx.input
  const s = loadProviders(ctx.userDataPath)
  const revErr = revisionError(input.expectedRevision, s.revision)
  if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
  s.tiers = { ...s.tiers, chat: input.clear ? null : input.slot }
  if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return

  // 表驱动重构（§6.3）：不再异步探测 caps——能力由静态表判定
  reply(res, 200, { ok: true, tiers: s.tiers, revision: s.revision })
}

/** 编辑供应商——主机变更拒改 key 先于 key 计算与赋值；caps/modelCaps 按指纹变化清空重探。 */
export async function handleProviderUpdate(
  ctx: ProvidersCtx,
  routeCtx: {
    params: Record<string, string>
    input: {
      name: string
      protocol: Protocol
      auth: AuthStrategy
      baseUrl: string
      apiKey: string
      models?: ModelConf[]
      expectedRevision: unknown
    }
  },
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const input = routeCtx.input
  const id = routeCtx.params['id'] ?? ''
  // body 读取/校验已在读体段完成（更先于 loadProviders）——load 与 save 间
  // 隔着 await readJson 时并发编辑丢更新（前置闸收口注：本
  // handler 的 load→mutate→save 全同步无 await，同刻并发由写链串行 + 跨进程锁互斥；
  // 排队写窗口内基线漂移由 saveProvidersLocked 锁内写前 revision 复验兜底——漂移即
  // 拒绝落盘，经 saveProvidersOr500 映射 409 REVISION_CONFLICT，前端刷新重读重放）
  const s = loadProviders(ctx.userDataPath)
  const revErr = revisionError(input.expectedRevision, s.revision)
  if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
  const idx = s.providers.findIndex((p) => p.id === id)
  if (idx < 0) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')

  const existing = s.providers[idx]!
  // baseUrl 主机变更时不得静默沿用已存 Key——判定口径、
  // 拒绝码与文案见 host-change-guard.ts（同源另供 /api/rag-providers，先例 = revision-guard
  // 的三处拷贝收敛）；此处只保留「为什么挂在这个位置」：必须早于下方 newKey 计算与
  // s.providers[idx] 赋值，否则失败路径已把旧 Key 配到新主机上。
  if (!input.apiKey && !sameEndpointHost(existing.baseUrl, input.baseUrl)) {
    return replyError(res, 400, API_KEY_HOST_CHANGE_CODE, API_KEY_HOST_CHANGE_MESSAGE)
  }
  // apiKey 为空 = 不改（保留原 key）
  const newKey = input.apiKey || existing.apiKey
  // 编辑后 caps 可能不再准确（baseUrl/key/model 变了）→ 清空要求重新探测。
  // 判定与 POST /providers/:id/test 的探测写回快照核验同源——两处都取
  // capsFingerprint 单源（原 fieldsChanged 手工四比较 + probeFingerprint 各自维护，
  // 注释自认「两处将来须同步演进」，漏改一处即漂移）。
  const fieldsChanged =
    capsFingerprint(existing) !==
    capsFingerprint({ protocol: input.protocol, auth: input.auth, baseUrl: input.baseUrl, apiKey: newKey })

  s.providers[idx] = {
    ...existing,
    name: input.name,
    protocol: input.protocol,
    auth: input.auth,
    baseUrl: input.baseUrl,
    apiKey: newKey,
    // models 未传 = 保留原模型行；传 [] = 清空
    models: input.models !== undefined ? input.models : existing.models,
    caps: fieldsChanged ? null : existing.caps,
    capsProbedAt: fieldsChanged ? undefined : existing.capsProbedAt,
  }
  // 编辑后 modelCaps 可能不再准确（baseUrl/key 变了）→ 清缓存要求重新探测
  if (fieldsChanged) {
    const prefix = `${id}/`
    for (const key of Object.keys(s.modelCaps)) {
      if (key.startsWith(prefix)) delete s.modelCaps[key]
    }
  }
  if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return
  reply(res, 200, { provider: maskProvider(s.providers[idx]!, s.vault), revision: s.revision })
}

/** provider 级价格表写回——null = 清除（pricing 置 undefined）。 */
export async function handleProviderPricing(
  ctx: ProvidersCtx,
  routeCtx: {
    params: Record<string, string>
    input: { expectedRevision: unknown; pricing: NonNullable<ProviderConf['pricing']> | null }
  },
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const input = routeCtx.input
  const id = routeCtx.params['id'] ?? ''
  const s = loadProviders(ctx.userDataPath)
  const revErr = revisionError(input.expectedRevision, s.revision)
  if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
  const idx = s.providers.findIndex((p) => p.id === id)
  if (idx < 0) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')

  if (input.pricing === null) {
    s.providers[idx] = { ...s.providers[idx]!, pricing: undefined }
    if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return
    return reply(res, 200, { ok: true, pricing: null, revision: s.revision })
  }
  s.providers[idx] = { ...s.providers[idx]!, pricing: input.pricing }
  if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return
  reply(res, 200, { ok: true, pricing: input.pricing, revision: s.revision })
}

/** 删除——回落首项同样要求 caps 已探测；modelCaps 前缀条目随删。 */
export async function handleProviderDelete(
  ctx: ProvidersCtx,
  routeCtx: { params: Record<string, string> },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const id = routeCtx.params['id'] ?? ''
  // DELETE 无 body 常规场景容错——有 body 才读 expectedRevision（旧客户端/脚本无 body 放行）
  const expected = await readExpectedRevisionOrNull(req)
  const s = loadProviders(ctx.userDataPath)
  const revErr = revisionError(expected, s.revision)
  if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
  const idx = s.providers.findIndex((p) => p.id === id)
  if (idx < 0) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
  s.providers.splice(idx, 1)
  if (s.currentId === id) {
    // 回落首项也需校验 caps（与 PUT current 一致——未探测不许启用）
    const next = s.providers[0]
    s.currentId = next?.caps ? next.id : null
  }
  // 删除供应商时清除其 modelCaps 缓存条目（换端点后不能沿用旧能力判定）
  const mcPrefix = `${id}/`
  for (const key of Object.keys(s.modelCaps)) {
    if (key.startsWith(mcPrefix)) delete s.modelCaps[key]
  }
  if (!(await saveProvidersOr500(res, ctx.userDataPath, s))) return
  reply(res, 200, { ok: true, currentId: s.currentId, revision: s.revision })
}

/** 拉模型列表——id 分支用已存凭据，手输分支用请求体凭据；缺地址或 Key 一律 400。 */
export async function handleProvidersModels(
  ctx: ProvidersCtx,
  routeCtx: {
    input: { id: string } | { protocol: Protocol; auth: AuthStrategy; baseUrl: string; apiKey: string }
  },
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const input = routeCtx.input
  let protocol: Protocol
  let baseUrl: string
  let apiKey: string
  let auth: AuthStrategy
  if ('id' in input) {
    const s = loadProviders(ctx.userDataPath)
    const p = s.providers.find((x) => x.id === input.id)
    if (!p) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
    protocol = p.protocol
    baseUrl = p.baseUrl
    apiKey = p.apiKey
    auth = p.auth
  } else {
    protocol = input.protocol
    baseUrl = input.baseUrl
    apiKey = input.apiKey
    auth = input.auth
  }
  // 手输分支的 baseUrl/apiKey 形状已在读体段过 parseConnectionInput
  // （缺 baseUrl 回「baseUrl 必填」），此闸现只兜「id 分支指向的存量配置缺 Key/地址」
  // （手改 providers.json 形态）——两分支合流后判定，文案与旧序一致。
  if (!baseUrl || !apiKey) return replyError(res, 400, 'BAD_INPUT', 'API 地址和 Key 必填')
  try {
    // mock 快路读注入的 driver.kind（原由 listModels 自读 CLWRITING_DRIVER）
    const models = await listModels(protocol, baseUrl, apiKey, auth, undefined, {
      mock: ctx.driver.kind === 'mock',
    })
    reply(res, 200, { models })
  } catch (e) {
    // 错误脱敏（探测是 AI 网络往返 → GEN_FAIL，与 /models 端点同族）
    replyError(res, 500, 'GEN_FAIL', `获取模型列表失败：${redactSecret(errMsg(e))}`)
  }
}

/** 测试连接（探测能力）——探测前抓配置指纹，探测后重载核验；窗口内配置已变则丢弃回写。 */
export async function handleProviderTest(
  ctx: ProvidersCtx,
  routeCtx: { params: Record<string, string> },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
  const id = routeCtx.params['id'] ?? ''

  try {
    // 前端可指定测试模型；未指定则用全局当前模型；都无则回落 conf.model（废弃旧值）
    //（body 先读；探测是 10s+ 网络往返，load 克隆不能跨它存活——探测后重载再写）
    // 注释对齐实现（选低风险侧，语义是已定的正确口径）——
    // readJson 的空 body 走 resolve({}) 根本不进 catch；协议类错误（坏 JSON 400 / 超限
    // 413，均 HttpError）透传外层统一回信封；本 catch 只容错连接层异常（socket error
    // 非 HttpError）按空 body 兜底继续探测。原注释「只容错无 body/坏 JSON」两处皆失实。
    let body: Record<string, unknown> = {}
    try {
      body = await readJson(req)
    } catch (e) {
      if (e instanceof HttpError) throw e // 坏 JSON 400 / 413 超限等协议类错误透传（口径）
    }
    const snapshot = loadProviders(ctx.userDataPath)
    const conf = snapshot.providers.find((p) => p.id === id)
    if (!conf) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
    const probeModel =
      typeof body['model'] === 'string' && body['model'] ? body['model'] : (snapshot.currentModel ?? conf.model)
    // 探测前抓配置指纹——探测是 10s+ 网络往返，窗口内供应商可能被
    // 编辑（PUT 改 baseUrl/key 后会清 caps 要求重新探测）；探测完成后旧快照的 caps 直接
    // 回写会把「打旧端点/旧 key 探出的能力」盖到新配置上，恰好绕过该不变量（PUT /current
    // 的 caps 校验随之形同虚设）。指纹取 caps 有效性相关四字段（与 PUT 的 fieldsChanged
    // 同源；name/models 改动不影响服务级 caps，不误伤）。
    const probeFp = capsFingerprint(conf)
    // 收尾：探测函数经 ctx（组装根 RouteOverrides）注入——undefined 走真探测
    const probe = ctx.probeCapabilities ?? realProbeCapabilities
    // 透传探测目标库 userDataPath——探测实例降级记忆落目标库
    // providers.json，不再回落「活跃库」（双库时写错库）；
    // 第三参 = mock 选择结果（读注入的 driver.kind，原由 probe 自读环境变量）
    const { caps, details } = await probe({ ...conf, model: probeModel }, ctx.userDataPath, ctx.driver.kind === 'mock')
    // 写回探测结果——重载 + 重找（探测期间 provider 可能被编辑/删除；丢了不硬写旧克隆）
    const s2 = loadProviders(ctx.userDataPath)
    const target = s2.providers.find((p) => p.id === id)
    if (target) {
      if (capsFingerprint(target) === probeFp) {
        target.caps = caps
        target.capsProbedAt = Date.now()
        // 探测写回同样过保存失败闸（外层 catch 兜不到 WRITE_ERROR 口径）
        if (!(await saveProvidersOr500(res, ctx.userDataPath, s2))) return
      } else {
        // 探测窗口内配置已变——旧快照 caps 不再描述现配置，丢弃回写并留痕；
        // 探测结果仍随本次响应回传（对发起者有信息量）；未落盘 → revision 不 bump。
        log.warn('api', `providers test：探测期间供应商配置已变更，丢弃旧快照 caps 回写（${id}）`)
      }
    }
    // 探测写回会 bump revision——回传新 revision，前端 test 同步，
    // 否则测试后任意写（新增/编辑/档位）都会因 expectedRevision 陈旧 409（竞态）
    reply(res, 200, { ok: true, caps, details, revision: s2.revision })
  } catch (e) {
    // readJson rethrow 的 HttpError（400 坏 JSON / 413 超限）先透传——
    // 此前落进本 catch-all 被包成 500 GEN_FAIL，内层「413 等透传」注释未成立
    if (e instanceof HttpError) return replyHttpError(res, e)
    // 错误脱敏（探测是 AI 网络往返 → GEN_FAIL，与 /models 端点同族）
    replyError(res, 500, 'GEN_FAIL', redactSecret(errMsg(e)))
  }
}
