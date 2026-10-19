# 域5 审计报告:Web 前端(Vue 3 + Pinia + CodeMirror 6)

- 定位：**全量代码审计（2026-10-19 第一轮）分域附档**——域5 Web 前端（Vue 3 + Pinia + CodeMirror） 的证据面与问题清单；主档 = `全量代码审计-评审-DeepSeek-V4.1-Flash-2026-10-19.md`（同槽位）。不属于本档：汇总结论、修复落地记录与作者拍板。
- 执行模型：DeepSeek-V4.1-Flash（`ccats/deepseek-v4.1-flash`）域审员子 agent。

- 审计对象:`src/studio/web-next`(工作树 = G:\02^Workspace\01^Codes\CLWriting\CLWriting-Main)
- 审计员:audit-web(子域审员)/ 任务:task-5 / 日期:2026-10-19
- 证据来源:源码、配置、测试档名与 git 提交记录。**不采信** docs/、知识层/、.agents/notes/、README.md 的任何结论或数字(仅用于「声称 vs 实现」对照)。
- 只读审计:未修改任何源码/配置/测试;未跑全量测试与 coverage;未建构建产物;未 git 写操作。

## 0 范围、方法与抽样声明

**清单实测**(排除 node_modules/dist/coverage):`src/studio/web-next` 入库 255 档 = 48,627 行;`.vue` 120 / `.ts` 123 / `.css` 9 / `.json` 3。其中 `*.ts + *.vue` 242 档 = **46,847 行**,注释行 8,332(18%)。

**抽样规则**(任务书要求写明):
1. 全量清单:255 档按行数排序(前 45 档落表),每类目录计数;
2. 精读:行数 top-25 中 14 档 + 状态/编辑器/守卫链关键小档(全文逐行),共 **22 档 ≈8.6k 行**;
3. 结构性扫描:**全 120 个 `.vue`** 的 v-for key、监听器/定时器配对、SFC 三段构成;全 242 档的类型逃逸/深 watch/空 catch/console 面;
4. 测试对照:`test/studio/webnext`(301 档,`dom/` 子面 235 档)按档名与源一一映射。

**未精读面(声明)**:`api/` 24 档仅 `client.ts`;`components/ui` 52 档仅 `ContextMenu.vue`;`components/panels` 21 档 0 档;`stores/` 20 档 5 档(`doc/workspace/prefs` + `chat-dispatch` 前半);`composables/` 30 档 8 档;`views/` 8 档 4 档(`WorkbenchView`/`AuditView`/`LearnView`/`StyleView`/`RelationsView`/`OnboardView`/`pages/*` 未逐行);`shared/` 34 档 5 档。**未被本报告覆盖的问题面仍可能存在。**

**判据说明**:「静默」= 失败无任何界面可见面(仅 console);「无提示」= 有状态字段但不在当前可见视图/无 toast。「置信度」中 = 代码路径确定但触发条件依赖时序或运行形态,需运行时复核。

## A 问题清单

共 **15 条:P0×0 / P1×1 / P2×3 / P3×11**。

