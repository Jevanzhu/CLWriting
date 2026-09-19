# 全量源码独立重评二轮（2026-09-18）

- **执行模型**：GLM-5.3（主审 = 会话模型；分域评审子代理 ×7 同为 GLM-5.3，主审对候选 P1/P2 逐条对源码复核锚点，见 §六）。
- **性质**：评审报告——**已收口**（2026-09-18 0918二轮修复批，作者指令「全部修复。」）——P2×3 + P3×36 全量真修（G102 按缓办处置留痕），L2 九门全绿，报告随收口批归档 `Archive/`（扁平）。
- **基线**：git `4a3d5333`（= 0918独立重评修复批提交后树；一轮报告基线 `094043a1`）。
- **方法与纪律**：同日作者指令「忽略掉现有文档，重新评审下当前项目源代码，结果形成一个文档」的独立重跑——会话因模型切换中断，第一波子代理被取消后全量重派（两波 ×7 域，单波 ≤4）。**评审全程不读 Dev/Docs 既有文档与一轮报告正本**，各域结论先独立产生；全部回收后主审才与一轮报告（`Archive/全量源码独立重评-评审-GLM-5.3-2026-09-18.md`）及其处置记对照，裁定本轮为**修复后基线上的增量复评**——与一轮已修/已登记项重叠的发现不重复立项（对照表见 §五）。分级同前：P1 = 正确性/安全/数据丢失必须修；P2 = 应修；P3 = 低危/一致性。核实不了的旨不报、风格偏好不报。
- **各域评分（子代理原判，供参照）**：AI 链路 8 / 桌面壳 9 / 文档数据 9 / 前端数据层 8.5 / server+基建 9 / 前端组件 9 / 周边+安全横切 8——与一轮「防御密度显著高于同类项目平均水平」的总体画像一致，本轮复评未发现任何侵蚀该结论的退化。

## 一、总体结论

1. **修复批质量印证**：一轮 P1×1 / P2×11 全量真修后，本轮七个独立子代理（不读一轮报告、只读源码）在修复后基线上**零 P1、零「已修项复发」**——一轮 12 条 P1/P2 无一被重新发现，修复有效且无连带回归。子代理对各域「优点」的独立描述（原子写族、竞态守卫单源、SSE 生命周期、Electron 安全五件套、路径三重防线、日志三层脱敏）与一轮画像互相印证。
2. **本轮增量 = P2×3 + P3×36**：P2 三条分别落在 chat 小上下文模型预算下限 clamp 失配（A101）、前端 flushDirty 对已删除文档的假警报残窗（E101，R33-13 注释宣称已修而同轮残留）、书架浮层删书回调二次解码（F101，书名含 `%` 时删书成功却报错且死路由收尾被跳过）。全部为主审逐条源码复核证实（§六）。
3. **两条跨域独立交叉发现**：vault KEK 混淆级保护（AI 域与周边安全域两个子代理互不知情各自判 P2）与 SSE `?token=` URL 兜底通道——均系一轮已登记项（A008 维持 / R30-25 移除条件在案），本轮不重复立项，但两域一致的高评级作为**升级信号注记在案**（§五）。
4. **安全面复核结论不变**：密钥（信封加密+出口脱敏）/ 注入（零 eval、spawn 全数组参、SQL 全参数化）/ 路径（resolveWithinRoot 单源纵深）/ 网络（回环绑定+Host 白名单+无遥测）四面横切扫描均干净；新增两条低危硬化项（safeTokenCompare 长度信道 D102、CSP 缺 frame-ancestors C104）。

## 二、增量发现汇总（P2 ×3 / P3 ×36）

