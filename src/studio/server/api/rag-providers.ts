/**
 * RAG（嵌入）提供方管理端点——应用级多提供方，书按 book.yaml rag.provider 引用。
 *
 * GET    /api/rag-providers        → 列表（key 遮蔽）
 * POST   /api/rag-providers        → 新增
 * PUT    /api/rag-providers/:id    → 编辑（apiKey 留空 = 保留原 key；endpoint/model 变更清 caps）
 * DELETE /api/rag-providers/:id    → 删除（引用它的书此后解析为「未配置」，不阻断）
 * POST   /api/rag-providers/:id/test → 测试连接（真实 embed 一次 'ping'）
 *
 * 落 userDataPath/providers.json 的 ragProviders 段（key 走 vault 加密，同 chat 提供方）。
 * 与 /api/providers 分开一组路由：无「设为当前」概念（选用权在书），无档位/协议维度。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, HttpError, replyError } from '../http.js'
import { revisionError } from './revision-guard.js' // X-25：三处拷贝收敛单源（原 P4 本地实现）
import {
  loadProviders,
  saveProviders,
  newRagProviderId,
  maskKey,
  normalizeApiKey,
  apiKeyRefusal,
  type RagProviderConf,
} from '../../../ai/provider/index.js'
import type { Vault } from '../../../ai/provider/vault.js'
import { embed } from '../../../rag/embed.js'

interface RagProvidersCtx {
  userDataPath: string | null
}

/** key 遮蔽 + 凭据状态点——真实 key 从不回传前端（编辑不改 key 就传回空 = 保留）；
 * hasKey 以 vault 条目存在性推导（I6·P3 口径，与 /api/providers maskProvider 同则） */
function maskRagProvider(conf: RagProviderConf, vault: Vault | null) {
  return { ...conf, apiKey: '', apiKeyMasked: maskKey(conf.apiKey), hasKey: vault?.keys[conf.id] != null }
}