| ID | 严重度 | 类型 | 证据(file:line) | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| W-01 | **P1** | 未保存内容丢失 + 静默 | `src/studio/web-next/src/composables/useBookSwitchGuard.ts:301-322`(脏路由分支 `await doc.flushDirty()` 失败仅 `console.warn` :309-311,随后 `doc.setBook('')` :314);`src/stores/doc.ts:112-134`(setBook → `mirror.clearBookMirrors(prevBook)` :127);`src/shared/dirty-mirror.ts:164-187`(镜像整书清扫) | 从 /book/A 离书到 /shelf(脏路由/手输坏 URL,即 watch 的 `!n` 分支)时若冲刷失败(离线/5xx),未落盘编辑随「清 doc 缓存 + 清崩溃镜像」双双消失,界面**零提示**(仅控制台)。对照:切书 committed 路径对同一形态有弹窗决断(:229-252),此路径没有——同一条数据在不同离开方式下保护强度不一致 | 脏路由分支改为可见面(原生确认/toast),或把镜像清扫延后到冲刷成功(失败时保留镜像作最后兜底) | 中 |
| W-02 | P2 | 关窗兜底缺位 | `src/composables/useUnloadFlush.ts:72-86`(`__clwFlushBeforeClose` 只在 Book.vue 生命周期注册,:75 注释自认「不在编辑页时主进程拿不到钩子即直接关」)、`:97-109`(卸载冲刷 fire-and-forget,失败只 `console.warn`)、`:87-90`(卸载即删全局钩子) | 离书到 /shelf 后立即关窗,或关闭发生在卸载 flush 落定前:主进程拿不到可等待的钩子 → destroy 掐断在途保存,叠加 W-01 的镜像清扫即永久丢失 | 钩子提为应用级(App.vue)注册,或在离书态保留直至确认落净 | 中 |
| W-03 | P2 | 错误静默 | `src/stores/doc.ts:428-431`(autosave 失败只置 `entry.error`,不 toast);`src/composables/useAutosave.ts:19-35`(节拍挂在 Book 层,切到工作台/总览仍在跑);`src/views/EditorView.vue:327-336`(错误面只渲染在编辑器模板) | 作者在工作台/总览长时间写作或断网时,自动保存连续失败**完全不可见**(状态条不在当前视图);要到切书弹窗才暴露,窗口可达数十分钟 | 连续 N 拍失败升级为一次 toast,或把「未落盘」状态提到全局状态条/徽章 | 中高 |
| W-04 | P2 | 双兜底静默失效(超大档) | `src/shared/dirty-mirror.ts:34-35`(`MIRROR_MAX_CHARS = 2_000_000`)、`:102-105`(超限直接 return,仅 `console.debug`);`src/shared/save-limits.ts:16`(`MAX_SAVE_BODY_BYTES = 16MB`)、`:31-34`;`src/stores/doc.ts:362-367`(预检超限置 `tooLarge` 停 autosave) | 两道上限口径不同:2M~5.3M 字符区间的文档**能保存但没有崩溃镜像**;>16MB 则自动保存停止(仅 toast 一次 + 状态条)。降级面只有 debug 日志,作者不知道自己的档已失去崩溃兜底 | 镜像上限与保存上限对齐,或超限时显式提示「本篇已无本地镜像兜底」 | 高 |
| W-05 | P3 | 偏好静默丢弃 | `src/stores/workspace.ts:593`(setBook 内 `persist.cancel()`)、`:337-341`(cancel 清计时器)、`:344-353` 与 `:652-654`(flush 只在关窗链) | 切书前 500ms 防抖窗内的面板开合/宽度/活动文档/树展开**静默不落盘**,重进本书回退旧布局 | setBook 内 cancel 之前先落一次写(或 cancel 改 flush) | 高 |
| W-06 | P3 | 文案一致性/无指引 | `src/api/client.ts:162-177`(token 变化后非幂等请求原样透传 401 `:166`)、`:193` 与 `:353-355`(统一文案 `AUTH_BROKEN_MESSAGE` 仅在「已重放仍 401/403」时使用) | 服务重启换 token 后,删除/发送类写动作失败时作者看到的是服务端信封工程口径(如「token 无效」)而非统一人话,且无「请重试一次」指引(re-boot 已换好新 token) | 非重放面也走统一文案并补一次重试提示 | 高 |
| W-07 | P3 | 无提示的行为损失 | `src/editor/CmHost.vue:363-371`、`:383-398`(外部全量替换走「卸载 history → 重挂」两步真重置 undo/redo 栈) | SSE sync / `doc.refresh` / 树对账触发的替换会整段清掉撤销历史,作者紧接着 ⌘Z 无历史可退(写稿手感面),且无任何提示 | 若实测支持,改为仅清 redo;或清栈时状态条提示一次 | 高 |
| W-08 | P3 | 浮层夹边不全 | `src/components/ui/ContextMenu.vue:226-232`(只判右/下溢出置 flipX/flipY) | 贴视口左/上缘或菜单高于视口时,翻转后仍可能溢出屏外(FontPicker 已有「补水平夹边与上翻」先例:提交 `246eb767`) | 与 FontPicker 夹边口径归一 | 中高 |
| W-09 | P3 | 开发者指令外泄 | `src/api/client.ts:359`(`本地服务未连接,请确认 API 服务已启动(dev 开发请先运行 npm run dev:api)`);`src/shared/error.ts:62` 与 `:76-82`(`LOCAL_API_DOWN` 不归类,原样透出到 toast) | 生产(Electron 打包)形态下用户/作者看到 `npm run dev:api` 这类开发者指令;与仓内既有纪律(提交 `e8b94787` 记 P3-18「去开发者指令」)不一致 | 按 `import.meta.env.DEV` 分形态给文案 | 高 |
| W-10 | P3 | 事件静默丢弃 | `src/composables/useSse.ts:374-388`(`:385-387` 非 JSON 静默丢弃;`:380-384` `sync` 双派发 chat+workbench) | SSE 帧解析失败/未知 type 对作者不可见(无计数、无降级信号),长任务进度丢失只能靠看门狗事后补救(20s+ 心跳窗) | 解析失败计入连接级计数并在状态条可见 | 高 |
| W-11 | P3 | 资源释放 fire-and-forget | `src/composables/useHeartbeat.ts:87-108`、`:118-120`(`onUnmounted(() => void leave())`) | 页面销毁时 DELETE 心跳可能未发出(注释自认靠服务端过期回收)→ 同书标签页名额延迟释放,第 6 窗吃 429 指引(`useSse.ts:248-251`) | 离书/关窗路径改为 `__clwFlushBeforeClose` 内 await | 中高 |
| W-12 | P3 | 上限不生效(取舍) | `src/stores/doc.ts:143-150`(evictLRU 跳过 active/dirty/conflict/saving) | 同时保持 20+ 脏文档时 Map 无上界(理论峰值 = 打开的脏档数 ×全文),长时间会话内存无收口;正确性优先于内存,属设计取舍 | 保留现状,但在文档/状态条给「已打开 N 档」可见面 | 中 |
| W-13 | P3 | 标称与实质 | `src/components/ui/BetaBadge.vue:2`(纯 `<span title="实验性功能,体验中">`);挂点 15+:Ribbon `:90/100/109/118`、SettingsModal `:208/211/218`、SettingsAi `:32/43`、SettingsAnalysis `:157/168/192`、SettingsBookAnalysis `:497/535/610`、ChatDock `:75/81`、ReviewPanel `:168`、StyleBaselineCard `:181`、StyleAcceptancePanel `:98`、WbDraftCard `:57`、RelationsView `:28`、OnboardView `:227`、EditorDocHead `:297`、ModelEffortBar `:51` | 「Beta 名副其实」在代码里**没有任何判据面**:无实验开关、无数据/计费披露、无回退路径,只有一条 title 文案;且 1.0 主面(AI 对话/AI 写作/服务提供方)也标 Beta → 标签语义漂白,无法据此分辨成熟度 | 明确 Beta 判据(版本化开关 or 披露说明),或按成熟度收敛挂点 | 高 |
| W-14 | P3 | 测试守护面薄 | `src/views/OverviewView.vue:253-345`(热力补零 + 继续写作 + 降级提示行)对照 `test/studio/webnext/dom/overview-fail-fast.test.ts`(180 行,只覆盖「主请求失败即止」);`src/pages/Library.vue:132` 等对照 `dom/library-recent-context-menu.test.ts`(79)/`dom/ribbon-library-management.test.ts`(59) | 834 行视图的热力图日历补零、`continueWriting` 三重复检路径、降级提示行无直测;442 行 Library 页仅 2 个小档(档名级证据,非覆盖率证据) | 按 W-14 清单补最小行为用例(热力跨月/跨 DST 补零、树未命中重拉分支) | 中 |
| W-15 | P3 | 遗留路径/可读性 | `src/composables/useBookSwitchGuard.ts:334-346`(注释自认「该路径的 prevBook 近乎恒为 ''…此守卫是时代留下的防御,未证死」) | 同一「切书守卫」存在两套语义(precommit / committed),其中一套自认近乎死路径,增加改动时的判定负担 | 补一条判定实验或删除;删除前先证死 | 高 |

