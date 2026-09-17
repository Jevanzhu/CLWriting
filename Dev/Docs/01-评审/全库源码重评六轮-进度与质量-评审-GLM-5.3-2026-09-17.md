# 全库源码重评六轮——进度与质量

- 日期：2026-09-17（纯评审落盘，L0 零代码改动）。
- 作者指令：「忽略现有的评审文档，重新评审一遍项目源代码代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。」（同三轮/四轮/五轮口径，忽略 01-评审/ 既有报告与 Archive 评审正本，独立结论）
- 执行模型：GLM-5.3（主审）。子代理七路与主审同模型（GLM-5.3），不另列。
- 基线：`add7caa5`（CI 复验修复批），工作树净。〔记档：评审启动时树上挂该批未提交态（6 测试文件 + dead-pid helper），评审进行中 09:14 由并行会话随作者指令「提交」入库——本评审对象与该批终态为同一树内容，无评审错拍。〕
- 覆盖：**两波七路文件互斥只读子代理**（R1 服务端 / R2 前端 / R3 AI 链路 / R4 核心数据面 / R5 桌面与基础设施 / R6 测试工程 / R7 构建与治理，单波 ≤4 遵派发上限）+ 主审亲跑 L2 九门 + 主审亲验（P3 抽验 / 安全链第一手对码 / README 横切声明抽查 / CLAUDE.md 跟踪态钉死 / 阶段 24 锚点对码 / 台账 §三 全量交叉去重三分类）。
- 判定摘要：**P1×0 / P2×0 / P3×13（全新 9 + 在册重证 2 + 处置邻角 2）/ nano×15**。连续第三轮 P1/P2 双零（四轮 P2×1→五轮 P2×5〔处置后复归零〕→六轮 P2×0），发现面收敛至 P3/nano 尾巴。
- 结论：**进度 ≈96%（子代理独立口径均值 ≈95% 并列披露）/ 质量 = 高（A− 维持，七域 8.6–9.2 分、均 ≈9.0）**。详见 §五/§六。

## 一、范围与方法

- 规模盘点：src 24 域 533 文件 ≈121k 行（studio 两包占 76%：server 61 件 14,091 行 + web-next 206 件 39,803 行）；test 1180 vitest 文件 + 33 e2e spec，测试树 177,861 行。
- 七路代理文件互斥、全部只读、全部忽略既有评审文档；R1 对 61 文件**全覆盖精读**（非抽样），R2–R5 精读承重件 + 抽样对读，R6 分层抽样（含 12–15 文件精读 + 全树 grep 统计），R7 配置/CI/脚本全量 + README 声明逐条对码。
- 主审亲验清单（逐条对码属实）：R4-P3 finalize 前置容错读（finalize.ts:93/:367-374 vs 锁内 :158-161）/ R2-P3 prefs 防抖句柄（prefs.ts:408-419 fire 不清句柄 + :465 守卫语义漂移）/ R3-P3×2（anthropic-adapter.ts:483 裸 toErrorEvent 无 usage 通道；calls.ts:676/683 文案硬编码）/ R5-P3 prepared 纪律（check/runner.ts:161/:369 裸 prepare vs events/store.ts:120 WeakMap 单源）/ R7-P3 CLAUDE.md 悬空（.gitignore 私有备忘段忽略 + `git ls-files` 空 + c37ab1e7 2026-06-26 显式 untrack + 本地 CLAUDE.md 测试分层节无命名纪律条，四证闭合）。
- 安全链第一手对码（index.ts:150-470）：Host 精确回环匹配（含端口三形态）、apiPathname WHATWG 归一化（点段/`%2e%2e` 历史绕过已修）、GET 令牌闸豁免面仅 `/api/boot` + SSE（query 通道 S7 已收窄到豁免路径）、`/API/` 大写与裸 `/api` 兜 404 不落 SPA、timingSafeEqual 常时比较——R1「安全链闭环无洞」结论主审坐实。
- README 横切声明抽查（三面亲测 + R7 六面对码全过）：src/ai 零 spawn（spawn 面仅 desktop 字体链 + git/exec.ts 预期面）；事件库 INSERT-only 形态；api_key 不进 git（.env* 忽略 + ls-files 无泄漏）；测试数 1180/7403 由 check:counts 门锚。

