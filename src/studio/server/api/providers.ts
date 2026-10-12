/**
 * AI 服务供应商管理端点（路由声明面）。
 *
 * GET  /api/providers                         → 列表（key 遮蔽）
 * POST /api/providers                         → 新增供应商 → {provider}(key 遮蔽)
 * PUT  /api/providers/:id                     → 编辑供应商
 * DELETE /api/providers/:id                   → 删除供应商
 * PUT  /api/providers/current                  body {id}    → 设为当前启用
 * POST /api/providers/:id/test                → 测试连接（探测能力）→ {caps, details}
 *
 * 供应商配置落 userDataPath/providers.json（应用级，跨书共享，不进 git）。
 * 编排体（load→revision 校验→mutate→save→reply 与各端点的 body 解析器）下沉
 * providers-ops.ts：本文件只留 method/path 声明、gate/parse/bodyLimit 位与一行转调。
 * 例外一档——pricing 的 parse 体留在本文件：其类型标注含 `import('.../provider/types.js')`
 * 表达式，是 import 环守护门的动态边冻结清单在册项（改由落点档承载即须同步改写该清单）；
 * 留在本文件即动态边原位不动，门与清单零改动。
 * 依赖方向：本文件 → defineRoute + 转调 providers-ops.ts（其 handler/parse 体）；ops 档对
 * 本文件只有 type 面回引 ProvidersCtx（编译期擦除），模块图无环。
 */
import { defineRoute } from './schema.js'
import type { DriverHost } from '../driver-port.js' // driver 经组装根注入（mock 快路选择结果）
import type { ProviderConf, ProbeResult } from '../../../ai/provider/index.js'
import {
  handleProviderCreate,
  handleProviderDelete,
  handleProviderPricing,
  handleProviderTest,
  handleProviderUpdate,
  handleProvidersCurrent,
  handleProvidersList,
  handleProvidersModels,
  handleTiersChatPut,
  handleTiersPut,
  parseProviderCreateInput,
  parseProviderUpdateInput,
  parseProvidersCurrentInput,
  parseProvidersModelsInput,
  parseTiersChatInput,
  parseTiersInput,
} from './providers-ops.js'

export interface ProvidersCtx {
  userDataPath: string | null
  /** driver 宿主（mock 选择结果）——组装根注入。「测试连接 / 拉模型列表」的 mock 快路
   *  只读 ctx.driver.kind，不读环境变量。 */
  driver: DriverHost
  /** 收尾：探测函数覆盖档（见下方块注） */
  probeCapabilities?: ((conf: ProviderConf, userDataPath?: string | null, mock?: boolean) => Promise<ProbeResult>) | null
}

// 探测函数替换口（默认真探测）——回归测试注入受控延迟/结果的
// 探测函数，复现「探测 10s+ 窗口内配置被改」竞态（mock driver 的快路探测瞬时完成，
// 无法天然开出竞态窗）。仅测试用，勿在生产路径调用。
// 签名补第二参 userDataPath（探测目标库）——真探测透传给探测
// 实例做降级记忆路由；注入函数少参可赋（TS 逆变兼容，存量 mock 不受影响）
// 收尾：模块级 getProbeForTest / __setProbeCapabilitiesForTest 删除——
// 探测函数改组装根 RouteOverrides 注入（ProvidersCtx.probeCapabilities，随实例隔离，
// undefined = 真探测生产口径逐位不变；与 ProviderRuntime 端口同一组装根注入通道）。

// 保存点失败语义（500 WRITE_ERROR / 409 REVISION_CONFLICT 的择一）见 provider-save-guard.ts 头注。
// 返回 false = 已回错误响应，调用方直接 return 不再 reply 200。