## B 实现完成度(按视图/模块 + 证据)

**总体**:255 档全部为真实实现,**未发现空壳/占位式「名不副实」模块**;抽查到的每个模块都有对应的可观察行为与回归档。

- **编辑器集成(完成度高)**。`editor/CmHost.vue`(660 行,script 633):@ 触发补全(`:118-132`)、Cmd+I 手动触发、5min TTL 补拉与单飞(`:469-493`)、组合态守卫与「挂起外部替换」(`:247-292`、`:320-434`)、选区映射抽 `editor/external-replace.ts`(`:339-372`)、undo/redo 两步真重置(`:363-398`)、剪贴板失败上屏不删选区(`:536-556`)。编排侧 `views/EditorView.vue`(472):回写走 200ms 尾随节流(`:117-121`)、切档 `flush:'sync'`(`:128-132`)、标题编辑守卫(`:156-169`)、挂载/卸载成对注册注销(`:301-323`)。兜底链齐全:`shared/body-writeback.ts`(不变量 1/2/2b/2c/3,`:9-28`)、`shared/dirty-mirror.ts`(节流分档 + baseRev 时效门 + 属主精确清扫)、`shared/save-limits.ts`(预检 + 文案单源)、`stores/doc.ts:775-778`(关窗冲刷契约 _clwFlushBeforeClose)。
- **状态管理(成熟)**。`stores/doc.ts`(822 行):乐观锁(`expectedRevision`+`operationId`+`origin`)、LRU(:143-150)、双代守卫(bookGen/bookKindGen)、在途 opens/saves 台账 + identity 删键(:178/337)、404 与身份复检清理(:406-426)、冲突两条出路(:439-510)、`syncCleanWithTree` 双窗口复检(:600-646)、`flushDirty` 有界轮次防活锁(:686-752)。`stores/workspace.ts`(766 行):书级 prefs 500ms 窗 + 409 补丁恢复 + 号未知重拉对齐(`:194-356`)、legacy localStorage 迁移(`:87-131`)、book.yaml 读单源与失效(`:567-573`)。`stores/prefs.ts`(271 行)已是编排壳:表驱动键面 + 单飞链 + 409 恢复 + 跨窗刷新,逻辑落 `shared/prefs-rows.ts`/`shared/prefs-persist.ts`。
- **API 层(完备)**。`api/client.ts`(385 行):boot 5s×3 指数退避(`:26-63`)、token 注入与「一渲染进程一枚」显式约束(`:5-9`)、401/403 防抖 re-boot + **幂等面显式声明**才重放(`:118-121`、`:154-177`)、超时计时在恢复期暂停/重启(`:106-109`、`:278-292`)、外部 signal 联动与 settle 后摘监听(`:293-301`、`:379-384`)、坏体/裸字面量/204 三态防御(`:337-371`)、abort 归类单源(`:241-246`)、书会话信号接驳与接驳面收窄说明(`:207-239`)。测试注入点显式(`__testHooks.sleep`)。
- **SSE / 长任务进度(实现度高)**。`composables/useSse.ts`(439 行):一次性 ticket 换票(5s 超时,`:84-129`)、fail-closed 立即接管 + 首档 0ms + 指数退避封顶 60s(`:337-365`)、429 探测用 HEAD 不建流(`:198-280`)、dev 双基址失配连记(`:252-272`)、401 自愈空转截断(`:174-196`)、连接纪元状态单点复位(`:44-77`、`:161-164`)。`useSseSelfHeal.ts:28-47`:半开连接看门狗(心跳连败 ≥2 且 SSE still connected → resync)+ 主进程 `desktop:server-restarted` 广播重连。`useHeartbeat.ts:38-85`:20s 拍 + 10s 超时 + **传输层与业务层分离**(有响应即在线,业务 4xx 不计离线)。事件侧 `stores/chat-dispatch.ts`(508 行)是零 pinia 依赖状态机,含单条消息码点闸与工具入参字段级截断(`:80-167`)。
- **视图/页面(齐全)**。8 视图 + 4 页面全部在册并接线(`pages/Book.vue:60-77`);切书用 `:key=bookName` 强制重建并写明理由(`:64-75`);`pages/Welcome.vue`/`Shelf.vue`/`Library.vue` 与 `views/*` 均有对应行为档。
- **「Beta 是否名副其实」**:见 W-13——**代码里无判据面**,只有一条装饰标签;无法用源码证据支持「Beta = 有实验边界/披露」的宣称。
- **测试守护面(强,但无覆盖率数字)**。`test/studio/webnext` 301 档,与源密集呼应:doc 17 档、client 6 档、sse 9 档、`cm-*` 8 档、chapter-tree 6 档、book-switch 5 档、prefs 12 档、settings 14 档、workbench 12 档、dirty-mirror(496 行)、editor-body-writeback(327)、focus-mode(468)、workspace(844)。**禁用 coverage**,故只作档名级映射;偏薄面与疑似零直测面见 W-14 与 D-1。