## 二、质量门实录（L2 九门，主审亲跑，2026-09-17 09:16–09:22）

| 门 | 结果 | 实测 |
|---|---|---|
| tsc --noEmit | ✅ 0 错 | 4s |
| vue-tsc（web-next） | ✅ 0 错 | 4s |
| eslint --max-warnings 0 | ✅ 0/0 | 5s |
| check:counts | ✅ 过 | 1180 文件 / 7403 过账实一致，57s |
| check:packaging | ✅ 过 | <1s |
| check:knowledge | ✅ 过 | <1s |
| vitest 全量 | ✅ **一次全绿** | 1180 文件 = 7403 过 + 8 跳 0 败，142.28s |
| e2e（Playwright） | ✅ | 51 过 + 3 跳（release 门后 3 例），39.0s |
| soak 五段 | ✅ 5 OK | 最大增长 0.31MB（service save 链），上界 24MB |

与 `add7caa5` 批自报数字逐位一致（该批自报 7403 过 + 8 跳 / 51+3 跳 / soak 最大 0.31MB）。

## 三、发现清单（P3×13 + nano×15；P1×0 / P2×0）

> 三分类：【新】本轮独立新发现 /【在册重证】台账 §三 既有行重证（量化更新）/【邻角】既有处置批的邻位缺口。主审亲验标注〔✓亲验〕。

### 服务端（R1）

1. **[P3]【在册重证】/settings 缓存 MISS 是同步全书扫描，未随全域 async 范式迁移**——settings.ts:133-139（computeSync 无 computeAsync）+ :317/:446/:469 同步递归；同域 search/foreshadows/rhythm/progress/overview 均已落 async 孪生（rhythm.ts:145-150 先例）。台账 B 域「settings GET MISS 全同步扫描（唯一无 async 孪生书键端点）」行重证，处置建议照 rhythm 模式补 computeAsync。
2. **[P3]【邻角】rag build 缺 orchestrationBusyFor 预检，与 rebuild 口径不对称**——rag.ts:291（rebuild 有）vs :261（build 无）；现行无实害（build 只增行 + 自带 'rag-build' 闸），系 2026-09-15 机械批补 rebuild 时的邻角。修法 = build 入口补同款 409 预检一行。

### 前端 web-next（R2）

3. **[P3]【新】prefs/workspace 防抖句柄 fire 后不清空 → 关窗守卫语义漂移：曾保存过的窗每次关窗同值空写**〔✓亲验〕——prefs.ts:408-419（setTimeout 回调执行后不置 `persistTimer = null`）+ :465（`!persistTimer` 作「无待写」判据，注释自称「定时器只在冲刷内清空」恰暴露缺口）；workspace.ts:263-265/:243 同型。影响：每次关窗冗余 PUT global.json → 服务端无条件 bump revision → 其他存活窗下次保存伪 409 +「已在其他窗口被修改」误导 toast（R0914-三轮 P3-8 只消灭了「从未写过」半边）。自愈无数据丢失。修法 = fire 分支末尾置空句柄（勿动 R60-D-1 返回真链 Promise 不变式）。

### AI 链路（R3）

4. **[P3]【新】流中 SDK 异常路径丢已得 usage（三适配器同构缺口）**〔✓亲验（anthropic 臂）〕——anthropic-adapter.ts:481-483 / openai-adapter.ts:548-550 / responses-adapter.ts:562-564：B-12「usage 随错上抛」只覆盖适配器主动 yield 的 error 事件；SDK 直接 throw（mid-stream 连接重置）走 `toErrorEvent(e)` 无 usage 通道，message_start/latestUsage 闭包已得值丢弃，该次真实消耗在终态失败路径记 0。窗口窄（usage 多随流末下发）。修法 = makeToErrorEvent 加可选 usage 参数，三线 catch 分支带上闭包值。
5. **[P3]【新】checkAiTaskCallBudget 文案硬编码 chat 语义**〔✓亲验〕——calls.ts:676/:683：签名通用（task, limit）但 reason 写死「chat 调用上限 / 本书对话 / budget.chat_max_calls」；当前唯一调用方恒传 'chat' 无实害，复用即文案失真。修法 = 文案参数化或更名 checkChatCallBudget。

