/**
 * 书架 + 单书 + 建书 REST 端点（#12.3 + 5.1）。
 *
 * - GET /api/books 书架列表（读 books.jsonl）
 * - POST /api/books 建书（doInit；1.5 段 1 表单）
 * - GET /api/books/:name 单书身份（读该书 book.yaml，含 host）
 * - GET /api/boot 启动初始态（--book 直进支持）
 *
 * workDir 由 server 启动时 findWorkDir(cwd) 注入；为 null 时书架空 + 提示（不崩）。
 *
 * 拆分沿革（⑤④产品巨件拆分波4）：本单件（870 行）缝 A+B
 * 纯移动拆分——删书路由 books.delete + 删/改名共用的生命周期助手族（forgetBookKeyedCaches
 * 书键缓存整表清理 + shelfGuard 守卫缓存族〔清理体引用 shelfGuardCache，随缝单源迁出，
 * 本残核 books.get 经 getShelfGuard 单向取用〕+ 墓地删除族 + busyGate / 编排 settle /
 * 五连 drain 复查）→ api/books-lifecycle.ts（缝 A）；改名路由 book.rename +
 * initialBook / --book 直进指针（setInitialBook）→ api/books-rename.ts（缝 B）。本残核
 * 保留书架列表 / 建书 / 单书身份 / boot 四路由与 BookCtx，registerBookRoutes 残核聚合
 * 保序（books.delete / book.rename 在原位内联调两缝注册函数，路由注册顺序逐字节不变）；
 * 迁出公开导出 setInitialBook（缝 B）经下方逐名 re-export 桥接，全库消费方 import 面
 * 零改动（缝 A 的墓地清理测试注入口 re-export 已随 收尾删除——清理函数
 * 改组装根 RouteOverrides 经 BookCtx 注入）。
 * 运行时依赖单向：books→lifecycle、books→rename、rename→lifecycle，无环回引——两缝
 * 对本模块仅 import type BookCtx（编译期擦除）；顶层求值常量随缝单源迁出，残核无跨
 * 模块顶层求值。本头注上方原文全部历史记载原样保留。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import type { TaskGateInjected } from './task-gate.js' // 闸实例经组装根注入
import type { DriverHost } from '../driver-port.js' // driver 经组装根注入
import { reply, replyError, HttpError } from '../http.js'
import { readBooks, isInvalidBookName, BOOK_NAME_INVALID_REASON } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { doInitAsync } from '../../../install/init.js'
import { computeBookSummaryAsync, yieldToEventLoop } from './progress.js'
// 拆分接线：缝 A/B 注册函数残核聚合保序调用；getShelfGuard / initialBook
// 为残核消费的单源助手 / 活绑定状态（两缝文件不回引本模块任何运行时值）
import { getShelfGuard, registerBookLifecycleRoutes } from './books-lifecycle.js'
import { registerBookRenameRoutes, initialBook } from './books-rename.js'

// 拆分桥接：setInitialBook 逐名 re-export，全库 import 面零改动。
// （收尾：原同行的墓地清理测试注入口 re-export 随缝删除——清理函数改
// 组装根 RouteOverrides 经 BookCtx 注入。）
export { setInitialBook } from './books-rename.js'

export interface BookCtx extends TaskGateInjected {
  /** driver 宿主（session 存取 + 能力面）——组装根注入 */
  driver: DriverHost
  workDir: string | null
  /** session token(defense-in-depth,boot 注入前端,写端点校验) */
  token: string
  /** Origin 是否可信（同源或 dev 白名单）——boot 据此决定是否回传 token */
  isTrustedOrigin: (origin: string) => boolean
  /** APP 级数据目录（Electron userData / CLI 模式跨平台约定路径）——事件库迁移用 */
  userDataPath: string | null
  /** 启动通告投递口——事件库迁移失败等请求期故障进 App 级横幅（可选，
   *  兼容既有调用方；缺失时仅日志留痕） */
  onStartupNotice?: (kind: string, message: string) => void
  /** 收尾：删书墓地后台清理函数覆盖档——组装根 RouteOverrides 注入
 * （undefined = 真删生产口径逐位不变；测试注入受控桩/暂停桩断言墓地行为） */
  graveyardCleanup?: ((graveAbs: string) => Promise<void>) | null
}