| 编号 | 级别 | 域 | 标题 |
|---|---|---|---|
| A101 | **P2** | AI 链路 | 小上下文模型（contextWindow < 40k）下 historyBudget 下限 clamp 高于发送预算，体量防线系统性失效 → 必超窗 400 且收缩重试预算仍超窗，会话死路 |
| E101 | **P2** | 前端数据流 | flushDirty 把外部已删除（NOT_FOUND）文档计入 failed——R33-13 注释宣称已修的「切书假警报」在同轮 flush 内仍触发 |
| F101 | **P2** | 前端组件 | ShelfModal 删书回调对路由参数二次 decode，书名含 `%` 抛 URIError：删除成功却报错 + 死路由收尾链整链跳过 |
| A102-A105 | P3 ×4 | AI 链路 | self-heal 批冻结 book.yaml 快照 / 迁移 bak 覆写时序窗 / 换网候选同步克隆全 store / providers mtime 同毫秒粒度窗（详见 §四） |
| B101-B105 | P3 ×5 | 文档数据 | 拆分光标可落代理对中间劈字 U+FFFD / chapterNoFromName 缺 SafeInteger 守卫消费点分裂（B005 收编残留）/ finalize 防吃书闸 fail-open 零 UI 可见性 / words-diary 追加无 fsync / undo 续跑「重试将自动续跑收尾」承诺不可达 |
| C101-C107 | P3 ×7 | 运行时桌面 | did-fail-load 封顶白屏滞留无终态页 / switch-library 未拒相对路径 / context-menu 限项数不限字节 / CSP 缺 frame-ancestors / 菜单回退首窗可能是子窗 / contextMenuCancelTimers 强引用滞留 / 重复信号无硬退出口 |
| D101-D105 | P3 ×5 | 服务端构建 | 日志 7 天保留仅启动期执行 / safeTokenCompare 长度不等提前返回 / requestTimeout 未显式钉 300s / rebuild 超时固定 120s 无按书规模入口 / SPA 404 文案暴露内部命令 |
| E102-E107 | P3 ×6 | 前端数据流 | apiJson 2xx 裸字面量坏体穿透 / chat_turn 无中途修剪 / 心跳把业务 4xx 计为离线连败 / doc.save() 排队链无轮次上限 / 401 重放对非幂等 POST 无差别重放 / autotag 裸解构信封字段 |
| F102-F104 | P3 ×3 | 前端组件 | 整页书架无渲染帽（与浮层口径不一）/ ChapterTreeItem 编辑态 watch 全树扇出 / WorkbenchView 双 watch 分裂 |
| G101-G106 | P3 ×6 | 周边与网络 | rag.secret 明文旧通道无弃用提示 / 出站 HTTP 无代理支持 / books-repair 瞬时读失败改写 kind 登记 / writeActive 在 books.lock 临界段外 / 知识层 commit 先落盘后校验矛盾信封 / migrate-defaults 读失败静默按 0 本 |

## 三、P2 详报

### A101：小上下文模型下 chat 发送体量防线系统性失效

- **锚点**：`src/ai/orchestrate/chat/turns.ts:215-216` + `src/ai/prompts/chat.ts:271-282`。
- **机理**：`historyBudget = Math.max(CHAT_HISTORY_MIN_BUDGET_POINTS, sendBudget - sysPoints)`，下限固定 20 000（chat.ts:282）；而 `resolveChatSendBudget`（chat.ts:271-275）= `min(96 000, ⌊contextWindow/2⌋)`。当模型行声明的 `contextWindow < 40 000`（16k/32k 窗的廉价模型）时 `sendBudget < 20 000`，historyBudget 恒被 clamp 到 20 000——**高于发送预算本身**。预防线 `if (sendPoints > historyBudget)` 对区间 `[sendBudget, 20 000]` 的历史永不触发 → 实发（sys + history）必超窗 400；随后 A7 收缩重试预算 `⌊historyBudget/2⌋` = 10 000 仍可能高于真实窗口预算 → 第二次再 400 → 会话终态死路，且每次白烧一次计费调用。
- **证据**：turns.ts:215 `const historyBudget = Math.max(CHAT_HISTORY_MIN_BUDGET_POINTS, sendBudget - sysPoints)`；R57-B-1 注释只论证「sys 挤负 clamp」场景，未覆盖「sendBudget 本身低于下限」形态。
- **修法**：下限改 `Math.min(20_000, sendBudget)`（或按窗口比例收缩），补 contextWindow < 40k 的回归用例。

### E101：flushDirty 把外部已删除文档计入 failed，切书守卫假警报

- **锚点**：`src/studio/web-next/src/stores/doc.ts:629`（`if (!ok) failed.add(e.docId)`）与 `:315-324`（doSave 的 NOT_FOUND 分支：删缓存条目后 `return false`）。
- **机理**：F1 契约（doc.ts:597 头注）声明 failed =「保存失败**仍 dirty** 的 docId 列表」；NOT_FOUND 分支已把条目从 Map 移除（不再 dirty），但 `save` 返回 false 使同一轮 flush 的 `failed.add(e.docId)` 仍收进它——phantom 条目随 `return [...failed]` 交给调用方。Book.vue:210-227 切书守卫对 `failed.length > 0` 弹原生确认框「有 N 个文档保存失败」——对一个已不存在的文档假警报，用户须无谓确认一次。
- **对照**：R33-13 注释（doc.ts:315-322）明言修复目标包含「切书 flushDirty 计入 failed 触发『保存失败将永久丢弃』假警报」——实际修复（删除条目）只消除了**后续轮次**的重扫与驻留，**同轮** phantom 残留；注释宣称与行为不符（对齐一轮 D001「注释宣称性质不存在」的 P2 口径）。
- **修法**：doSave 对 NOT_FOUND 返回可区分第三态（如 `null`），flushDirty 只把 `false`（真失败仍 dirty）计入 failed；或 NOT_FOUND 分支在 flushDirty 侧按「条目已不在 Map」过滤。

### F101：ShelfModal 删书回调二次 decode，书名含 `%` 时删除成功却报错