### 核心数据面（R4）

6. **[P3]【新】finalize 前置查路径用容错读——清单瞬态读失败误报 NOT_FOUND**〔✓亲验〕——finalize.ts:93（lookupRelPath）→ :367-374（catch 一律归 null）+ manifest.ts:105-119（readManifestDegraded 已在库但未用此处）；与同文件 R48-5（读盘失败转 WRITE_ERROR 可重试）及锁内 readManifestStrict（:158-161）纪律不一致。无数据损失、重试自愈。修法 = lookupRelPath 改走 readManifestDegraded，degraded 非空返 WRITE_ERROR。

### 桌面与基础设施（R5）

7. **[P3]【新】SQLite prepared 语句缓存纪律三域不一致**〔✓亲验〕——events/store.ts:120-142 与 rag/store.ts:284-313 逐字同构双份（preparedByDb WeakMap + close 配对），check 域无缓存裸用；ephemeron 环类 bug（R0911-G-P3-4 族）历史已需两处各修一遍。修法 = 抽 shared/sqlite-prepared.ts 单源三域收编（测试面以 r0911-g-p3-4 结构契约为锚）。
8. **[P3]【新】机检热路径 SQL 每次 runAllChecks 重编译**〔✓亲验〕——check/runner.ts:161-163（growthIds）与 :369-374（lead_history JOIN）裸 db.prepare，树红点聚合数百章即数百次重编译同一 SQL；µs 级量级，与 7 同批收编即可。
9. **[P3]【新】onRestartExhausted 缺省 'quit' 无实际退出动作（降级态）**——server-manager.ts:404-417：无接线时回落 quit 语义但 deps 无 quit 钩子，进程停在「无 server、无提示」态（注释自认兜底形态）；生产 main.ts:194-213 已接线。修法 = 缺省臂补一条 logger.error 显式告知 API 永久不可用。

### 测试工程（R6）

10. **[P3]【在册重证】批次号前缀测试文件存量未收敛**——r\d{4}- 前缀文件实测 **92 个**（r0912 单批 55）+ 测试体内批次锚注 593 处 + src 注释反向引用文件名（settings.ts:87/101/167-168、overview.ts:68 等）；2026-09-16 命名纪律生效后新文件已全行为命名（仅 1 漏网）。台账 G 域「~540+/1181 轮次号命名」行重证（该口径含更宽命名形态；本轮钉死 r 前缀文件数 92）。修法 = 机械重命名批随批改指 src 注释引用。
11. **[P3]【在册重证】bootStudio 收编尾部 50 文件仍手写 startServerSafe 启动段**——r29-server-rag-error-redact.test.ts:33 等 50 文件（2026-09-12 收编 119 文件后的存量尾）。台账 G 域「~118 个 server-boot 手写样板」行重证（118→50 收敛中）。修法 = 仿临时目录收敛批机械换装。

### 构建与治理（R7）

12. **[P3]【邻角】tsup onSuccess copyFileSync 仍 cwd 相对——同批口径修复只修了 rmSync 半边**〔✓亲验（tsup.config.ts:73 直读）〕——文件头 R0916-6-P3-10 专门绝对化 rmSync 并写明理由，copyFileSync('node_modules/...','dist/desktop/fontlist') 同场景 ENOENT 红构建或拷错位（fail-closed 方向、正常根路径零差）。修法 = 两端同款 fileURLToPath(new URL(...)) 绝对化。
13. **[P3]【新】CLAUDE.md/AGENTS.md 单机化 + README「测试命名纪律入 CLAUDE.md」声称悬空**〔✓亲验四证闭合〕——.gitignore「项目级私有备忘」段忽略三件；git ls-files 空（c37ab1e7 2026-06-26 显式 untrack）；HEAD 无此路径；本地 CLAUDE.md 测试分层节确无命名纪律条，而入库 README:118 声称「测试命名纪律……入 CLAUDE.md 测试分层节」（4ba1de72 win 侧批所加——win 侧本地 CLAUDE.md 的编辑不随 git 同步）。影响：全部工程纪律正本（文档操作链/L0-L2 分层/AI 链守则/派发上限）单机化、重克隆即丢、跨线漂移已实际发生。**需作者拍板**：入库 / 撤回 README 声称 / 或补条目对齐。

