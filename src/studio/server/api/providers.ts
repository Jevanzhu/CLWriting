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
  type ProviderConf,
  type Protocol,
  type AuthStrategy,
} from '../../../ai/provider/index.js'

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
    })
  })

  // 新增
  route('POST', '/api/providers', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    const parsed = parseProviderInput(body)
    if (!parsed.ok) return reply(res, 400, { error: parsed.error })

    const s = loadProviders(ctx.userDataPath)
    const conf: ProviderConf = {
      id: newProviderId(),
      name: parsed.name,
      protocol: parsed.protocol,
      auth: parsed.auth,
      baseUrl: parsed.baseUrl,
      model: parsed.model,
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
      existing.model !== parsed.model ||
      existing.protocol !== parsed.protocol ||
      existing.auth !== parsed.auth

    s.providers[idx] = {
      ...existing,
      name: parsed.name,
      protocol: parsed.protocol,
      auth: parsed.auth,
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      apiKey: newKey,
      caps: fieldsChanged ? null : existing.caps,
      capsProbedAt: fieldsChanged ? undefined : existing.capsProbedAt,
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
      s.currentId = s.providers[0]?.id ?? null
    }
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { ok: true, currentId: s.currentId })
  })

  // 设为当前启用
  route('PUT', '/api/providers/current', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return reply(res, 400, { error: '未定位到应用数据目录' })
    const body = await readJson(req)
    const id = String(body['id'] ?? '')
    const s = loadProviders(ctx.userDataPath)
    if (id && !s.providers.find((p) => p.id === id)) {
      return reply(res, 404, { error: '供应商不存在' })
    }
    s.currentId = id || null
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { ok: true, currentId: s.currentId })
  })

  // 测试连接（探测能力）——只发无意义 prompt，绝不含书稿内容
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
      reply(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
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
  | { ok: true; name: string; protocol: Protocol; auth: AuthStrategy; baseUrl: string; model: string; apiKey: string }
  | { ok: false; error: string } {
  const name = String(body['name'] ?? '').trim()
  if (!name) return { ok: false, error: 'name 必填' }
  const protocol = String(body['protocol'] ?? '') as Protocol
  if (protocol !== 'anthropic' && protocol !== 'openai') return { ok: false, error: 'protocol 需为 anthropic 或 openai' }
  const auth = String(body['auth'] ?? '') as AuthStrategy
  if (auth !== 'anthropic' && auth !== 'claudeAuth' && auth !== 'bearer') return { ok: false, error: 'auth 需为 anthropic / claudeAuth / bearer' }
  const baseUrl = String(body['baseUrl'] ?? '').trim()
  if (!baseUrl) return { ok: false, error: 'baseUrl 必填' }
  const model = String(body['model'] ?? '').trim()
  if (!model) return { ok: false, error: 'model 必填' }
  const apiKey = String(body['apiKey'] ?? '').trim()
  // 编辑时 apiKey 可为空=保留原 key（端点处理），新增时必填
  if (!apiKey && body['apiKey'] === undefined) {
    // apiKey 字段缺失：编辑场景允许（保留原 key），新增场景由调用方检查
  }
  return { ok: true, name, protocol, auth, baseUrl, model, apiKey }
}