export function registerBookRoutes(ctx: BookCtx): void {
  // 书架列表
  defineRoute('books.get', {
    method: 'GET',
    path: '/api/books',
    handler: async (_, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      reply(res, 200, {
        books: [],
        workDir: false,
        hint: '当前目录不是 CLWriting 工作目录。请在工作目录（含 .clwriting/）下启动 studio。',
      })
      return
    }
    // 书架卡补摘要：title / 进度(N 章/字数) / 最近编辑。单本损坏不崩整列（摘要降级缺省）。
    // entry.path 过 resolveWithinRoot——readBooks 已拒 `..`/绝对
    // 路径，此处补与删/改路径同强度的越界/symlink 校验（校验强度对称化）；不合法条目
    // 按损坏标记降级（不崩整列）。
    // 逐书摘要改走 async 孪生 + 书与书之间让出——书库多书时同步
    // 逐书整树扫描单请求冻结事件循环（Electron 内嵌单进程服务 = 桌面卡死），摘要
    // TTL 缓存只降频不减峰（缓存 MISS 的首轮与失效后仍全量）。
    // resolveWithinRoot + readBookConfig 收进 TTL 缓存（getShelfGuard，
    // 与摘要同 30s 口径）——两者此前每请求每书重跑（数百次同步 stat/读盘），摘要有缓存
    // 而守卫没有是半收口。
    const books = []
    for (const b of readBooks(ctx.workDir)) {
      await yieldToEventLoop() // 书与书之间让出（书内扫描的逐章让出见 computeBookSummaryAsync）
      const guard = getShelfGuard(ctx.workDir!, b.path)
      if (guard.damaged) {
        books.push({ ...b, damaged: true, createdAt: b.created_at })
        continue
      }
      try {
        // -BE-1：一次扫描算出进度+最近编辑+最新章节（消除三重 readChapterDir）。
        // 全局托底：targetWords 进度是喂运行时的有效值——书级未设回落 global.json
        // defaultTargetWords（无回落键，global 没有则保持未设 → 前端不显示完成度）
        const effective = applyGlobalDefaults(guard.config, ctx.userDataPath)
        const summary = await computeBookSummaryAsync(guard.bookRoot)
        books.push({
          ...b,
          title: effective.book.title,
          chapters: summary.chapters,
          words: summary.words,
          lastEdited: summary.lastEdited,
          targetWords: effective.book.target_words,
          latestChapter: summary.latestChapter,
          createdAt: b.created_at,
        })
      } catch {
        // 书仓库损坏/缺 book.yaml：保留登记原样 + 显式损坏标记（前端容错）
        books.push({ ...b, damaged: true, createdAt: b.created_at })
      }
    }
    reply(res, 200, { books, workDir: true })
  },
  })

  // 建书（1.5 段 1 表单 → doInit）
  // 原 handler 内联 readJson + as 断言——现工目录前置门落 gate（NO_WORKDIR
  // 仍先于 body 400）、name 形状/合法性等 body 校验落 parse；handler 只拿类型化 input。
  // 书名非法仍回 400 BAD_PATH（HttpError 透传自身码，与迁移前逐位一致）。
  defineRoute('books.post', {
    method: 'POST',
    path: '/api/books',
    gate: ({ res }) => {
      if (ctx.workDir) return { value: ctx.workDir }
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录，无法建书')
      return false
    },
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (!name) throw new Error('书名不能为空')
      // 书名校验与 doInit 逻辑层共用单一真相源（isInvalidBookName）——防 `../` 越出 workDir
      // （拒绝文案收编 BOOK_NAME_INVALID_REASON 单源，含字符全集
      // 与跨平台原因披露——行为维持跨平台硬拒不变）
      if (isInvalidBookName(name)) throw new HttpError(400, BOOK_NAME_INVALID_REASON, 'BAD_PATH')
      const genre = typeof body['genre'] === 'string' ? body['genre'].trim() : ''
      const kind: 'short' | 'long' = body['kind'] === 'short' ? 'short' : 'long'
      const leads = Array.isArray(body['leads'])
        ? body['leads'].filter((x): x is string => typeof x === 'string')
        : undefined
      const host: 'cc' | 'codex' = body['host'] === 'codex' ? 'codex' : 'cc'
      // 目标字数（可选，落 book.yaml target_words，总览页算完成度）
      const targetWords =
        typeof body['targetWords'] === 'number' && Number.isFinite(body['targetWords']) && body['targetWords'] > 0
          ? body['targetWords']
          : undefined
      // 简介（可选，落 简介.md）
      const brief = typeof body['brief'] === 'string' ? body['brief'].trim() : undefined
      return { name, genre, kind, leads, host, targetWords, brief }
    },
    handler: async ({ input, gate: workDir }, _req: IncomingMessage, res: ServerResponse) => {
    // /：建书迁 doInitAsync——doInit 经 appendBook 的同步
    // books.lock（Atomics.wait 最坏 5s）残留在承载 SSE/全部接口的请求事件循环上
    // （原 install/books.ts「余面均不在请求窗口」登记失实，GUI 建书正是窗口内漏网点）；
    // 异步孪生经 appendBookAsync（setTimeout 轮询），失败语义不变（reason 人话）
    const result = await doInitAsync({
      workDir,
      name: input.name,
      genre: input.genre || undefined,
      leads: input.leads,
      kind: input.kind,
      host: input.host,
      targetWords: input.targetWords,
      brief: input.brief,
    })
    if (!result.ok) {
      replyError(res, 400, 'BAD_INPUT', result.reason)
      return
    }
    reply(res, 200, { name: result.bookName, kind: input.kind, path: result.bookPath })
  },
  })

  registerBookLifecycleRoutes(ctx)

  registerBookRenameRoutes(ctx)

  // 单书身份
  defineRoute('books.by-name.get', {
    method: 'GET',
    path: '/api/books/:name',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      // 删 !name 死分支——path 参数:name 为空的 404 由下方
      // find 未命中统一给出（原并入 NO_WORKDIR 是错误码语义错位）
      const name = params['name']
      if (!ctx.workDir) {
        replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
        return
      }
      const entry = readBooks(ctx.workDir).find((b) => b.name === name)
      if (!entry) {
        replyError(res, 404, 'NOT_FOUND', `没有这本书：${name}`)
        return
      }
      // book.yaml 损坏/缺失时回落默认骨架会静默回传空 title——与
      // GET /api/books/:name/config 的 500 IO 口径对齐（读失败显式报错，不代答默认身份）
      // 低-2：error 是 ParseError {file,line,message} 对象——直接插值会串成
      // 「[object Object]」，取 .message 展示真实解析错误（与 state.ts 同场景口径）
      const cfgResult = readBookConfig(join(ctx.workDir, entry.path, 'book.yaml'))
      if (!cfgResult.ok) return replyError(res, 500, 'IO_ERROR', `读 book.yaml 失败:${cfgResult.error.message}`)
      const { config } = cfgResult
      // 单书身份回显：保持 raw（与 GET /api/books/:name/config 同口径——身份 = 书文件里
      // 实际写的值；genre 未设 = undefined 由前端自行回落全局默认，服务端不代答）
      reply(res, 200, {
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        ...(entry.created_at ? { created_at: entry.created_at } : {}),
        title: config.book.title,
        genre: config.book.genre,
        host: config.host ?? 'cc',
      })
    },
  })

  // 启动初始态（--book 直进 + session token 注入前端）
  defineRoute('boot', {
    method: 'GET',
    path: '/api/boot',
    handler: (_, req: IncomingMessage, res: ServerResponse) => {
    // token 仅在可信时回传——无 Origin（本机直连 curl/测试）或同源/dev 白名单
    // Origin（server/index.ts 注入）；外部 Origin 一律不给。initialBook 无敏感性，照常回传。
    // 口径修正：本机进程=同信任域——本地进程无 Origin 直连
    // 本端点即可拿 token，故 token 不承诺防本机进程；其实际作用是把写端点/SSE 可驱动面
    // 收敛到拿到 boot 的客户端，配合 Host/Origin 校验（server/index.ts）防远端网页驱动。
    const origin = req.headers.origin
    const trusted = !origin || ctx.isTrustedOrigin(origin)
    reply(res, 200, trusted ? { initialBook, token: ctx.token } : { initialBook })
  },
  })
}
