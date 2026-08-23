/**
 * AI 服务供应商管理端点（方案 §四① + W1.5）。
 *
 * GET  /api/providers                         → 列表（key 遮蔽）
 * POST /api/providers                         → 新增供应商 → {provider}(key 遮蔽)
 * PUT  /api/providers/:id                     → 编辑供应商
 * DELETE /api/providers/:id                   → 删除供应商
 * PUT  /api/providers/current                  body {id}    → 设为当前启用
 * POST /api/providers/:id/test                → 测试连接（探测能力）→ {caps, details}
 *
 * 供应商配置落 userDataPath/providers.json（应用级，跨书共享，不进 git）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, HttpError, replyError } from '../http.js'
import { revisionError } from './revision-guard.js' // X-25：三处拷贝收敛单源（原 P4 本地实现）
import {
  loadProviders,
  saveProviders,
  newProviderId,
  maskKey,
  probeCapabilities,
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
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏

interface ProvidersCtx {
  userDataPath: string | null
}

export function registerProvidersRoutes(ctx: ProvidersCtx): void {
  // 列表（key 遮蔽）
  defineRoute('providers.get', {
    method: 'GET',
    path: '/api/providers',
    handler: (_, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const s = loadProviders(ctx.userDataPath)
    reply(res, 200, {
      providers: s.providers.map((p) => maskProvider(p, s.vault)).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)),
      currentId: s.currentId,
      currentModel: s.currentModel,
      tiers: s.tiers,
      revision: s.revision,
    })
  },
  })

  // 新增
  defineRoute('providers.post', {
    method: 'POST',
    path: '/api/providers',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const body = await readJson(req)
    const parsed = parseProviderInput(body)
    if (!parsed.ok) return replyError(res, 400, 'BAD_INPUT', parsed.error)
    // D10：新增时 apiKey 必填（编辑时留空 = 保留原 key）
    if (!parsed.apiKey) return replyError(res, 400, 'BAD_INPUT', 'apiKey 必填')

    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const conf: ProviderConf = {
      id: newProviderId(),
      name: parsed.name,
      protocol: parsed.protocol,
      auth: parsed.auth,
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      ...(parsed.models !== undefined ? { models: parsed.models } : {}),
      caps: null,
      // dd-P3：max+1 防撞号——s.providers.length 在删过中间项后与存量 sortIndex 重复，排序不稳
      sortIndex: nextSortIndex(s.providers.map((p) => p.sortIndex)),
    }
    s.providers.push(conf)
    // 首个供应商自动设为当前
    if (!s.currentId) s.currentId = conf.id
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { provider: maskProvider(conf, s.vault), revision: s.revision })
  },
  })

  // 设为当前启用（必须先于 /:id 注册——router 按注册顺序匹配，被 :id 遮蔽则 current 永不命中，P0-1）
  defineRoute('providers.current', {
    method: 'PUT',
    path: '/api/providers/current',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const body = await readJson(req)
    const id = String(body['id'] ?? '')
    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const target = id ? s.providers.find((p) => p.id === id) : undefined
    if (id && !target) {
      return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
    }
    // P2-6：未探测不许启用——服务端校验 caps（前端守卫可绕过）
    if (target && !target.caps) {
      return replyError(res, 400, 'BAD_INPUT', `供应商「${target.name}」尚未测试连接，请先探测能力`)
    }
    s.currentId = id || null
    saveProviders(ctx.userDataPath, s)
    // saveProviders bump revision——回传新值，前端 activate() 同步，否则后续写因陈旧 expectedRevision 409（P4）
    reply(res, 200, { ok: true, currentId: s.currentId, revision: s.revision })
  },
  })

  // D 档：任务档位配置（创作档/助手档）——模型 + 推理深度 + 单次输出上限
  defineRoute('tiers', {
    method: 'PUT',
    path: '/api/tiers',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const body = await readJson(req)
    const creativeRaw = body['creative']
    if (typeof creativeRaw !== 'object' || creativeRaw === null) {
      return replyError(res, 400, 'BAD_INPUT', 'creative 档位必填')
    }
    const creative = parseTierSlot(creativeRaw as Record<string, unknown>)
    if (!creative.ok) return replyError(res, 400, 'BAD_INPUT', creative.error)

    let assistant: TierSlot | null = null
    const assistantRaw = body['assistant']
    if (assistantRaw !== null && assistantRaw !== undefined) {
      if (typeof assistantRaw !== 'object') {
        return replyError(res, 400, 'BAD_INPUT', 'assistant 档位需为对象或 null')
      }
      const a = parseTierSlot(assistantRaw as Record<string, unknown>)
      if (!a.ok) return replyError(res, 400, 'BAD_INPUT', a.error)
      assistant = a.slot
    }

    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    s.tiers = { creative: creative.slot, assistant, chat: s.tiers.chat }
    // 同步 currentModel（兼容 resolveTier 回落逻辑）
    s.currentModel = creative.slot.model || null
    saveProviders(ctx.userDataPath, s)

    // 表驱动重构（§6.3）：不再触发模型级探测——能力由静态表判定
    reply(res, 200, { ok: true, tiers: s.tiers, revision: s.revision, details: {} })
  },
  })

  // chat 单档端点——对话框内随手换模型，不碰 creative/assistant/currentModel
  // caps 探测改异步不阻塞（结果经后续 GET /providers 刷新）
  defineRoute('tiers.chat', {
    method: 'PUT',
    path: '/api/tiers/chat',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const body = await readJson(req)

    // {clear:true} / 空 {} = 清除 chat 档（回落 creative）——对象形态可携带 expectedRevision。
    // 第九轮 L-2：readJson 已把字面 null 归一为 {}（http.ts `JSON.parse ?? {}`），旧注释的
    // 「null /」形态实际不可达；空对象即等价清档口径，死分支删除
    // 低-1（第十轮）：清档/解析两分支都以「body 是 JSON 对象」为前提——readJson 只归一
    // 字面 null，数字/布尔/数组/字符串等原语原样透出，`Object.keys(原语).length === 0`
    // 会把 5/true/[]/"" 误判成空对象静默清档（revision 还 bump）。原语一律 400 拒绝
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return replyError(res, 400, 'BAD_INPUT', 'body 需为 JSON 对象')
    }
    if (body['clear'] === true || Object.keys(body).length === 0) {
      const s = loadProviders(ctx.userDataPath)
      const revErr = revisionError(body?.['expectedRevision'], s.revision)
      if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
      s.tiers = { ...s.tiers, chat: null }
      saveProviders(ctx.userDataPath, s)
      return reply(res, 200, { ok: true, tiers: s.tiers, revision: s.revision })
    }

    const parsed = parseTierSlot(body as Record<string, unknown>)
    if (!parsed.ok) return replyError(res, 400, 'BAD_INPUT', parsed.error)

    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    s.tiers = { ...s.tiers, chat: parsed.slot }
    saveProviders(ctx.userDataPath, s)

    // 表驱动重构（§6.3）：不再异步探测 caps——能力由静态表判定
    reply(res, 200, { ok: true, tiers: s.tiers, revision: s.revision })
  },
  })

  // 编辑
  defineRoute('providers.put', {
    method: 'PUT',
    path: '/api/providers/:id',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const id = params['id'] ?? ''
    // dd-P2：读 body 先于 loadProviders——load→mutate→save 三段必须同步无 await
    //（单事件循环内原子），此前 load 与 save 间隔着 await readJson，并发编辑丢更新
    const body = await readJson(req)
    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const idx = s.providers.findIndex((p) => p.id === id)
    if (idx < 0) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')

    const parsed = parseProviderInput(body)
    if (!parsed.ok) return replyError(res, 400, 'BAD_INPUT', parsed.error)

    const existing = s.providers[idx]!
    // apiKey 为空 = 不改（保留原 key）
    const newKey = parsed.apiKey || existing.apiKey
    // 编辑后 caps 可能不再准确（baseUrl/key/model 变了）→ 清空要求重新探测
    const fieldsChanged =
      existing.baseUrl !== parsed.baseUrl ||
      existing.apiKey !== newKey ||
      existing.protocol !== parsed.protocol ||
      existing.auth !== parsed.auth

    s.providers[idx] = {
      ...existing,
      name: parsed.name,
      protocol: parsed.protocol,
      auth: parsed.auth,
      baseUrl: parsed.baseUrl,
      apiKey: newKey,
      // P9：models 未传 = 保留原模型行；传 [] = 清空
      models: parsed.models !== undefined ? parsed.models : existing.models,
      caps: fieldsChanged ? null : existing.caps,
      capsProbedAt: fieldsChanged ? undefined : existing.capsProbedAt,
    }
    // P0-3：编辑后 modelCaps 可能不再准确（baseUrl/key 变了）→ 清缓存要求重新探测
    if (fieldsChanged) {
      const prefix = `${id}/`
      for (const key of Object.keys(s.modelCaps)) {
        if (key.startsWith(prefix)) delete s.modelCaps[key]
      }
    }
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { provider: maskProvider(s.providers[idx]!, s.vault), revision: s.revision })
  },
  })

  // D2（批 5）：provider 级价格表——独立端点而非并入编辑主链路（价格不影响连通性，
  // 不该连带 caps 重置/重新探测；解析也独立：四档单价均为正数或省略，null = 清除）
  defineRoute('providers.pricing', {
    method: 'PUT',
    path: '/api/providers/:id/pricing',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const id = params['id'] ?? ''
    const body = await readJson(req)
    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const idx = s.providers.findIndex((p) => p.id === id)
    if (idx < 0) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')

    const raw = body['pricing']
    if (raw === null || raw === undefined) {
      s.providers[idx] = { ...s.providers[idx]!, pricing: undefined }
      saveProviders(ctx.userDataPath, s)
      return reply(res, 200, { ok: true, pricing: null, revision: s.revision })
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return replyError(res, 400, 'BAD_INPUT', 'pricing 需为对象或 null')
    }
    const p = raw as Record<string, unknown>
    const pos = (v: unknown): number | undefined | 'bad' =>
      v === undefined || v === null || v === '' ? undefined : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 'bad'
    const pricing: NonNullable<import('../../../ai/provider/types.js').ProviderConf['pricing']> = {}
    for (const key of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'] as const) {
      const v = pos(p[key])
      if (v === 'bad') return replyError(res, 400, 'BAD_INPUT', `pricing.${key} 需为非负数字`)
      if (v !== undefined) pricing[key] = v
    }
    if (typeof p['currency'] === 'string' && p['currency'].trim()) pricing.currency = p['currency'].trim()
    if (Object.keys(pricing).length === 0) {
      return replyError(res, 400, 'BAD_INPUT', 'pricing 至少需要一个单价键（inputPerMTok/outputPerMTok/cacheReadPerMTok/cacheWritePerMTok，单位：每百万 token）')
    }
    s.providers[idx] = { ...s.providers[idx]!, pricing }
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { ok: true, pricing, revision: s.revision })
  },
  })

  // 删除
  defineRoute('providers.delete', {
    method: 'DELETE',
    path: '/api/providers/:id',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const id = params['id'] ?? ''
    // P4：DELETE 无 body 常规场景容错——有 body 才读 expectedRevision（旧客户端/脚本无 body 放行）
    const expected = await readExpectedRevisionOrNull(req)
    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(expected, s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const idx = s.providers.findIndex((p) => p.id === id)
    if (idx < 0) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
    s.providers.splice(idx, 1)
    if (s.currentId === id) {
      // P2：回落首项也需校验 caps（与 PUT current 一致——未探测不许启用）
      const next = s.providers[0]
      s.currentId = next?.caps ? next.id : null
    }
    // P0-3：删除供应商时清除其 modelCaps 缓存条目（换端点后不能沿用旧能力判定）
    const mcPrefix = `${id}/`
    for (const key of Object.keys(s.modelCaps)) {
      if (key.startsWith(mcPrefix)) delete s.modelCaps[key]
    }
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { ok: true, currentId: s.currentId, revision: s.revision })
  },
  })

  // 测试连接（探测能力）——只发无意义 prompt，绝不含书稿内容
  // 获取模型列表（新建传 protocol+baseUrl+apiKey；编辑传 id 用已存储凭据）
  defineRoute('providers.models', {
    method: 'POST',
    path: '/api/providers/models',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const body = await readJson(req)
    let protocol: Protocol
    let baseUrl: string
    let apiKey: string
    let auth: AuthStrategy
    if (typeof body['id'] === 'string' && body['id']) {
      const s = loadProviders(ctx.userDataPath)
      const p = s.providers.find((x) => x.id === body['id'])
      if (!p) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
      protocol = p.protocol
      baseUrl = p.baseUrl
      apiKey = p.apiKey
      auth = p.auth
    } else {
      protocol = (typeof body['protocol'] === 'string' ? body['protocol'] : 'openai') as Protocol
      baseUrl = typeof body['baseUrl'] === 'string' ? body['baseUrl'] : ''
      // I6（dsh 口径）：手输 key 同过传输不变量——就地解释拒绝优于上游 opaque 401
      const typed = normalizeApiKey(typeof body['apiKey'] === 'string' ? body['apiKey'] : '')
      if (!typed.ok && typed.reason === 'illegalCharacters') {
        return replyError(res, 400, 'BAD_INPUT', apiKeyRefusal('illegalCharacters'))
      }
      apiKey = typed.ok ? typed.value : ''
      auth = (typeof body['auth'] === 'string' ? body['auth'] : protocol === 'anthropic' ? 'anthropic' : 'bearer') as AuthStrategy
    }
    if (!baseUrl || !apiKey) return replyError(res, 400, 'BAD_INPUT', 'API 地址和 Key 必填')
    try {
      const models = await listModels(protocol, baseUrl, apiKey, auth)
      reply(res, 200, { models })
    } catch (e) {
      // P2-4：错误脱敏
      replyError(res, 500, 'GEN_FAIL', `获取模型列表失败：${redactSecret(e instanceof Error ? e.message : String(e))}`)
    }
  },
  })

  defineRoute('providers.test', {
    method: 'POST',
    path: '/api/providers/:id/test',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const id = params['id'] ?? ''

    try {
      // 前端可指定测试模型；未指定则用全局当前模型；都无则回落 conf.model（废弃旧值）
      //（dd-P2：body 先读；探测是 10s+ 网络往返，load 克隆不能跨它存活——探测后重载再写）
      let body: Record<string, unknown> = {}
      try { body = await readJson(req) } catch (e) {
        if (e instanceof HttpError) throw e // 413 等透传，只容错无 body/坏 JSON
      }
      const snapshot = loadProviders(ctx.userDataPath)
      const conf = snapshot.providers.find((p) => p.id === id)
      if (!conf) return replyError(res, 404, 'NOT_FOUND', '供应商不存在')
      const probeModel = typeof body['model'] === 'string' && body['model']
        ? body['model'] : (snapshot.currentModel ?? conf.model)
      const { caps, details } = await probeCapabilities({ ...conf, model: probeModel })
      // 写回探测结果——重载 + 重找（探测期间 provider 可能被编辑/删除；丢了不硬写旧克隆）
      const s2 = loadProviders(ctx.userDataPath)
      const target = s2.providers.find((p) => p.id === id)
      if (target) {
        target.caps = caps
        target.capsProbedAt = Date.now()
        saveProviders(ctx.userDataPath, s2)
      }
      // 探测写回会 bump revision——回传新 revision，前端 test() 同步，
      // 否则测试后任意写（新增/编辑/档位）都会因 expectedRevision 陈旧 409（P4 竞态）
      reply(res, 200, { ok: true, caps, details, revision: s2.revision })
    } catch (e) {
      // P2-4：错误脱敏（探测是 AI 网络往返 → GEN_FAIL，与 /models 端点同族）
      replyError(res, 500, 'GEN_FAIL', redactSecret(e instanceof Error ? e.message : String(e)))
    }
  },
  })
}

/** 下一可用排序号：max(现有)+1（dd-P3，防删除中间项后 length 撞号） */
function nextSortIndex(existing: Array<number | undefined>): number {
  let max = -1
  for (const x of existing) max = Math.max(max, x ?? 0)
  return max + 1
}