### nano×15（择收清单）

R1：快照留底 fail-open（AI 产物）/fail-closed（手改）分诊口径分散三处头注（语义合理，建议 draft-pipeline 单源集中记档一句）；Host 校验不含缺省端口形态（监听非 80 零影响）。R2：跨包引用根 src/shared 四层上溯相对路径（chat.ts:64，建议 tsconfig paths）；图标按钮 aria-label 覆盖不全（241 button / 73 aria-label，基本面中上）。R3：task-gate 端口未注册 fail-open（有意取舍，口径提示）；三线 stopReason 命名未归一（在册维持）。R4：case-probe 崩溃残留探针文件命名不匹配 sweep 清扫模式（fs/case-probe.ts:18-43 vs atomic.ts:344）；migrate-finalized-revision 持清单锁内 git status 最坏 15s > 他方等待 2×5s（档差提示，取舍已记档）。R5：禁词单字判定 UTF-16 口径对增补平面（count-dialogue.ts:80，改 codePointLength === 1）；events latestSession / rag recall 包装 test-only 导出维持两处（自记在案）。R6：界值类计时断言依赖 runner 代际校验（scale.test.ts:50 族，已有处置路径）；test/studio 平铺 205 / webnext 267 单目录偏大（均件 150 行抵消大半）。R7：overrides 注释宣称覆盖 vite 链——vite 8 已无 esbuild 依赖（表述过时）；「coverage 由 CI 三腿矩阵兜底」实跑仅 ubuntu·24 一腿（口径含糊）；electron-smoke.mjs:53-64 注释称「可执行性检查兜」实际未查 mode 位（workflow test -x 已补位）。

## 四、正面对码结论（承重面验证通过项，记档供后续轮免重查）

- **安全链闭环**（R1 全覆盖 + 主审第一手）：Host/Origin/token 三层闸 + pathname 归一化 + SSE 双凭据时序 + 常时比较，未发现绕过路径；全域零 @ts-ignore / 零 eslint-disable / 零散落 console。
- **数据完整性链闭合**（R4）：原子写（tmp+满写+fsync+rename 退避+目录 fsync）→ 五锁族 + 统一锁序 + fail-closed → 非 UTF-8 三层拒绝 → 定稿账本回写→基线次序（ee-P1-4）→ 分层快照/回收站/字节档 → 崩溃恢复闭环；已知残余竞态全有注释记档与自愈路径。
- **前端竞态防护体系**（R2）：useStaleGuard 代数守卫全库统一、切书三段守卫、await 窗口身份复检、IME 挂起、SSE 退避换票；15 主流程全接线无悬空 UI。
- **AI 链路铁律落地**（R3）：「模型可见⟺已记录」四通道 + CLW_VERIFY_VISIBLE 抽样校验；参数四层显式 resolve；预算三口径 fail-closed；12 任务族全覆盖。
- **测试工程化**（R6）：spec-order 三层防线、coverage 成对承重、check-counts 元门（no-only/no-skip/零断言文件机器拦截）、200 万字规模基准在库（rag scale.test 700 章×2850 字真实 buildIndex 路径）。
- **README 横切声明**（R7 六面 + 主审三面）：全数对码成立，无一失实（除 §三-13 CLAUDE.md 声称悬空这一处）。

## 五、进度结论：综合 ≈96%

| 域 | 代理 | 完成度 | 质量分 |
|---|---|---|---|
| 服务端（studio/server，61 件全覆盖精读） | R1 | 95% | 9.2 |
| 前端（web-next，206 件） | R2 | 97% | 9.1 |
| AI 链路（ai+driver+process，104 件） | R3 | 95% | 9.1 |
| 核心数据面（document/format/install/git/fs/state/cache/shared，87 件） | R4 | 96% | 9.1 |
| 桌面与基础设施（desktop/events/check/review/rag/export/log/metrics/knowledge/learn，≈72 件） | R5 | 92% | 8.6 |
| 测试工程（1180+33 spec，177,861 行） | R6 | 93% | 9.0 |
| 构建与治理（双包/CI/脚本/纪律文件） | R7 | 95% | 9.0 |