## C 简洁与优雅度

**量化面**:
- 注释 18%(8,332/46,847);精读档注释率:doc 37%、chat-dispatch 36%、chat 34%、useChapterTreeActions 30%、workspace/CmHost 29%、prefs-rows 28%;纯样式/展示档 5-8%(Welcome 5%、Library 6%、AnalysisPanel 8%)。
- **纪律面零命中**(全 242 档):`as any` / `: any` / `@ts-ignore` / `@ts-expect-error` / `as unknown as` **0 命中**;`watch(..., { deep: true })` **0 命中**。
- **全 120 个 `.vue`**:v-for **93/93** 在元素属性块内检出 `:key`(窗口 = v-for 行起 4 行);`addEventListener` 与 `removeEventListener` 计数**无一档失衡**(0);`setInterval/clearInterval`、`requestAnimationFrame/cancelAnimationFrame` 同(0)。全库仅 15 档出现 `console.*`(共 21 处,其中 6 处为 dev 诊断/降级留痕)——「内存泄漏/error 静默」两类常规重灾区在本域基本被纪律关掉。
- **结构分层**:守卫样板收成 40 行 `useStaleGuard`(五原语 + 注释)、145 行 `useScopedAction`(stillIn/failScoped + 在途锁 + `useBookActionRunner` 执行器);纯逻辑外抽 `shared/*`(dirty-mirror/body-writeback/prefs-persist/prefs-rows/book-config-cache/cross-window/after-paint);store 只留编排。抽取点普遍写明「为什么独立 + 不变量 + 时序纪律」(如 `useAutosave.ts:1-13`、`useBookSwitchGuard.ts:1-22`),可读性方向正确。
- **超大组件实质核查**:`OverviewView.vue` 834 行中 style 430(52%)、template 170、script 234;`WorkbenchView` 606(style 133/script 369);`CmHost` 660(script 633,含主题与扩展装配表);`SettingsBookAnalysis` 673(script 470)。→ 任务书点名的「802 行超大组件」主要体量是**样式与 a11y 实现**,**职责混杂不成立**;真正偏大的 script 仅:SettingsBookAnalysis 470、WorkbenchView 369、ContextMenu 352(其中键盘 roving/飞出层 ~200 行)、AiServicePanel 340。
- **重复逻辑**:未发现复制粘贴型重复;同类样板已收单源(api 层 55 处 `{method,json}`、`clipByCodePoints`、`formatWanZi`、`issue-keys`、`render-cap`)。要「更简洁」的可行面:OverviewView 模板三段(hero/热力/伏笔)仍内联(已抽 3 档子件),`useBookSwitchGuard` 的 committed 防御路径可删(W-15)。
- **可读性成本(反向)**:18% 的注释多为 2-6 行长句叙事(抽取动机/时序推演/历史裁决),单档首读成本高;注释纪律「不写来历」下虽已尽量只留不变量,但仍偏长。建议后续把「为什么这么改」类叙事压成一句 + 指向决策记录,把不变量留在原位。