- **锚点**：`src/studio/web-next/src/components/ui/ShelfModal.vue:38-46`；受保护调用点 `src/studio/web-next/src/composables/useShelf.ts:367-370`；书名校验 `src/install/books.ts:80-101`。
- **机理**：vue-router 4 的 `route.params` 已解码一次，回调内再 `decodeURIComponent(current)` 属二次解码。服务端书名校验只拒 `\ / : * ? " < > |`、NUL 与保留名，**不拒 `%`**——书名「50%胜率」可正常创建。此时 `decodeURIComponent("50%胜率")` 因 `%胜` 非法百分号序列抛 URIError；该回调在 `useShelf.confirmDelete` 的 try 内被调用（useShelf.ts:367），异常落入 catch → `deleteError` 显示误导性错误（**书实际已删成功**），且 R65-54 收尾链——`localStorage.removeItem(LAST_BOOK_KEY)` + `ui.closeShelf()` + `router.replace('/shelf')` 离开死路由——整链不执行，用户停留在已删书的 `/book/...` 上后续 API 全 404。含合法 `%XX` 形态的书名（不抛错）则因双解后与原名不等静默跳过收尾。
- **修法**：删除 `decodeURIComponent`，直接消费 `current`（params 已解码）；如需稳妥可回环校验（decode 后再 encode 比对），勿裸二次解码。补书名含 `%` 的删书回归用例。

## 四、P3 增量清单（按域，锚点均为子代理 file:line、主审抽核）

### A 域（AI 链路）

| 编号 | 锚点 | 问题 | 方向 |
|---|---|---|---|
| A102 | self-heal.ts:204,219,518 | 批头读一次 book.yaml 贯穿全批——作者批中收紧 budget/字数对本批不生效，与 chat 侧「下次发送即生效」口径不一 | 章边界重读 |
| A103 | provider/store.ts:296-320 | 明文→密文迁移后 bak 覆写用同步 readFileSync 直读——在途写排队窗口内读到迁移前旧文件，roundtrip 校验必失败，明文 bak 残留至下次任意 save | bak 覆写挂 saveProviders 成功回调后 |
| A104 | orchestrate/chat/turns.ts:426-434 | 换网重试对每个候选同步 `loadProviders`（克隆全 store 含解密）+ `createProvider`（入 LRU 挤占容量 8） | 候选过滤只做轻量形状校验 |
| A105 | provider/store.ts:211-219 | `_cache` 以 mtimeMs 为失效判据——同毫秒内外部改写命中陈旧缓存（读侧一次调用影响；写侧已有 revision 复验兜底） | 备案即可 |

### B 域（文档数据）

| 编号 | 锚点 | 问题 | 方向 |
|---|---|---|---|
| B101 | structure-split.ts:139-148,182-183 | `validateSplitCursor` 不校验 UTF-16 代理对边界——光标偏移落在 astral 字符（CJK 扩展 B 生僻字人名/emoji）中间时 `slice` 把一字劈成两个孤立代理，落盘各编码为 U+FFFD——**原章尾与新章头同时永久损坏一字**，且恢复重放经同一光标复现损坏。前端编辑器光标通常在码点边界，后端缺一道防线 | 校验 cursorOffset 处非低位代理（BAD_INPUT）——**修复价值高（一行）** |
| B102 | format/filename.ts:137-140；消费点 document/finalize.ts:391-394、service-meta.ts:286-293 | `chapterNoFromName` 单源缺 `Number.isSafeInteger` 守卫（R64-20 在 words.ts 论证过），B005 收编时守卫未随迁——16+ 位纯数字前缀文件名得失真浮点章号，定稿防吃书闸定位 miss、meta 回落派生长数字文件名；两处消费点手工补、两处未补，口径分裂 | 守卫下沉单源，删手工补丁 |
| B103 | document/finalize.ts:344-373 | 防吃书闸整体 fail-open（catch → warn → 放行）且零 UI 可见性——与机检侧同类降级 `pushDegradedYellow`（check/run.ts:441-449）口径不对称；闸门持续抛错时防吃书检查长期静默失效 | 降级事实透出到定稿结果信封（黄项） |
| B104 | document/words-diary.ts:96-106 | 字数日记追加裸 appendFileSync 无 fsync——对照同为 append-only 的 journal `appendLineAsync`（journal.ts:276-288）追加后 fsyncFile 的耐久纪律；掉电丢尾部行次日自愈，影响微小 | 复用 fsyncFile 或注释声明放弃理由 |
| B105 | structure-merge.ts:480-482,526-535,539-544 | `undoChapterMerge` 的「还原失败——重试将自动续跑收尾」承诺不可达：回滚后目标章 fm `并入` 键消失，重试第一步即被 `并入.length === 0` 门（:480）挡死报「已撤销」，源章滞留回收站只能手工发现还原（链式合并回滚版本仍含前次 并入 才可过门；数据无损——源章在回收站有快照、回滚有留底）。B002 修复后残留的另一 undo 缺陷 | 半完成态（目标已回滚 + 源在回收站）识别为可续跑形态，或 :542 文案改指回收站手工还原 |