- **子代理独立口径均值 ≈95%（94.7%）**，主审综合 **≈96%**（口径差：主审把「功能全量收口 + 门全绿」计满，把治理尾巴〔CLAUDE.md 单机化、win CI 腿待实跑、化石命名存量〕与知识层留白计余量）。
- 功能面：总览 24/24 阶段全收口（阶段 24 锚点 fm `序`/`并入` 主审对码在库——format/chapters.ts:21 KNOWN_FM_KEYS + chapter-lookup.ts:116）；README 产品流「建书→设定→正文→全自动写章→三审→定稿→导出 + 伏笔/字数/文风/改写分析/对话助手」前端 15 主流程全接线（R2 逐一核实到端点）、服务端无一处 stub/半成品（R1 全覆盖结论）、AI 12 任务族全覆盖（R3）。src 全域 TODO/FIXME 实测仅 5 处且全为锚注/模板字符串；「卷复盘」等未建功能在 UI 文案与注释如实披露。
- 余量清单（≈4%）：① win 腿 check:counts 预期 7339 待 CI 实跑核对（README 自挂账，2026-09-17 main CI 首跑六腿红四类根因已修、复验在途）——RC 发布前最后一道实跑验证点；② 知识层方法论注入未接线（设计留白待拍板，台账 §三 F）；③ 卷复盘产品语义待拍板（端点单立随拍板）；④ e2e 长尾 4 旅程已对码处置/维持；⑤ 治理尾巴（§三-10/11/13）。
- 对比前轮：四轮 ≈98% / 五轮 ≈97%（子代理 92%）→ 六轮 ≈96%（子代理 95%）。口径逐年收紧（本轮把治理面余量独立量化），**功能完成度无回退**——三轮零 P1/P2、七路代理零功能缺失发现。

## 六、质量结论：高（A− 维持）

- 依据：① L2 九门主审亲跑一次全绿（§二）；② 连续第三轮 P1×0，本轮 P2×0——发现面收敛至 P3×13/nano×15 且全为一致性/卫生/留痕类，无一涉正确性主链；③ 七域质量分 8.6–9.2（均 ≈9.0），承重域（数据面 9.1/服务端 9.2/前端 9.1）为无框架项目罕见密度：单源纪律、方向锁治理门、代数守卫、注释可考古性（每处设计决策带轮次溯源）；④ 测试网密度对「200 万字不崩」承诺有直接基准（规模测试 + soak 五段 + 治理八门 + 元门）。
- 扣分项：桌面/基础设施域 8.6（prepared 纪律分裂三域、同步孪生双实现维护面、注释密度接近代码体量的认知负担）；治理域纪律文件单机化（§三-13）；测试化石命名与样板尾部（§三-10/11）。
- 维持 A− 不上调的理由：上述扣分项均为可收敛债而非结构缺陷，但 CLAUDE.md 单机化属治理链断点（跨线漂移已实际发生一处），收敛前不上调。

## 七、处置建议（优先级排序，供作者拍板「全部修复/择收」）

1. **§三-13（需拍板）**：CLAUDE.md/AGENTS.md 入库 vs 撤回 README 声称——治理链断点，唯一需作者决策项。
2. **§三-3 prefs 防抖空写**：用户可感知（伪冲突 toast），三行修。
3. **§三-6 finalize 错误信封**：对齐 WRITE_ERROR 纪律，小修。
4. **§三-4 三适配器 usage 通道**：计费面，单点工厂改三线受益。
5. **§三-7+8 prepared 单源收编**：一次收编两 P3（check 域顺带补缓存），以 r0911-g-p3-4 契约为锚。
6. **机械批**：§三-1（settings async 孪生）/ §三-2 与 §三-12（各一行/一处绝对化）/ §三-5（文案参数化）/ §三-9（一行留痕）。
7. **渐进项**：§三-10/11（化石命名 + 样板尾部，随域触达；台账行已量化更新）。
8. **nano×15**：择收（codePointLength/探针命名/sweep 模式三件成本低顺手；余维持登记）。

