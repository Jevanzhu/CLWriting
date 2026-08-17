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
import { route } from '../router.js'
import { readJson, reply, HttpError } from '../http.js'
import {
  loadProviders,
  saveProviders,
  newProviderId,
  maskKey,
  probeCapabilities,
  setCurrentModel,
  type ProviderConf,
  type Protocol,
  type AuthStrategy,
  type TierSlot,
  type EffortLevel,
} from '../../../ai/provider/index.js'
import { listModels } from '../../../ai/provider/models.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏

interface ProvidersCtx {
  userDataPath: string | null
}

export function registerProvidersRoutes(ctx: ProvidersCtx): void {
  // 列表（key 遮蔽）
  route('GET', '/api/providers', (_req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const s = loadProviders(ctx.userDataPath)
    reply(res, 200, {
      providers: s.providers.map(maskProvider).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)),
      currentId: s.currentId,
      currentModel: s.currentModel,
      tiers: s.tiers,
    })
  })

  // 新增
  route('POST', '/api/providers', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    const parsed = parseProviderInput(body)
    if (!parsed.ok) return reply(res, 400, { error: parsed.error })
    // D10：新增时 apiKey 必填（编辑时留空 = 保留原 key）
    if (!parsed.apiKey) return reply(res, 400, { error: 'apiKey 必填' })

    const s = loadProviders(ctx.userDataPath)
    const conf: ProviderConf = {
      id: newProviderId(),
      name: parsed.name,
      protocol: parsed.protocol,
      auth: parsed.auth,
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      caps: null,
      // dd-P3：max+1 防撞号——s.providers.length 在删过中间项后与存量 sortIndex 重复，排序不稳
      sortIndex: nextSortIndex(s.providers.map((p) => p.sortIndex)),
    }
    s.providers.push(conf)
    // 首个供应商自动设为当前
    if (!s.currentId) s.currentId = conf.id
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { provider: maskProvider(conf) })
  })

  // 设为当前启用（必须先于 /:id 注册——router 按注册顺序匹配，被 :id 遮蔽则 current 永不命中，P0-1）
  route('PUT', '/api/providers/current', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    const id = String(body['id'] ?? '')
    const s = loadProviders(ctx.userDataPath)
    const target = id ? s.providers.find((p) => p.id === id) : undefined
    if (id && !target) {
      return reply(res, 404, { error: '供应商不存在' })
    }
    // P2-6：未探测不许启用——服务端校验 caps（前端守卫可绕过）
    if (target && !target.caps) {
      return reply(res, 400, { error: `供应商「${target.name}」尚未测试连接，请先探测能力` })
    }
    s.currentId = id || null
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { ok: true, currentId: s.currentId })
  })

  // 全局当前模型（方案 A：model 独立于供应商，工作台选择）
  // 表驱动重构（§6.3）：模型能力不再探测——静态表判定；响应携带降级记忆（structured 支持）
  route('PUT', '/api/ai-model', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    const model = String(body['model'] ?? '').trim()
    if (!model) return reply(res, 400, { error: 'model 必填' })
    setCurrentModel(ctx.userDataPath, model)

    // 降级记忆（structured 已确认不支持时存在）
    const s = loadProviders(ctx.userDataPath)
    const conf = s.providers.find((p) => p.id === s.currentId)
    const degraded = conf ? s.modelCaps[`${conf.id}/${model}`] ?? null : null
    reply(res, 200, { ok: true, model, modelCaps: degraded, details: undefined })
  })

  // D 档：任务档位配置（创作档/助手档）——模型 + 推理深度 + 单次输出上限
  route('PUT', '/api/tiers', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    const creativeRaw = body['creative']
    if (typeof creativeRaw !== 'object' || creativeRaw === null) {
      return reply(res, 400, { error: 'creative 档位必填' })
    }
    const creative = parseTierSlot(creativeRaw as Record<string, unknown>)
    if (!creative.ok) return reply(res, 400, { error: creative.error })

    let assistant: TierSlot | null = null
    const assistantRaw = body['assistant']
    if (assistantRaw !== null && assistantRaw !== undefined) {
      if (typeof assistantRaw !== 'object') {
        return reply(res, 400, { error: 'assistant 档位需为对象或 null' })
      }
      const a = parseTierSlot(assistantRaw as Record<string, unknown>)
      if (!a.ok) return reply(res, 400, { error: a.error })
      assistant = a.slot
    }

    const s = loadProviders(ctx.userDataPath)
    s.tiers = { creative: creative.slot, assistant, chat: s.tiers.chat }
    // 同步 currentModel（兼容 resolveTier 回落逻辑）
    s.currentModel = creative.slot.model || null
    saveProviders(ctx.userDataPath, s)

    // 表驱动重构（§6.3）：不再触发模型级探测——能力由静态表判定
    reply(res, 200, { ok: true, tiers: s.tiers, details: {} })
  })

  // chat 单档端点——对话框内随手换模型，不碰 creative/assistant/currentModel
  // caps 探测改异步不阻塞（结果经后续 GET /providers 刷新）
  route('PUT', '/api/tiers/chat', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)

    // null = 清除 chat 档（回落 creative）
    if (body === null || body === undefined) {
      const s = loadProviders(ctx.userDataPath)
      s.tiers = { ...s.tiers, chat: null }
      saveProviders(ctx.userDataPath, s)
      return reply(res, 200, { ok: true, tiers: s.tiers })
    }

    const parsed = parseTierSlot(body as Record<string, unknown>)
    if (!parsed.ok) return reply(res, 400, { error: parsed.error })

    const s = loadProviders(ctx.userDataPath)
    s.tiers = { ...s.tiers, chat: parsed.slot }
    saveProviders(ctx.userDataPath, s)

    // 表驱动重构（§6.3）：不再异步探测 caps——能力由静态表判定
    reply(res, 200, { ok: true, tiers: s.tiers })
  })

  // 编辑
  route('PUT', '/api/providers/:id', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const id = params['id'] ?? ''
    // dd-P2：读 body 先于 loadProviders——load→mutate→save 三段必须同步无 await
    //（单事件循环内原子），此前 load 与 save 间隔着 await readJson，并发编辑丢更新
    const body = await readJson(req)
    const s = loadProviders(ctx.userDataPath)
    const idx = s.providers.findIndex((p) => p.id === id)
    if (idx < 0) return reply(res, 404, { error: '供应商不存在' })

    const parsed = parseProviderInput(body)
    if (!parsed.ok) return reply(res, 400, { error: parsed.error })

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
    reply(res, 200, { provider: maskProvider(s.providers[idx]!) })
  })

  // 删除
  route('DELETE', '/api/providers/:id', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const id = params['id'] ?? ''
    const s = loadProviders(ctx.userDataPath)
    const idx = s.providers.findIndex((p) => p.id === id)
    if (idx < 0) return reply(res, 404, { error: '供应商不存在' })
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
    reply(res, 200, { ok: true, currentId: s.currentId })
  })

  // 测试连接（探测能力）——只发无意义 prompt，绝不含书稿内容
  // 获取模型列表（新建传 protocol+baseUrl+apiKey；编辑传 id 用已存储凭据）
  route('POST', '/api/providers/models', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    let protocol: Protocol
    let baseUrl: string
    let apiKey: string
    let auth: AuthStrategy
    if (typeof body['id'] === 'string' && body['id']) {
      const s = loadProviders(ctx.userDataPath)
      const p = s.providers.find((x) => x.id === body['id'])
      if (!p) return reply(res, 404, { error: '供应商不存在' })
      protocol = p.protocol
      baseUrl = p.baseUrl
      apiKey = p.apiKey
      auth = p.auth
    } else {
      protocol = (typeof body['protocol'] === 'string' ? body['protocol'] : 'openai') as Protocol
      baseUrl = typeof body['baseUrl'] === 'string' ? body['baseUrl'] : ''
      apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'] : ''
      auth = (typeof body['auth'] === 'string' ? body['auth'] : protocol === 'anthropic' ? 'anthropic' : 'bearer') as AuthStrategy
    }
    if (!baseUrl || !apiKey) return reply(res, 400, { error: 'API 地址和 Key 必填' })
    try {
      const models = await listModels(protocol, baseUrl, apiKey, auth)
      reply(res, 200, { models })
    } catch (e) {
      // P2-4：错误脱敏
      reply(res, 500, { error: `获取模型列表失败：${redactSecret(e instanceof Error ? e.message : String(e))}` })
    }
  })

  route('POST', '/api/providers/:id/test', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
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
      if (!conf) return reply(res, 404, { error: '供应商不存在' })
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
      reply(res, 200, { ok: true, caps, details })
    } catch (e) {
      // P2-4：错误脱敏
      reply(res, 500, { error: redactSecret(e instanceof Error ? e.message : String(e)) })
    }
  })
}