### C 域（运行时与桌面）

| 编号 | 锚点 | 问题 | 方向 |
|---|---|---|---|
| C101 | desktop/windows.ts:137-155（对照 :103-115） | `did-fail-load` 重试封顶后只打日志返回——对照 `render-process-gone` 封顶后载入自包含提示页，同文件两终态处理不对称；生产态菜单无 reload，封顶后（≥44s 全失败）白屏滞留无任何可见提示 | 对齐崩溃封顶口径，载入静态提示页 |
| C102 | desktop/ipc.ts:92-116 + workdir-controller.ts:199-209 | `desktop:switch-library` 只验 string 不验绝对路径——相对路径 `./foo` 恰存在于主进程 cwd 时过守卫并原样落库 workdir.json；下次经不同 cwd 启动书库定位漂移 | 入口加 isAbsolute 校验 |
| C103 | desktop/context-menu.ts:32,60-63 | 载荷限项数（200）不限字节——超长 label 直达 `Menu.buildFromTemplate` 原生构建，主进程阻塞 | label/key 单条与总字节上限 |
| C104 | desktop/main.ts:78-85 | CSP 数组缺 `frame-ancestors`（不回落 default-src）——本地端口可被任意页面嵌 iframe（点击劫持/DNS rebinding 纵深；API 侧有 token 兜底） | 追加 `frame-ancestors 'none'` |
| C105 | desktop/main.ts:472-479 | 菜单 action 回退 `getAllWindows()[0]`——主窗销毁窗口期首窗可能是无 `useAppActions` 接线的子窗，动作静默丢失 | 回退限主窗存在才发送 |
| C106 | desktop/ipc.ts:62,299-306 | `contextMenuCancelTimers` 强引用 Map 持 WebContents——窗口正常销毁不摘除条目滞留至进程尾（上界 = 窗口数，影响微小） | WeakMap 或 closed 时摘除 |
| C107 | desktop/main.ts:670-672 | SIGINT/SIGTERM 注册后默认退出取消、重复信号被幂等门吸收——优雅链最坏 ~10s 内二次信号无效，dev 终端狂按 Ctrl+C 无法加速退出 | 信号计数，第二次直接 exit |

### D 域（服务端与构建）

| 编号 | 锚点 | 问题 | 方向 |
|---|---|---|---|
| D101 | log/index.ts:117-130,167-173 | 日志 7 天保留仅在 `initLogging` 排队一次——长跑进程跨天新建的日志文件超期不清理，运行期目录无界增长（本地低速率，量级有限） | 泵内跨日切换时节流清理 |
| D102 | studio/server/http.ts:86-92 | `safeTokenCompare` 长度不等提前 return——比较耗时与期望值长度相关，泄露 secret 长度时序信号；当前 token 恒 UUID 定长无实害，但该原语被三处复用 | 两侧先 SHA-256 定长再 timingSafeEqual |
| D103 | studio/server/index.ts:489-493 | 显式设了 keepAliveTimeout/headersTimeout 但 `requestTimeout` 依赖 Node 默认 300s——408 闲置超时设计与前端 ~300s 自愈假设均以此为前提，跨版本不稳 | 显式 `requestTimeout = 300_000` |
| D104 | cache/run-rebuild-async.ts:31 + worker-async.ts:57-85 | rebuild/export worker 超时固定 120s，生产链无按书规模调整入口——200 万字书首次全量 rebuild 在慢盘/网盘卷可能触顶 terminate（下次自愈重试） | 超时档书级/全局可配 |
| D105 | studio/server/static.ts:249 | SPA fallback 404 文案「请先运行 npm --prefix … build」——打包态用户遇 dist 丢失看到开发者视角指引且泄漏内部路径 | 按运行形态分叉文案 |

### E 域（前端数据流）

| 编号 | 锚点 | 问题 | 方向 |
|---|---|---|---|
| E102 | api/client.ts:296-298 | `apiJson` 只对 `body === null` 抛 MALFORMED_RESPONSE——2xx 裸字面量（`true`/数字/字符串）穿透信封判型直达调用方按对象消费 | null 守卫扩 `typeof body !== 'object'` |
| E103 | stores/chat.ts:265-269 | `chat_turn` 推新气泡无中途修剪——单次长跑超过 200 条要等整跑收尾才裁剪；content 体积无上限（对照 workbench MAX_TEXT_OUT 封顶） | chat_turn 分支补 trimMessages() |
| E104 | composables/useHeartbeat.ts:50-56 | 心跳把一切非 2xx（含 404 书已删/401）计为「服务离线」并累计连败驱动看门狗——业务 4xx 误报离线徽章 | 区分网络异常与业务 4xx |
| E105 | stores/doc.ts:246-252 | `doc.save()` 手动保存排队链尾递归无轮次上限——同文件 flushDirty 的 3 轮防活锁口径未覆盖此处 | 同款轮次上限 |
| E106 | api/client.ts:126-147 | 401→reboot→重放对非幂等 POST 无差别重放一次——仅文档保存带 operationId；sendChat/deleteDoc 等被重放即双发（本地单机触发概率极低） | 重放仅限幂等方法或补幂等键 |
| E107 | stores/doc.ts:495-538 | `syncCleanWithTree` 迟到批次回写不校验树 revision 身份——并发树刷新下旧批次把 `e.treeRev` 盖回旧版并致整批重复拉取、clean 条目短暂旧内容（后续保存靠乐观锁自愈，无数据损坏）。主审复核证实：回写守卫仅查书名/条目/dirty/conflict/saving | 回写前加 `tree.revision === curRev` 复检 |