export function registerProvidersRoutes(ctx: ProvidersCtx): void {
  // 列表（key 遮蔽）
  defineRoute('providers.get', {
    method: 'GET',
    path: '/api/providers',
    handler: (_, _req, res) => handleProvidersList(ctx, res),
  })

  // 新增（body 校验移入 parse，失败同 400 BAD_INPUT
  // 同文案，响应字节不变；handler 拿类型化 input）
  defineRoute('providers.post', {
    method: 'POST',
    path: '/api/providers',
    parse: (raw) => parseProviderCreateInput(raw),
    handler: (routeCtx, _req, res) => handleProviderCreate(ctx, routeCtx, res),
  })

  // 设为当前启用（必须先于 /:id 注册——router 按注册顺序匹配，被 :id 遮蔽则 current 永不命中）
  // body 读取/抽取移入 parse（本端点无形状校验，纯抽取零错误翻转）
  defineRoute('providers.current', {
    method: 'PUT',
    path: '/api/providers/current',
    parse: (raw) => parseProvidersCurrentInput(raw),
    handler: (routeCtx, _req, res) => handleProvidersCurrent(ctx, routeCtx, res),
  })

  // D 档：任务档位配置（创作档/助手档）——模型 + 推理深度 + 单次输出上限
  // creative/assistant 档位校验移入 parse（失败同 400 BAD_INPUT 同文案）
  defineRoute('tiers', {
    method: 'PUT',
    path: '/api/tiers',
    parse: (raw) => parseTiersInput(raw),
    handler: (routeCtx, _req, res) => handleTiersPut(ctx, routeCtx, res),
  })

  // chat 单档端点——对话框内随手换模型，不碰 creative/assistant/currentModel
  // caps 探测改异步不阻塞（结果经后续 GET /providers 刷新）
  // 清档/档位两分支判别与校验移入 parse（失败同 400 BAD_INPUT 同文案；
  // 两分支回复形状一致，handler 合并后仍逐字节同参 reply）
  defineRoute('tiers.chat', {
    method: 'PUT',
    path: '/api/tiers/chat',
    parse: (raw) => parseTiersChatInput(raw),
    handler: (routeCtx, _req, res) => handleTiersChatPut(ctx, routeCtx, res),
  })

  // 编辑（parseProviderInput 移入 parse——body 校验先于 409/404 前置门
  // 发生（defineRoute 先读 body 后进 handler），既有测试未钉旧优先级，校验文案逐字保留）
  defineRoute('providers.put', {
    method: 'PUT',
    path: '/api/providers/:id',
    parse: (raw) => parseProviderUpdateInput(raw),
    handler: (routeCtx, _req, res) => handleProviderUpdate(ctx, routeCtx, res),
  })

  // provider 级价格表——独立端点而非并入编辑主链路（价格不影响连通性，
  // 不该连带 caps 重置/重新探测；解析也独立：四档单价均为正数或省略，null = 清除）
  // pricing 解析留本文件（见文件头注：其类型标注的动态 import 边在环守护门冻结清单在册）；
  // 校验失败同 400 BAD_INPUT 同文案，先于 409/404 前置门发生——本端点无既有测试钉旧优先级
  defineRoute('providers.pricing', {
    method: 'PUT',
    path: '/api/providers/:id/pricing',
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const rawPricing = body['pricing']
      if (rawPricing === null || rawPricing === undefined) {
        return { expectedRevision: body['expectedRevision'], pricing: null }
      }
      if (typeof rawPricing !== 'object' || Array.isArray(rawPricing)) {
        throw new Error('pricing 需为对象或 null')
      }
      const p = rawPricing as Record<string, unknown>
      const pos = (v: unknown): number | undefined | 'bad' =>
        v === undefined || v === null || v === ''
          ? undefined
          : typeof v === 'number' && Number.isFinite(v) && v >= 0
            ? v
            : 'bad'
      const pricing: NonNullable<import('../../../ai/provider/types.js').ProviderConf['pricing']> = {}
      for (const key of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'] as const) {
        const v = pos(p[key])
        if (v === 'bad') throw new Error(`pricing.${key} 需为非负数字`)
        if (v !== undefined) pricing[key] = v
      }
      if (typeof p['currency'] === 'string' && p['currency'].trim()) pricing.currency = p['currency'].trim()
      if (Object.keys(pricing).length === 0) {
        throw new Error(
          'pricing 至少需要一个单价键（inputPerMTok/outputPerMTok/cacheReadPerMTok/cacheWritePerMTok，单位：每百万 token）',
        )
      }
      return { expectedRevision: body['expectedRevision'], pricing }
    },
    handler: (routeCtx, _req, res) => handleProviderPricing(ctx, routeCtx, res),
  })

  // 删除
  // defineRoute parse 迁移跳过：本端点 body 读取是容错语义（无 body
  // 放行；readJson 非 HttpError 失败兜底 undefined 继续），defineRoute 的 readJson 失败
  // 先于 parse 短路统一回 400——「按空 body 兜底继续」的既有语义在 parse 化后不可表达
  defineRoute('providers.delete', {
    method: 'DELETE',
    path: '/api/providers/:id',
    handler: (routeCtx, req, res) => handleProviderDelete(ctx, routeCtx, req, res),
  })

  // 测试连接（探测能力）——只发无意义 prompt，绝不含书稿内容
  // 获取模型列表（新建传 protocol+baseUrl+apiKey；编辑传 id 用已存储凭据）
  // 手输分支的形状抽取/校验移入 parse（id 分支不校验其余字段——沿用
  // 旧路径不误伤，凭据仍由 handler 从 store 取）；「必填」检查留在 handler（两分支
  // （手改 providers.json 形态）——两分支合流后判定，文案与旧序一致。
  // 手输分支的 protocol/auth/baseUrl 改由 parseConnectionInput 单源校验
  // ——此前 protocol/auth 只 as 断言、baseUrl 不校 scheme，非法值原样透给下方 listModels
  // （该端点恰是 scheme 校验注释点名的「打错目标」面）后以 500 GEN_FAIL 收场；现非法
  // protocol / 缺 scheme 就地 400 BAD_INPUT 且文案指明字段（与增/改端点同口径）。
  defineRoute('providers.models', {
    method: 'POST',
    path: '/api/providers/models',
    parse: (raw) => parseProvidersModelsInput(raw),
    handler: (routeCtx, _req, res) => handleProvidersModels(ctx, routeCtx, res),
  })

  // defineRoute parse 迁移跳过：本端点 body 读取是容错语义（无 body
  // readJson 非 HttpError 失败按空 body 兜底继续探测），defineRoute 的 readJson 失败先于
  // parse 短路统一回 400，容错路径不可表达，改之即变语义
  defineRoute('providers.test', {
    method: 'POST',
    path: '/api/providers/:id/test',
    handler: (routeCtx, req, res) => handleProviderTest(ctx, routeCtx, req, res),
  })
}