## 八、评审过程记档

- 编排：两波七路（波 1 = R1/R2/R3/R4，波 2 = R5/R6/R7——R4 回收后即补 R5 保持 ≤4 在途；无撞限额阵亡）。
- 主审自纠一处如实记档：R7-P3-13 初验时误读合并 shell 输出（check-ignore 的回显行误作 ls-files 输出）判「已跟踪」，复验 `git ls-files CLAUDE.md` 为空 + `git show HEAD:CLAUDE.md` fatal + c37ab1e7 revert 记录四证钉死「未跟踪」，R7 结论无误。
- 台账 §三 去重：13 条 P3 三分类如 §三标注（新 9 / 在册重证 2 / 邻角 2），无与在册未处置行重复开行项。

## 九、处置记（2026-09-17 六轮重评修复批；作者指令「全部修复。」）

> 处置执行者 = 主审（本报告作者），零子代理（作者指令「关掉子agent，全部你自己跑！」）。基线 = 报告基线 `add7caa5`。

### P3×13（全数落库）

| 编号 | 处置 | 落点 |
| --- | --- | --- |
| P3-1 | settings GET 缓存补 async 孪生（`settingsLongAsync` = `yieldToEventLoop` 前后包夹同步计算体，computeAsync 挂既有 `createTtlProbeCache` 选项；handler 转 async 走 `getSettingsCachedAsync`；缓存命中/失效/探针签名语义逐位不变） | `studio/server/api/settings.ts` |
| P3-2 | rag build 入口补 `orchestrationBusyFor` 409 预检，与 rebuild 口径对称（`rag-build` 自带闸保留） | `studio/server/api/rag.ts` |
| P3-3 | prefs / workspace 防抖 fire 分支起始置空句柄（`persistTimer = null` / `debounceTimer = null`）；`flushPendingPersist` 的「无待写」守卫语义随之成立，曾保存过的窗关窗不再同值空写；R60-D-1「返回真链 Promise」不变式不动；workspace 侧无在途跟踪面按已知边界记档 | `stores/prefs.ts` · `stores/workspace.ts` |
| P3-4 | 三适配器流中 SDK throw 补 usage 通道：`makeToErrorEvent(e, usage?)` 可选参 + 三线 catch 带闭包值；anthropic 累加器本在流作用域直取，openai / responses 的累加器在 attempt 循环内故以逐 attempt 重绑的 `errorUsageOf` 桥接；`consumedAny` 闸保证「未消费 ⇒ 不伪造 usage」；估值路径标 `estimated: true`，真值直通不带标 | `provider/adapter-errors.ts` + 三适配器 |
| P3-5 | `checkAiTaskCallBudget` 文案参数化（`taskLabel` / `configKey` / `taskNoun` / `rateHint` 四参带缺省，缺省输出逐字节不变） | `ai/calls.ts` |
| P3-6 | finalize 前置查路径改走 `readManifestDegraded`：degraded 非空返 `WRITE_ERROR`（可重试），合法空清单仍归 `NOT_FOUND`——与同文件 R48-5 及锁内 `readManifestStrict` 纪律对齐 | `document/finalize.ts` |
| P3-7 | 新件 `src/shared/sqlite-prepared.ts` 作连接级 prepared 缓存单源（`prepared` / `closeWithPrepared`），events / rag / check 三域 close 助手改薄委托——ephemeron 环类 bug 从此一处修三域受益；三域结构契约测试重锚至 `closeWithPrepared` + 包装委托（未删例） | `shared/sqlite-prepared.ts` + 三域 store |
| P3-8 | 机检热路径两处固定 SQL 改走 `prepared(db, sql)` 连接级缓存（变体维度仅有界 enabledTypes 组合） | `check/runner.ts` |
| P3-9 | server-manager 崩溃封顶降级态补 `quitFallback` 显式留痕：无决断钩子 / 决断非 restart / 决断链 reject 三臂统一 `logger.error` 告知「本地 API 永久不可用，请重启应用」 | `desktop/server-manager.ts` |
| P3-10 | （在册渐进项）批次号化石层量化更新——r 前缀文件实测 92；纪律已落 CLAUDE.md，维持渐进不改名 | 台账 §三 G |
| P3-11 | （在册渐进项）bootStudio 尾部实测 50 文件，维持随批换装 | 台账 §三 G |
| P3-12 | tsup `onSuccess` 的 `copyFileSync` 两端 `fileURLToPath(new URL(...))` 绝对化（上批只绝对化 rmSync 半边） | `tsup.config.ts` |
| P3-13 | CLAUDE.md 测试分层节补测试命名纪律条（README:118 声称从此落地；AGENTS.md 系 CLAUDE.md 软链，一处即两处） | `CLAUDE.md` |