### F 域（前端组件）

| 编号 | 锚点 | 问题 | 方向 |
|---|---|---|---|
| F102 | pages/Shelf.vue:183-191（对照 ShelfModal.vue:63） | 整页书架无渲染帽，与浮层书架（SHELF_RENDER_CAP=100，同族性能论证）口径不一——数百书时全量挂载 + 入场动画 | 整页同传 render-cap |
| F103 | components/panels/ChapterTreeItem.vue:178-192 | 全树共享的 creatingDirPath/renamePath props watch 在每个已渲染树项实例扇出——一次重命名触发 O(已渲染节点数) 回调（单次成本可忽略，结构性浪费） | 输入框抽单实例或 provide 局部化 |
| F104 | views/WorkbenchView.vue:110-126 | bookName 重复注册两个 watch（切书清理 + loadRuleHits）——行为正确但切书清理逻辑分裂两处，违背本库「切书清理单点」纪律 | 并入第一个 watch |

### G 域（周边与网络）

| 编号 | 锚点 | 问题 | 方向 |
|---|---|---|---|
| G101 | rag/config.ts:91-103 | 旧版 `.clwriting/rag.secret` 明文通道与新链路 vault 加密保护等级不一——工作目录在同步盘时明文 key 上云；无弃用提示 | 检测到存在时一次性 deprecation warn |
| G102 | rag/embed.ts:65 等全库出站点 | Node 内置 fetch（undici）不读 HTTPS_PROXY——目标用户访问官方端点普遍需代理，配了系统代理也直连失败且报错只有「网络异常」（产品功能缺口非缺陷） | 挂 EnvHttpProxyAgent 或设置页配置项 |
| G103 | install/books-repair.ts:104-107,121-130,250-259 | 自愈扫盘对 book.yaml 瞬时读失败（EACCES 等）回落改写登记（kind→long、名字→目录名）——同步盘/杀软短暂锁住时登记随抖动来回改写（外溢 books.jsonl mtime） | `!cfgRead.ok` 跳过该书刷新，保留原登记 |
| G104 | install/books.ts:451-454 + init.ts:101-103 | `writeActive` 在 books.lock 临界段外裸写——双进程并发建书时最后写者胜（指针竞争，数据无损） | 挪进 appendBookLocked 同临界段 |
| G105 | knowledge/update.ts:299-330 | commit 先落盘后校验——存量 manifest 有坏行时写入成功却返回 ok:false（issue 指向旧坏行），重试又得「不得重复登记」，两报错互相矛盾 | report 区分「本次成功 + 存量坏行」两栏 |
| G106 | install/migrate-defaults.ts:55（readBooks 容错 → []） | books.jsonl 读失败与真 0 本书不可区分——迁移整轮静默跳过无 warn（幂等下次重试，纯可观测性缺口） | 改 readBooksStrict + warn 留痕 |

## 五、已知项对照（不重复立项）

| 本轮子代理发现 | 一轮/历史登记 | 处置 |
|---|---|---|
| vault KEK 混淆级、mac 未接 Keychain（**AI 域与周边安全域两个子代理独立判 P2**） | 一轮 A008 维持（本地单机定位可接受，码内已声明威胁模型） | 维持不翻案；两域一致高评级作为升级信号注记——mac 分支可用 Electron `safeStorage`（Keychain）承载 KEK，vault 已预留版本号可做 v2 迁移，随作者另令 |
| 事件库无保留策略、恢复全量投影 | 总览 §五 H2 拍板「全量保留 + 手动清理」+ 0917 批尾窗三原语（chat-history 真尾窗已落） | 拍板内；子代理指出的「regenerate 无条件全量重建」性能面在拍板语义内，不立项 |
| SSE `?token=` URL 兜底通道（前端 useSse 回退 + 服务端只比对不烧票） | R30-25 登记移除条件（web-next 回退路径下线）；一轮 §3.4 契约观察 | 已知兼容通道 |
| close flush 超时 4s 无确认即放行 | R54-A-1 拍板「超时留痕即放行」 | 拍板内（子代理建议的自适应预算可作后续打磨） |
| recordUsageSafe 同步双 fsync 事件循环冻结面 | 重审-05 已登记「已知代价的既定取舍」 | 已登记 |
| CI win 腿首跑红重跑一次兜底 | 修复批 D003 注释自认取舍（tinypool 竞态，随 vitest 4/5 迁移批撤） | 已登记 |
| ContextMenu 浏览器回退版子菜单键盘不可达 | 码内头注登记挂账 | 已登记 |
| 一轮 P3 维持/缓办 12 项（A005/A006/A008/A009/B004/B006/B008/G004/G005/G006/G007/G008） | 一轮 §六处置记 | 原判维持，本轮未发现需翻案的新证据 |

