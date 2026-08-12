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
import { readJson, reply } from '../http.js'
import {
  loadProviders,
  saveProviders,
  newProviderId,
  maskKey,
  probeCapabilities,
  probeModelCaps,
  setCurrentModel,
  getModelCaps,
  setModelCaps,
  type ProviderConf,
  type Protocol,
  type AuthStrategy,
  type TierSlot,
  type EffortLevel,
  PRESETS,
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

  // 厂商速填预设（PRESETS 唯一数据源，前端面板消费）
  route('GET', '/api/providers/presets', (_req: IncomingMessage, res: ServerResponse) => {
    reply(res, 200, { presets: PRESETS })
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
      sortIndex: s.providers.length,
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
  // 选模型时触发模型级 caps 探测（tool_use / tool_choice），按 providerId+model 缓存
  route('PUT', '/api/ai-model', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    const model = String(body['model'] ?? '').trim()
    if (!model) return reply(res, 400, { error: 'model 必填' })
    setCurrentModel(ctx.userDataPath, model)

    // 模型级 caps：查缓存，未命中则探测
    const s = loadProviders(ctx.userDataPath)
    const conf = s.providers.find((p) => p.id === s.currentId)
    if (!conf) {
      reply(res, 200, { ok: true, model })
      return
    }
    let caps = getModelCaps(ctx.userDataPath, conf.id, model)
    let details: string[] | undefined
    if (!caps) {
      try {
        const probed = await probeModelCaps({ ...conf, model })
        caps = probed.caps
        details = probed.details
        setModelCaps(ctx.userDataPath, conf.id, model, caps)
      } catch (e) {
        // 探测失败不阻塞选模型——生成时降级（modelCaps=null）；P2-4：错误脱敏
        details = [`模型能力探测失败：${redactSecret(e instanceof Error ? e.message : String(e))}`]
      }
    }
    reply(res, 200, { ok: true, model, modelCaps: caps, details })
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

    // 选模型时触发模型级 caps 探测（tool_use / tool_choice），按 providerId+model 缓存
    const conf = s.providers.find((p) => p.id === s.currentId)
    const probeDetails: Record<string, string[]> = {}
    if (conf) {
      const models = [creative.slot.model, assistant?.model].filter((m): m is string => !!m)
      for (const model of models) {
        if (!getModelCaps(ctx.userDataPath, conf.id, model)) {
          try {
            const probed = await probeModelCaps({ ...conf, model })
            setModelCaps(ctx.userDataPath, conf.id, model, probed.caps)
          } catch (e) {
            // P2-4：错误脱敏
            probeDetails[model] = [`模型能力探测失败：${redactSecret(e instanceof Error ? e.message : String(e))}`]
          }
        }
      }
    }
    reply(res, 200, { ok: true, tiers: s.tiers, details: probeDetails })
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

    // 异步探测 caps（不阻塞响应）
    const conf = s.providers.find((p) => p.id === s.currentId)
    if (conf && !getModelCaps(ctx.userDataPath, conf.id, parsed.slot.model)) {
      probeModelCaps({ ...conf, model: parsed.slot.model })
        .then((probed) => setModelCaps(ctx.userDataPath!, conf.id, parsed.slot.model, probed.caps))
        .catch(() => { /* 探测失败不阻塞，后续 GET /providers 刷新 */ })
    }

    reply(res, 200, { ok: true, tiers: s.tiers })
  })

  // 编辑
  route('PUT', '/api/providers/:id', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const id = params['id'] ?? ''
    const s = loadProviders(ctx.userDataPath)
    const idx = s.providers.findIndex((p) => p.id === id)
    if (idx < 0) return reply(res, 404, { error: '供应商不存在' })

    const body = await readJson(req)
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
    if (typeof body['id'] === 'string' && body['id']) {
      const s = loadProviders(ctx.userDataPath)
      const p = s.providers.find((x) => x.id === body['id'])
      if (!p) return reply(res, 404, { error: '供应商不存在' })
      protocol = p.protocol
      baseUrl = p.baseUrl
      apiKey = p.apiKey
    } else {
      protocol = (typeof body['protocol'] === 'string' ? body['protocol'] : 'openai') as Protocol
      baseUrl = typeof body['baseUrl'] === 'string' ? body['baseUrl'] : ''
      apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'] : ''
    }
    if (!baseUrl || !apiKey) return reply(res, 400, { error: 'API 地址和 Key 必填' })
    try {
      const models = await listModels(protocol, baseUrl, apiKey)
      reply(res, 200, { models })
    } catch (e) {
      // P2-4：错误脱敏
      reply(res, 500, { error: `获取模型列表失败：${redactSecret(e instanceof Error ? e.message : String(e))}` })
    }
  })

  route('POST', '/api/providers/:id/test', async (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const id = params['id'] ?? ''
    const s = loadProviders(ctx.userDataPath)
    const conf = s.providers.find((p) => p.id === id)
    if (!conf) return reply(res, 404, { error: '供应商不存在' })

    try {
      const { caps, details } = await probeCapabilities(conf)
      // 写回探测结果
      conf.caps = caps
      conf.capsProbedAt = Date.now()
      saveProviders(ctx.userDataPath, s)
      reply(res, 200, { ok: true, caps, details })
    } catch (e) {
      // P2-4：错误脱敏
      reply(res, 500, { ok: false, error: redactSecret(e instanceof Error ? e.message : String(e)) })
    }
  })
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
  const protocol = String(body['protocol'] ?? '') as Protocol
  if (protocol !== 'anthropic' && protocol !== 'openai' && protocol !== 'openai-responses') {
    return { ok: false, error: 'protocol 需为 anthropic / openai / openai-responses' }
  }
  // auth 从 body 读（UI 已暴露 3 种认证方式）；缺省回落协议推断（兼容旧配置）
  const authRaw = String(body['auth'] ?? '')
  const auth: AuthStrategy =
    authRaw === 'anthropic' || authRaw === 'claudeAuth' || authRaw === 'bearer'
      ? authRaw
      : protocol === 'anthropic' ? 'anthropic' : 'bearer'
  const baseUrl = String(body['baseUrl'] ?? '').trim()
  if (!baseUrl) return { ok: false, error: 'baseUrl 必填' }
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