/** key 遮蔽 + 凭据状态点——真实 key 从不回传前端（编辑不改 key 就传回空 = 保留）；
 * hasKey 以 vault 条目存在性推导（I6·P3 口径）：状态不依赖内存明文，半迁移收敛后必然一致 */
function maskProvider(conf: ProviderConf, vault: Vault | null): ProviderConf & { apiKeyMasked: string; hasKey: boolean } {
  return {
    ...conf,
    apiKey: '', // 不回传原始 key（前端编辑时如不改 key 则传回空=保留原 key）
    apiKeyMasked: maskKey(conf.apiKey),
    hasKey: vault?.keys[conf.id] != null,
  }
}

/** P4：DELETE 无 body 场景的 best-effort 读取（同 POST /providers/:id/test 容错口径） */
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
 *  P9 §7.1：models 行——id 必填且供应商内唯一（trim 后）；contextWindow / maxTokens 若有须为正整数。
 *  models 缺省（undefined）= 不改模型行（编辑保留原值 / 新增不设）；传 [] = 清空。
 */
function parseProviderInput(
  body: Record<string, unknown>,
):
  | { ok: true; name: string; protocol: Protocol; auth: AuthStrategy; baseUrl: string; apiKey: string; models?: ModelConf[] }
  | { ok: false; error: string } {
  const name = String(body['name'] ?? '').trim()
  if (!name) return { ok: false, error: 'name 必填' }
  const protocolRaw = String(body['protocol'] ?? '')
  // Responses 启用批（2026-08-17）：openai-responses 恢复放行，三选一校验（曾随 Z-P2-1 误判拒配）
  const protocol = protocolRaw as Protocol
  if (protocol !== 'anthropic' && protocol !== 'openai' && protocol !== 'openai-responses') {
    return { ok: false, error: 'protocol 需为 anthropic / openai / openai-responses' }
  }
  // auth 从 body 读（UI 无该控件，兼容手改 providers.json 的旧数据）；缺省回落协议推断
  const authRaw = String(body['auth'] ?? '')
  const auth: AuthStrategy =
    authRaw === 'anthropic' || authRaw === 'claudeAuth' || authRaw === 'bearer'
      ? authRaw
      : protocol === 'anthropic' ? 'anthropic' : 'bearer'
  const baseUrl = String(body['baseUrl'] ?? '').trim()
  if (!baseUrl) return { ok: false, error: 'baseUrl 必填' }
  // dd-P3：scheme 校验（与 rag-providers 同口径）——防任意串当 URL 使 listModels/probe 打错目标
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'baseUrl 须以 http(s):// 开头' }
  // I6（dsh 口径）：已提交的 key 过传输不变量单点；留空是配置态（新增必填/编辑保留），由调用方按语义处理
  const keyChecked = normalizeApiKey(String(body['apiKey'] ?? ''))
  if (!keyChecked.ok && keyChecked.reason === 'illegalCharacters') {
    return { ok: false, error: apiKeyRefusal('illegalCharacters') }
  }
  const apiKey = keyChecked.ok ? keyChecked.value : ''
  const models = parseModels(body['models'])
  if (models === 'invalid') return { ok: false, error: 'models 行不合法：id 必填且供应商内唯一，容量须为正整数' }
  return { ok: true, name, protocol, auth, baseUrl, apiKey, models: models === undefined ? undefined : models }
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
      if (typeof row['contextWindow'] !== 'number' || !Number.isInteger(row['contextWindow']) || row['contextWindow'] <= 0) {
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