## 六、主审核验记录

本轮候选 P1/P2 共 6 条（子代理原判 P2×8，其中 vault KEK、事件保留 2 条并入 §五已知项），逐条对源码复核：

- **A101**：chat.ts:271-275（`min(96_000, ⌊contextWindow/2⌋)`）+ :282（`CHAT_HISTORY_MIN_BUDGET_POINTS = 20_000`）+ turns.ts:215-216（Math.max clamp）——三点互证成立；R57-B-1 注释论证范围未覆盖 sendBudget < 下限形态。**P2 证实**。
- **E101**：doc.ts:315-324（NOT_FOUND 删条目 + return false）+ :629（`if (!ok) failed.add`）+ Book.vue:210-227（failed>0 弹确认框）——证实；R33-13 注释宣称含「切书 flushDirty 计入 failed 假警报」修复而同轮 phantom 残留。**P2 证实**（对齐一轮 D001 注释失实口径）。
- **F101**：ShelfModal.vue:38-46（`decodeURIComponent(current)`）+ useShelf.ts:355-375（onDeleted 在 try 内、catch 落 deleteError）+ books.ts:80-101 书名校验（grep 实证 `%` 不在拒绝集）+ vue-router 4 params 解码契约——四点互证成立。**P2 证实**。
- **C101**：windows.ts:137-155 封顶分支仅 log + return，对照 :103-115 render-process-gone 封顶载提示页——不对称实证；触发形态（server 退避重启窗内 5 次加载失败）低频、无数据面。**降 P3**。
- **B105 候选（undo 续跑承诺，子代理原判 P2）**：structure-merge.ts:480-482（`并入.length === 0` 门先于 hints 消费 :484-495）+ :526-535 回滚注释「并入 键自然消失」+ :539-544 承诺文案「重试将自动续跑收尾」——单次合并重试必死 :480 门证实（链式合并回滚版本仍含前次 并入 才可过门）；API 层 hints 来自请求体且前端无提示时恒发 {}（api/documents.ts:314 注释），重试无特殊路径。数据无损（源章在回收站有快照）。**降 P3**（对齐一轮 B002 同域同级先例），已编入 §四 B 域表 B105。
- **E107 候选（迟到回写）**：doc.ts:517-520 回写守卫四查（书名/身份/dirty/conflict/saving）确无树 revision 复检——证实；影响止于重复拉取与短暂旧内容（乐观锁自愈）。**降 P3**。

P3×36 由子代理 file:line 锚定、主审抽核（B101/B102/B105/C104/D102/G103 抽查属实），未逐条复读。

## 七、处置建议

1. **P2 三条均为小改**：A101 一行 clamp + 回归用例；E101 doSave 第三态或 flushDirty 过滤 + 用例；F101 删一行 decode + 书名含 `%` 用例——可单批收口。
2. **P3 高价值四条**（B101 代理对劈字、C104 frame-ancestors、D102 摘要后比较、B102 守卫下沉）修复面小、防线收益直接，建议随批顺手；其余 P3 按域触达渐进。
3. **§五升级信号注记**（vault KEK 接 Keychain）属产品决策，随作者拍板。
4. 收口条件照旧：P1/P2 修复 + L1 回归 + 收口批 L2 九门全绿后，本件归档 `Archive/`（扁平），批记 = `Archive/README.md`（2026-09-19 撤档，git `02c52430` 可取）。

## 八、处置记（2026-09-18 0918二轮修复批，作者指令「全部修复。」）

**L2 九门实录（mac，终树一次全绿）**：vitest 全量 **1239 文件 = 7653 过 + 8 跳 0 败**（一次全绿 169.31s）+ tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check 过（counts 1239/7653/33/54 README 修账后对账绿 / packaging / knowledge）+ e2e 51 过 3 跳 40.3s（跳 = 发布门 spec 预期口径）+ coverage 阈值门红 0 条。净 **+29 文件 / +107 用例**（回归测试 29 新件行为命名 + 既有件扩例 + 1 件随 F102 改名），差值锚 64 维持（win 预期 7589 过 + 72 跳待实跑核对）。**本件随批收口归档 `Archive/`（扁平）**，批记 = `Dev/Docs/Archive/README.md`（2026-09-19 撤档，git `02c52430` 可取）。