function parseRagInput(
  body: Record<string, unknown>,
): { ok: true; name: string; endpoint: string; model: string; apiKey: string } | { ok: false; error: string } {
  const name = String(body['name'] ?? '').trim()
  const endpoint = String(body['endpoint'] ?? '').trim()
  const model = String(body['model'] ?? '').trim()
  // I6（dsh 口径）：已提交的 key 过传输不变量单点；留空是配置态（新增必填/编辑保留）
  const keyChecked = normalizeApiKey(String(body['apiKey'] ?? ''))
  if (!keyChecked.ok && keyChecked.reason === 'illegalCharacters') {
    return { ok: false, error: apiKeyRefusal('illegalCharacters') }
  }
  const apiKey = keyChecked.ok ? keyChecked.value : ''
  if (!name) return { ok: false, error: '名称必填' }
  if (!endpoint) return { ok: false, error: '嵌入服务地址必填' }
  if (!/^https?:\/\//i.test(endpoint)) return { ok: false, error: '嵌入服务地址须以 http(s):// 开头' }
  if (!model) return { ok: false, error: '嵌入模型必填' }
  return { ok: true, name, endpoint, model, apiKey }
}

export function registerRagProviderRoutes(ctx: RagProvidersCtx): void {
  // 列表（key 遮蔽；顺带回 revision 供前端并发守卫）
  defineRoute('rag-providers.get', {
    method: 'GET',
    path: '/api/rag-providers',
    handler: (_, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const s = loadProviders(ctx.userDataPath)
    reply(res, 200, {
      ragProviders: s.ragProviders.map((p) => maskRagProvider(p, s.vault)).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)),
      revision: s.revision,
    })
  },
  })

  // 新增（apiKey 必填——编辑才允许留空保留）
  defineRoute('rag-providers.post', {
    method: 'POST',
    path: '/api/rag-providers',
    handler: async (_, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const body = await readJson(req)
    const parsed = parseRagInput(body)
    if (!parsed.ok) return replyError(res, 400, 'BAD_INPUT', parsed.error)
    if (!parsed.apiKey) return replyError(res, 400, 'BAD_INPUT', 'apiKey 必填')

    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const conf: RagProviderConf = {
      id: newRagProviderId(),
      name: parsed.name,
      endpoint: parsed.endpoint,
      model: parsed.model,
      apiKey: parsed.apiKey,
      caps: null,
      // dd-P3：max+1 防撞号（同 chat providers 口径）
      sortIndex: s.ragProviders.reduce((m, p) => Math.max(m, p.sortIndex ?? 0), -1) + 1,
    }
    s.ragProviders.push(conf)
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { provider: maskRagProvider(conf, s.vault), revision: s.revision })
  },
  })

  // 编辑：apiKey 留空 = 保留原 key；endpoint/model 变更 → caps 清空要求重测（同 chat 提供方语义）
  defineRoute('rag-providers.put', {
    method: 'PUT',
    path: '/api/rag-providers/:id',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    // dd-P2：body 先读——load→mutate→save 三段同步无 await（单事件循环内原子），防并发丢更新
    const body = await readJson(req)
    const parsed = parseRagInput(body)
    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(body['expectedRevision'], s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const target = s.ragProviders.find((p) => p.id === params['id'])
    if (!target) return replyError(res, 404, 'NOT_FOUND', 'RAG 提供方不存在')
    if (!parsed.ok) return replyError(res, 400, 'BAD_INPUT', parsed.error)

    const endpointChanged = parsed.endpoint !== target.endpoint
    const modelChanged = parsed.model !== target.model
    target.name = parsed.name
    target.endpoint = parsed.endpoint
    target.model = parsed.model
    if (parsed.apiKey) target.apiKey = parsed.apiKey
    if (endpointChanged || modelChanged) {
      target.caps = null
      target.capsProbedAt = undefined
    }
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { provider: maskRagProvider(target, s.vault), revision: s.revision })
  },
  })

  // 删除：不级联改书——引用它的书解析为「未配置」（UI 显示提供方不存在），无静默换端点
  defineRoute('rag-providers.delete', {
    method: 'DELETE',
    path: '/api/rag-providers/:id',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    // P4：DELETE 无 body 常规场景容错（旧客户端/脚本放行）
    let expected: unknown
    try {
      const body = await readJson(req)
      expected = body['expectedRevision']
    } catch (e) {
      if (e instanceof HttpError) throw e
      expected = undefined
    }
    const s = loadProviders(ctx.userDataPath)
    const revErr = revisionError(expected, s.revision)
    if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
    const idx = s.ragProviders.findIndex((p) => p.id === params['id'])
    if (idx === -1) return replyError(res, 404, 'NOT_FOUND', 'RAG 提供方不存在')
    s.ragProviders.splice(idx, 1)
    saveProviders(ctx.userDataPath, s)
    reply(res, 200, { ok: true, revision: s.revision })
  },
  })

  // 测试连接：真实 embed 一次 'ping'（15s）——embed 失败返回 null 不带原因，
  // connected=false 时只能给笼统提示（网络/鉴权/模型名三选一，前端文案照此引导）
  defineRoute('rag-providers.test', {
    method: 'POST',
    path: '/api/rag-providers/:id/test',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到应用数据目录')
    const snapshot = loadProviders(ctx.userDataPath)
    const target = snapshot.ragProviders.find((p) => p.id === params['id'])
    if (!target) return replyError(res, 404, 'NOT_FOUND', 'RAG 提供方不存在')

    const vectors = await embed(target.endpoint, target.model, target.apiKey, ['ping'], { timeoutMs: 15_000 })
    const connected = vectors !== null
    // dd-P2：embed 是 15s 网络往返——写回前重载重找，探测期间被编辑/删除则不硬写旧克隆
    const s2 = loadProviders(ctx.userDataPath)
    const fresh = s2.ragProviders.find((p) => p.id === params['id'])
    if (fresh) {
      fresh.caps = { connected }
      fresh.capsProbedAt = Date.now()
      saveProviders(ctx.userDataPath, s2)
    }
    reply(res, 200, {
      ok: connected,
      caps: { connected },
      ...(connected ? {} : { error: '嵌入端点调用失败：请检查地址 / API Key / 模型名' }),
    })
  },
  })
}