### nano×15（修·注记 11 + 维持 4）

- **修·注记**：① 禁词单字判定改 `codePointLength === 1`（增补平面单字不再误入红边命中）；② case-probe 探针名改 `.clw-case-probe.<pid>.<uuid>.tmp`，崩溃残留从此命中 `atomic.ts` 的 `ABANDONED_TMP_RE`；③ 快照分诊口径由三处头注收进 `draft-pipeline` 单源集中记档；④ migrate-finalized 锁内 git status 最坏 15s > 他方 2×5s 等待的档差记正；⑤ task-gate 端口未注册 fail-open 注记；⑥ `package.json` `//overrides` 射程按实况收紧（前端子包 vite 8 无 esbuild 依赖）；⑦ CLAUDE.md / AGENTS.md「coverage 由 CI 三腿矩阵」改实况口径（ci.yml:138 实挂 ubuntu·24 单腿）；⑧ electron-smoke 头注「可执行性检查」改「存在性/可访问性检查」，指明位检查由 workflow `test -x` 补位。
- **维持 4**：三线 stopReason 命名未归一 / 图标按钮 aria-label 覆盖 / `chat.ts` 跨包相对路径（tsconfig paths 改造面大于收益）/ 92 个 r 前缀化石文件（渐进改名）。

### 质量门（L2 九门，mac 亲跑，一次全绿）

vitest **1184 文件 = 7425 过 + 8 跳 0 败**（代码面全绿 157.35s + 文档回填后终树兜底复跑一次全绿 172.78s（两次计数逐位一致 1184/7425/8））+ tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check 过（counts 1184 / 7425 / 33 / 54 账实一致）+ e2e 51 过 3 跳（38.1s）+ soak 五段 5 OK（最大增长 0.31MB，上界 24MB）。

### 测试账

1180→1184 文件 / 7403→7425 过（净 +4 文件/+22 用例）：新行为命名测试 4 件 19 例（`stream-error-usage` 8 / `finalize-manifest-degraded` 3 / `prefs-debounce-fire-clears-handle` 3 / `task-call-budget-labels` 5）+ 既有结构契约 3 件随单源收编各扩 1 例；**零用例删除**。差值锚 64 维持。README 四处徽章/门槛数字同步修账。

### 批内自纠如实记档

① `calls.ts` 首版文案参数化漏带 `taskNoun` / `rateHint` 两个缺省参，致缺省字符串失真（「如需恢复对话」→「如需恢复」等）——补参后以 5 例钉值复验逐字节一致；② 新件 `prefs-debounce-fire-clears-handle.test.ts` 的 `resolvePut` 用裸 `let` 持有，被 TS 控制流分析窄化成 `never`，`vue-tsc` 报 TS2349——改对象属性持有后清零。

### 文档链同步

台账 §一 首行状态翻转「在暂存·已处置待归档」+ 行尾处置记；台账 §三 B 域 settings 行销案、G 域批次号化石行量化更新 + 服务端样板尾部在册重证 + 新增 nano 三项登记行；总览 §1.3 该行状态翻转「已处置待归档」；`Dev/Docs/README.md` 计数行注；根 `README.md` 计数修账；`Archive/README.md` 批记行。