### P2×3 —— 全量真修（3/3，主审逐条源码复核）

| 项 | 处置 |
|---|---|
| A101 | 真修：turns.ts:225 `historyBudget = Math.max(Math.min(CHAT_HISTORY_MIN_BUDGET_POINTS, sendBudget), sendBudget - sysPoints)`——下限先与 sendBudget 取 min 随预算收缩，historyBudget 恒 ≤ sendBudget；R57-B-1 注释补记「sendBudget 本身低于下限」形态；`test/ai/chat-small-window-budget-clamp.test.ts` 3 例（30k 窗盲区历史保尾预切到 ≤15k + 16k 窗收缩重试预算 4k 断言不含 20k/10k） |
| E101 | 真修：doc.ts:658 `if (!ok && docs.value.get(e.docId) === e) failed.add(e.docId)`——条目仍在且同一实例才算「保存失败仍 dirty」，NOT_FOUND 已删条目（get undefined）不计入；R33-13/F1 注释同步修账；`test/studio/webnext/flush-deleted-doc-not-failed.test.ts`（404 不计入 / 500 计入 / 混合形态） |
| F101 | 真修：ShelfModal.vue:38-46 删 `decodeURIComponent`，直取 params（已解码）比对；回调体失败不再抛进 useShelf catch；`test/studio/webnext/shelf-delete-percent-name.test.ts`（「50%胜率」不抛 + LAST_BOOK_KEY 清 + replace('/shelf') / `%XX` 形态 names 匹配） |

### P3×36 —— 全量真修 35 / 缓办 1（G102 留痕兜底）

**A 域（5）**：A102 self-heal.ts:357 章边界重读 book config（测试锚点换用书级优先键 `budget.tokens_per_chapter`——`calls_per_chapter` 自 2026-08-19 起是全局固定键，改它无法区分冻结/重读，**批内发现并记档**）／A103 provider/store.ts 拆 `saveProvidersRaw` + `overwriteBakIfCiphertextRoundtrip` 单源，bak 覆写挂落盘成功之后（快路同步语义不变、排队路径挂 then）／A104 turns.ts:433-448 候选过滤改轻量形状校验（`resolveAdapter` + `tierFromStore`，零实例化零 LRU 占用）／A105 provider/store.ts:214-216 缓存判据补 mtime 粒度窗锚注（登记不修逻辑）。

**B 域（5）**：B101 structure-split.ts:146-155 补 UTF-16 代理边界判定（前位高代理 + 当前位低代理 → BAD_INPUT）／B102 `chapterNoFromName` 下沉 `Number.isSafeInteger` 守卫 + 删 manifest/structure-core 两处手工补丁（words.ts 正则语义不同维持分立、守卫语义对齐注记）／B103 finalize.ts:50-59,364-404 结果信封加 `gateDegraded?: string[]` + api 层透传 + 前端 doc.ts:574-582 warning toast（fail-open 哲学不变）／B104 journal.ts:291-293 导出 fsyncFile 单源 + words-diary 两函数追加后 best-effort fsync／B105 structure-merge.ts:482-512 新 `locateUndoHalfDone` 三重核对（事件副录未撤销 merge + 回收站条目在盘 + 版本指纹盘面==回滚内容）识别半完成态真续跑 + :514-559 `finishUndo` 提取共用（完整撤销后 merge-undo 事件在档 → 天然防误续跑）。

**C 域（7）**：C101 windows.ts:69-77,155-167 加载失败封顶补 `LOADFAIL_NOTICE_HTML` 自包含提示页（对齐崩溃封顶口径）／C102 ipc.ts:107-116 入口 `path.isAbsolute` 校验（先于可达性预探）／C103 context-menu.ts:34-52 单条 200B / 顶层总计 20000B（超长项剥除 + 留痕、顶层超限整体拒收）／C104 main.ts:86-89 CSP 补 `frame-ancestors 'none'`／C105 main.ts:472-489 删 `getAllWindows()[0]` 回退，主窗不存在则 warn 丢弃／C106 ipc.ts:62-103 `armContextMenuCancelTimer` 单点 + WeakSet 防重挂 `'destroyed'` 监听摘除／C107 新模块 `signal-hard-exit.ts`（同型信号第二次 → killNow + exit(1)）+ main.ts:673-683 三行注册改经工厂。

**D 域（5）**：D101 log/index.ts:132-157,418-424 日志泵跨日切换节流清理（1h Map，对齐 spill.ts 先例）／D102 http.ts:85-101 两侧 SHA-256 摘要定长后 timingSafeEqual（消长度信道）／D103 index.ts:494-498 显式 `requestTimeout = 300_000`／D104 run-rebuild-async.ts:31-53 `CLWRITING_REBUILD_TIMEOUT_MS` 环境逃生口（未设/非法回默认 120s）／D105 static.ts:36-59,275-278 SPA 404 文案按源码形态分叉（打包态「前端资源缺失，请重新安装应用」）。