## D 无法判断项及原因

1. **覆盖率与「哪些交互零测试」的精确面**:任务书禁止跑全量与 coverage(16GB 内存风险)→ 只能做档名级映射,无法给行级/分支级结论;W-14 的「守护面薄」与「疑似零直测档」(`shared/cross-window.ts`、`shared/after-paint.ts`、`shared/doc-freshness.ts`——档名无匹配)均为**弱证据**。
2. **超大档运行时性能**:大列表渲染/频繁重渲染/200ms 窗口 CPU 峰值均未实测(禁跑测试与构建)。另:`stores/doc.ts:213/458/500/548/567/622` 六处对全文调 `sha256Revision`,MB 级文档每次打开/保存/刷新各多一遍全文处理——**未读 `shared/revision.ts`**,不知是否走异步 `crypto.subtle`,故不判为缺陷。
3. **多窗口/多实例真实语义**:`shared/cross-window.ts` 全档未读,桌面桥(`window.clwritingDesktop`)契约在渲染层只可见签名;跨窗失效广播、单实例锁、`desktop:server-restarted` 的实际交付无法在本域闭合。
4. **任务书口径与实测不符**:任务书称「256 个入库代码文件 ≈61k 行」,实测 255 档 48,627 行(`*.ts+*.vue` 242 档 46,847 行),差 ~12k 行。未判断差异来自统计范围(是否含 `test/studio/webnext` 的 301 档)还是计数方式;本报告一律以实测为准。
5. **未精读面仍在**:见 §0 声明(api/ 23 档、components/ui 50 档、components/panels 21 档、composables 22 档、views 6 档、pages 4 档未逐行)。本报告的问题密度不代表其余目录的问题密度。
6. **跨域契约**:SSE ticket 时效/心跳过期/429 名额属服务端语义,本域只能核前端口径是否自洽(已核:换票失败并入既有退避、不另造重试体系)。
7. **UI 视觉与真机交互**(拖拽、DPI、双平台字体回落)无运行时验证手段:e2e 未跑(禁跑全量),故 `ContextMenu` 夹边(W-08)、`FontPicker` 浮层等只作静态判定。