/** 下一可用排序号：max(现有)+1（dd-P3，防删除中间项后 length 撞号） */
function nextSortIndex(existing: Array<number | undefined>): number {
  let max = -1
  for (const x of existing) max = Math.max(max, x ?? 0)
  return max + 1
}

/** API 返回前遮蔽 apiKey */
function maskProvider(conf: ProviderConf): ProviderConf & { apiKeyMasked: string } {
  return {
    ...conf,
    apiKey: '', // 不回传原始 key（前端编辑时如不改 key 则传回空=保留原 key）
    apiKeyMasked: maskKey(conf.apiKey),
  }
}

/** 解析供应商输入（增/改共用） */
function parseProviderInput(
  body: Record<string, unknown>,
):
  | { ok: true; name: string; protocol: Protocol; auth: AuthStrategy; baseUrl: string; apiKey: string }
  | { ok: false; error: string } {
  const name = String(body['name'] ?? '').trim()
  if (!name) return { ok: false, error: 'name 必填' }
  const protocolRaw = String(body['protocol'] ?? '')
  // Z-P2-1 拍板（2026-08-16）：openai-responses 协议后端拒配——UI 已无入口、适配器存在
  // failed 伪装成功与 store:true 默认留存缺口；gpt-5 系列经 openai（Chat Completions）可用。
  // 存量 conf 在 createProvider 处给迁移报错（registry 已摘除该条目）。
  if (protocolRaw === 'openai-responses') {
    return { ok: false, error: 'openai-responses 协议已停用，请改用 openai 协议' }
  }
  const protocol = protocolRaw as Protocol
  if (protocol !== 'anthropic' && protocol !== 'openai') {
    return { ok: false, error: 'protocol 需为 anthropic / openai' }
  }
  // auth 从 body 读（UI 已暴露 3 种认证方式）；缺省回落协议推断（兼容旧配置）
  const authRaw = String(body['auth'] ?? '')
  const auth: AuthStrategy =
    authRaw === 'anthropic' || authRaw === 'claudeAuth' || authRaw === 'bearer'
      ? authRaw
      : protocol === 'anthropic' ? 'anthropic' : 'bearer'
  const baseUrl = String(body['baseUrl'] ?? '').trim()
  if (!baseUrl) return { ok: false, error: 'baseUrl 必填' }
  // dd-P3：scheme 校验（与 rag-providers 同口径）——防任意串当 URL 使 listModels/probe 打错目标
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'baseUrl 须以 http(s):// 开头' }
  const apiKey = String(body['apiKey'] ?? '').trim()
  return { ok: true, name, protocol, auth, baseUrl, apiKey }
}

/** 解析档位槽输入（模型 + 推理等级） */
function parseTierSlot(raw: Record<string, unknown>): { ok: true; slot: TierSlot } | { ok: false; error: string } {
  const model = String(raw['model'] ?? '').trim()
  if (!model) return { ok: false, error: 'model 必填' }
  const effort = String(raw['effort'] ?? 'xhigh')
  const VALID = ['low', 'medium', 'high', 'xhigh', 'max']
  if (!VALID.includes(effort)) {
    return { ok: false, error: `effort 需为 ${VALID.join('/')}` }
  }
  return { ok: true, slot: { model, effort: effort as EffortLevel } }
}