**E 域（6）**：E102 client.ts:325 null 守卫扩 `typeof body !== 'object'`（前置 grep 63 处调用、T 全为对象/数组，零误伤）／E103 chat.ts:269 chat_turn push 后补 `trimMessages()`／E104 useHeartbeat.ts:48-60 只由传输层失败驱动离线（任何 HTTP 响应 → online + 清零连败）／E105 doc.ts:249-258 save 增 `_waitRounds` 上限 3（对齐 flushDirty 防活锁）／E106 client.ts:111-127,157-159 新增 `isReplayable`（GET/HEAD 直过；PUT 带非空 operationId 可重放；POST/DELETE 不自动重放）／E107 doc.ts:534 回写守卫补第五查 `tree.revision !== curRev`。

**F 域（3）**：F102 Shelf.vue:181-189 整页书架补传 `SHELF_RENDER_CAP`，帽值收敛 `shared/render-cap.ts` 单源（浮层壳删局部常量改 import）／F103 ChapterTreeItem.vue:178-192 watch 源由全树共享 props 改本实例命中态布尔（非目标项布尔恒 false 不触发，消 O(已渲染节点) 扇出；判据/DOM/交互逐字保留）／F104 WorkbenchView.vue:119-136 切书重载并入首 watch（onMounted 初载随并删除防双调）。

**G 域（4 真修 + 1 缓办 + 1 留痕）**：G101 rag/config.ts:85-113 rag.secret 弃用一次性 warn（读取行为不变）／**G102 缓办**——真修需新增运行时依赖 undici（Node 全局面不暴露 dispatcher 符号，v26 实证）并波及 tsup 全 bundle + asar 排除 node_modules 打包形态，配置面属产品决策；按缓办处置，embed.ts 补代理环境变量一次性检测 warn（不带代理地址值，防凭据回显）／G103 books-repair.ts:101-114 `!cfgRead.ok` 跳过该书对账（保留原登记，对齐 isDirConfirmedMissing 的瞬态纪律）／G104 books.ts appendBookLocked 收编 writeActive（登记 + active 同临界段；grep 核实生产调用面全为「建书即切活动书」故不加选项参数；R44-18 的 writeActiveGuarded 包装随收编拆除、文案单源迁 books.ts）／G105 update.ts:166-171,231-238,335-357 新 entry 自身先验（source/license 空 → 不写）+ 写入后对账两栏（issue 只指存量坏行 → ok:true + issues + warn；波及新条目 → ok:false）／G106 migrate-defaults.ts:52-62 改 readBooksStrict，null 时 warn 留痕后返回。

### 涉及 scripts/ 的连带改动（如实记档）

G105 的两栏信封使 `scripts/knowledge-commit.ts` 的两态分叉点下沉进提交层——脚本按 ok 出口分流，「预存坏行」分支自 `!report.ok` 段移入新增的 `report.issues.length > 0` 段（作者可见文案与退出码 1 逐字不变，R0912-3 契约面零改动）；未再使用的 `caseFoldKey`/`readKnowledgeManifest` import 随批删除。该文件在修复批前未列入改动面（评审报告 §四 D/G 域表未含 scripts/），本批按「修复必需的最小改动」处置并如实登记。

### 批内如实记档

- **连带四败自清**（L2 首跑发现，域内 L1 未覆盖的面）：① `r38-exit-guards` R38-19 静态锚按 C107 新契约改写（原断言 `process.on('SIGINT', () => app.quit())` 字面量，C107 改经工厂接线——锚改「三信号注册齐备 + 工厂首次语义 = app.quit」，R38-19 动机面不变）；② `migrate-defaults-read-fail-warn` 新件 `mkdirSync(.clwriting/books.jsonl)` 缺父目录（ENOENT 而非目标 EISDIR 形态）——补 `recursive: true` 建父目录；③ `append-book-atomic-active` 新件并发用例用默认 `sort()` 按 UTF-16 码元序比较中文书名——改 `localeCompare(b, 'zh')`；④ `r0912-3-knowledge-commit-manifest-state` 脚本测试因 G105 分叉点下沉而红——按上述 scripts/ 改动处置后绿。
- **批内发现并记档**：A102 的测试锚点问题——`budget.calls_per_chapter` 自 2026-08-19 起属「全局固定」键（applyGlobalDefaults 无条件覆盖书级值），改它无法区分配置冻结与重读，测试锚点换用书级优先键 `budget.tokens_per_chapter`。
- **G102 缓办理由在案**：真修路径需新增运行时依赖（本仓生产依赖仅 3 个、tsup 全 bundle + asar 排除 node_modules 的打包形态会被波及），且「设置页显式代理项 vs 纯环境变量」属产品决策——按缓办处置，一次性 warn 留痕让作者可从日志定位「配了代理为何还网络异常」。
