# 重评二轮修复批 · 优雅简洁复核评审

- 日期：2026-09-14。执行模型：GLM-5.3（主审）。
- 复核对象：提交 `d724966d`（fix(review) 全库源码重评二轮落盘批 + 六件修复批，基线 `2f59db89`，20 文件 +692/−73：src 9 改 + test 3 新 3 改 + 根 README + Dev 文档链 3 处 + 报告正本 1 篇）。
- 评审问题（作者指令）：「评审下这个修复，是否足够优雅和简洁。」
- 方法：单波 4 路文件互斥只读复核子代理（R1 服务端修复面 audit/stream/chat-state/snapshots / R2 桌面壳与前端面 main/font-cache/win-fonts/client/MetaFormPanel / R3 测试质量面六测试文件 / R4 文档链记账审计）+ 主审亲验关键发现 4 项。**如实记档：R4 子代理撞账户 RPM 速率限额阵亡，该域（记账审计）由主审亲做完成**（算术核对/README 四行 diff/三行同步/commit message 清单逐项核对）。
- 基线时点：`d724966d` 工作树净。

## 一、判定

**优雅 · 简洁双达标——P1×0 / P2×0 / P3×14（+nano×2）。**

六件修复全部正确闭合、无行为性回归、无超范围改动；P3 全部落在注释精度/测试谱系脆端/覆盖取舍/前科残留/文档时点标记级，无一条影响行为正确性。与谱系对照：优于「复审-0913-合并批」的「优雅达标·简洁有失守（P2×2）」，与「win 合并复核批」的双达标同级且零 P2。

## 二、优雅与简洁的正向证明（四路 + 主审亲验交叉）

1. **六闸单源收编干净彻底**（R1）：六谓词仅存 `chatClearGateReason` helper（audit.ts:209-215），两端 handler 只剩入口首查 + 复查各一对调用，零残留内联；`hasBackgroundTasks` 死导入摘净（stream.ts 0 命中）；helper 选址紧邻 `allHeldTaskGatesFor` 同址，有 R29-9「放本文件导出、stream 引用、不动 task-gate.ts 共享面」先例注记支撑；audit↔stream 循环引用系既有方向，本批未新增环。
2. **收编后语义等价成立**（R1）：两端 409 BUSY 不变；旧文案锚点全库穷尽猎杀零命中（三旧变体在 src/test/e2e 全零；「对话进行中」其余锚点全部指向未动的 spawn/auto-write/rewrite/review 端点文案；前端唯一 error 内容分支是 SettingsBookAnalysis「重建索引」无关；e2e 无 chat.clear/audit DELETE 文案断言）——与九门全绿互证。
3. **复查位三项关键语义全部验证**（R1）：audit 复查 return 在 try 内仍走 `finally { store.close() }`；state.ts 拒清分支 close 与引用计数语义（store.ts:514-529 refs 归零才真关库）逐位同义；「内存清空先行系良性」论证成立（在途 runChat 持数组引用续写 + finish.ts:201/239 收尾自愈重插 + 前端/服务端双侧从事件库重投影）——注释说法逐条与实现核对属实。
4. **双标志门正确且完备**（R2）：`acquired` fail-open 语义（app-instance-guard.ts:80-86）与「guard 异常放行 = 旧行为」注释相符；底部 :2011 与顶部 :235 恰为德摩根对偶（「同款」注释准确）；全部生命周期注册（second-instance/whenReady/window-all-closed/三信号/uncaught/unhandled/before-quit/activate）清点全部在门内，无别处漏消费。
5. **GBK 解码链字节级实证闭合**（R2）：硬编码字节经 TextDecoder('gbk') 逐字吻合、严格 fatal UTF-8 实证抛错确走回落；`decodeStdout` 全库唯一注入点 = reg 通道（font-cache.ts:274 fontlist / win-fonts.ts:188 PS 通道均不注入，缺省零变化）；icu 裁剪形态构造器 RangeError 被 try/catch 兜住；混合 ASCII+GBK 全量 fatal 试解判定可靠（误判需全 Buffer 字符同时侥幸，实际不可达量级）。
6. **null 守卫位置与 204 口径成立**（R2）：守卫位于 `!r.ok` 块后 `return body` 前，非 2xx 不误伤；204 空体走 catch → `body={}` → 守卫不命中（测试同锚）；全库 60+ 处 `apiJson<T>` 实例化全为对象/数组形态，只挡 null 属范围对齐评审发现的最小修复。
7. **死三元不可达性成立**（R2）：TAG_FIELDS_BY_KIND 仅 chapter 键、tagFields 对其余全部 kind 返回 []、`v-if="tagFields.length"` 整块不渲染；kind 尚有 7 个活用点非死变量；两处注释互指闭合。
8. **记账全闭合**（R4 主审亲做）：新用例 2+2+3+7=14、1126+3=1129、7255+14=7269、7176+14=7190 逐位吻合；README 恰 4 行改动零超范围、无旧数残留；台账/总览/Dev README 三处均单行改写最小 hunk；commit message 文件清单与 stat 逐项相符；报告 §八 九门数据与实跑日志一致。

## 三、发现明细（P3×14 + nano×2，无 P1/P2）

**R1 服务端面（P3×1）**

- P3-R1-1：state.ts:132-136 拒清分支手写 `store?.close()` + 提前 return，独立于下方 try/finally——gate 检查收进既有 try 可收敛 close 单点并获异常安全。现实 gate 回调不可抛（纯谓词 + readdirSync 已吞错），纯化妆级。
- （邻域观察不计发现：books.ts:247-248 busyGate 仍内联展开而非调 allHeldTaskGatesFor——R75-5 既有形态且闸集不同，不在本批收编范围。）

**R2 桌面/前端面（P3×6）**

- P3-R2-1：client.ts:286-288 注释论证失准——「true/数字/字符串至少可被 typeof 消费」不成立（原始类型上属性访问同样静默得 undefined，与 null 失效同族；解构 null 反而响亮抛 TypeError）。守卫只挡 null 仍是合理的最小修复（T 全为对象/数组形态 + 评审锚定 null），但注释把「选择最小」误述成「其余无害」。
- P3-R2-2（前科沿误）：client.ts:261 `r.status !== 304` 在 `r.ok` 分支内为死条件（fetch 304 ok=false 进错误分支从不返回 {}）——R51-H-1 原注「304 维持空对象口径」失实系前科，本批新注 :288「对齐 204/304 之外的坏体口径」沿用了该表述。
- P3-R2-3：MetaFormPanel.vue:424 `/* 短篇标签（≤2 项）单列展示 */` 注释指向已删概念，且 chapter 恒 5 字段使模板 `tagFields.length <= 2` 绑定与 `.single-col` 规则双侧不可达——本批主题恰是「迁移残留死码清理」且改了紧邻注释，顺手项欠账。
- P3-R2-4（前科）：app-instance-guard.ts:31 接口 JSDoc 仍写「幂等释放（will-quit 调用…）」，生产释放已改由内部 process.once('exit') 钩子承担（2f59db89 批），指针过时。
- P3-R2-5：P2-2 同一修复理由落注 4 处（font-cache 字段注 + 结算点注 + win-fonts 函数头注 + 调用点注），结算点 2 行近乎纯复述可省。
- P3-R2-6：font-cache.ts:258 单行约 166 字符、`Buffer.concat(outParts)` 两分支各拼一次，提局部变量更净（eslint 已过，纯风格）。

**R3 测试质量面（P3×6 + nano×2）**

- P3-R3-1：r0913-r2-main-guard-static 静态锚脆度——整串 toContain 对语义等价重排/抽中间变量会假红；库内静态断言先例 8 处（r0911-g 用 `\s*` 容忍正则较韧，menu-labels/r0913-is-drag-scope 字面 toContain 同级脆度），本件选了谱系较脆档但未越先例边界；头注引 OOM 前科未引静态断言先例。
- P3-R3-2：r0913-r2-clear-gate 三用例未钉「gate 在 openSessionStoreAsync 之后」的时序语义——若回归把 gate 挪到 await 之前（竞态窗口重开），三用例全绿照过；修复核心语义只有代码评审守护。可经 vi.mock events/store 记调用序低成本补钉。
- P3-R3-3：r0913-r2-snapshots-bookmoved 40ms 时序窗归族——「改名先于 body」由事件循环保证（确定性），真正前提是 T=40 前服务端完成 resolveDoc+readVersionRaw（同进程 + service 已烩热，残面 = 进程级停摆 >40ms），与台账 §三 已登记「全 test/ 84 处 sleep 竞态窗（择收方向 = 悬挂窗换可控 Promise 门）」同族，本件未达择收方向。真 HTTP 取舍本身可辩护（restore 入口含 await resolvePathAsync，直调同需等待；零产品钩子代价下的合理解）。
- P3-R3-4：同文件第二用例对对照组的隐式顺序依赖——currentRevision() 对缺文件裸抛 ENOENT（hash.ts:12-14 readFileSync 无容错），`vitest -t` 单筛第二用例炸于 setup；注释自知未消除耦合。
- P3-R3-5：audit DELETE 复查**拒绝臂**零覆盖（新增两用例走入口闸与放行臂），且报告 §八「无竞态注入点可控」记档失实——**主审亲验属实**：`openSessionStoreAsync` 首开经 `acquireCrossProcessLockAsync(sessionMigrateLockPath(...))`（store.ts:592-595），两函数均导出，测试预持 migrate-<hash>.lock 即可确定性悬住 handler 窗口内占 task-gate 再放锁，零产品码改动（r29-server-clear-gates-crossproc 已有 forgeLock 先例）。缺口是**选择而非不可能**，影响低（同源 helper 已被机制测+入口测覆盖）。
- P3-R3-6：decodeRegOutput 第三分支（GBK 解码器不可用兜底 buf.toString('utf8')）未测——可 vi.stubGlobal('TextDecoder') 伪类对 'gbk' 抛错钉之；该臂存活面 = icu 裁剪运行时，非死码。
- nano-1：chat-clear-gates 的 del() 与 post() 除 method 一字外逐行相同约 28 行，参数化 `req(method, path)` 可收敛（库内有 fakeReqRes 三份收编单源先例）。
- nano-2：win-fonts 第三用例内联重写 spawn 假件——runWithRegFallback 的 hklmOut 参数放宽 `string | Buffer`（PassThrough.write 原生收 Buffer）即可复用。
- （覆盖面其余核对无缺口：chat.clear 侧复查拒绝臂由 r0913-r2-clear-gate 用例 1 钉；win-fonts 集成链端到端真钉；api-client 204 防误伤已钉；GBK 字节逐字节复核无误。）

**R4 记账审计（主审亲做，P3×1）**

- P3-R4-1：报告 §五 规模行（test 1126/7255）与余量行（「P2×2/P3×4 待作者处置指令」）未标「评审时点」，与 §八 处置后口径（1129/7269、已处置）并存成报告内部时点歧义（§七 已改「已处置」、§五 未同步口径）。

## 四、处置建议（待作者指令）

- 建议收（低成本高价值）：P3-R3-5（migrate-lock 注入补 audit 复查拒绝臂测试 + 报告 §八记档措辞记正为「选择不测」或径直补测销案）；P3-R2-1/R2-2（client.ts 两处注释记正——含 304 死条件这一前科一并收口）；P3-R4-1（报告 §五 补「评审时点」标记）；P3-R3-2（gate 调用序补钉，vi.mock 一件）。
- 择收：P3-R1-1（close 单点收敛）、P3-R3-3/R3-4（时序窗与顺序依赖，可随台账 §三 sleep 家族择收方向统一处理）、P3-R3-6（兜底臂补测）、P3-R2-3（single-col 死对清理）、nano×2（参数化收敛）。
- 维持（前科，非本批引入）：P3-R2-4（guard JSDoc 指针）；P3-R2-2 的 304 死条件本体（注释口径可随 R2-1 一并记正，死条件移除另议）。
- 本报告落盘即评审完成；**2026-09-14 处置批（作者指令「全部修复。」）已全量处置**（上述「维持」2 项前科亦随批一并收口），处置记 = §五，待归档（「报告完成≠收口」）。

## 五、处置记

2026-09-14 处置批随作者指令「全部修复。」**全量处置 P3×14 + nano×2**（§四「维持」2 项前科一并收口；主审亲修零代理），基线 `d724966d` 工作树净。逐项：

- **P3-R1-1**：state.ts 复查收进 clearBooks 的 try——`store.close()` 单点收敛（拒清分支手写 close 删除），gate 纯谓词异常安全随 try 兜底。
- **P3-R2-1**：client.ts null 守卫注释记正——「其余字面量至少可被 typeof 消费」论证撤回（信封字段消费对一切非对象都静默 undefined，与 null 失效同族），改「守卫锚定本面实测可达的 null 为最小修复、其余裸字面量属理论面维持穿透」。
- **P3-R2-2（前科收口）**：死条件 `r.status !== 304` 移除（304 属 3xx、`Response.ok` 恒假从不进该分支），R51-H-1 注释「仅 204/304 维持空对象口径」记正为「仅 204」。
- **P3-R2-3**：MetaFormPanel single-col 死对清理——模板 `:class` 绑定 + `.single-col` CSS 规则 + 过时注释三处删除（chapter 恒 5 字段双侧不可达）。
- **P3-R2-4（前科收口）**：app-instance-guard.ts `release()` JSDoc 记正——will-quit 指针改 process.once('exit') 内部退出钩子（R0913-win P3-13 批 OOM 改道沿革如实记档）。
- **P3-R2-5/R2-6**：font-cache.ts 结算点 2 行复述注删除（decodeStdout 字段注单源保留）+ `Buffer.concat(outParts)` 提局部变量（约 166 字符长行消除）。
- **P3-R3-1**：r0913-r2-main-guard-static 断言改 `\s*` 容差正则（r0911-g 先例入头注）——语义等价重排/抽中间变量不再假红。
- **P3-R3-2**：r0913-r2-clear-gate 补第 4 用例——全新 ud 无库文件，gate 回调内 `existsSync(dbPath)` 为真即钉「gate 在 openSessionStoreAsync 之后」（复查被挪到 await 前即红）；零 mock 零 timer。
- **P3-R3-3**：snapshots.ts 增产品测试注入口 `__setSnapshotsRestoreYieldForTest`（先例 `__setLearnCommitYieldForTest`，生产 null 零行为差异）+ r0913-r2-snapshots-bookmoved 第二用例重写为钩子停走（parked 信号到手后改名、放行即 409）——40ms 竞态 timer 与悬持 body 机器（flushHeaders/content-length 手法）全数拆除，语义断言面不变（409 BOOK_MOVED / 无幽灵目录 / 内容保旧）。
- **P3-R3-4**：同文件 `currentRevision()` 补缺文件回落 null——`vitest -t` 单筛第二用例不再 ENOENT 炸于 setup，用例顺序无关。
- **P3-R3-5**：新增 `test/studio/r0914-audit-recheck.test.ts` ×2——**真实迁移锁停走窗**（测试预持 `sessionMigrateLockPath` 锁 → handler 悬于 openSessionStoreAsync → 窗口内真占 task-gate → 放锁 → 复查命中 409、事件原样未清；对照组无窗无闸 200 清空）。withRouteTable 直调 handler（r1010b 先例）+ 假 req/res；零 vi.mock、零产品码改动——评审建议的注入点径直采用，重评二轮报告 §八「无竞态注入点可控」失实句 + §八 P3-1 行测试手法各记正 ×1（该报告合计记正 ×3 处，含 §五时点标记）。
- **P3-R3-6**：win-fonts 补 decodeRegOutput 兜底臂用例——vi.stubGlobal('TextDecoder') 伪类对 'gbk' 抛 RangeError（utf-8 委托真件保严格 fatal 试解语义），断言回落 `buf.toString('utf8')`（U+FFFD 形态不抛、icu 裁剪运行时不吞字体枚举链）。
- **P3-R4-1**：重评二轮报告 §五 规模/余量两行补「评审时点 2026-09-13 基线 `2f59db89`」标记（现行余量指向台账 §一）。
- **nano-1**：chat-clear-gates del()/post() 收敛参数化 `req(method, path)` 单源（净 −26 行，5 调用点同改）。
- **nano-2**：win-fonts runWithRegFallback 提模块级单源 + hklmOut 放宽 `string | Buffer`，GBK 集成用例复用同骨架（内联 spawn 假件删除）。

**测试账**：新增 1 文件 2 用例（r0914-audit-recheck）+ 既有 2 文件各 +1（r0913-r2-clear-gate 3→4 / win-fonts 19→20）= 净增 +1 文件 / +4 用例（全平台无门，win 差值锚 79 不变）；1129→1130 文件、7269→7273（win 7190→7194 过 + 84 跳）。chat-clear-gates（5 用例）与 snapshots-bookmoved（2 用例）为等价重写、用例数不变。

**门（L2 终门九件套，处置后全量重跑，win 本机一次全绿）**：vitest 全量 **1130 文件 = 7194 过 + 84 跳 0 败**（win 口径，359.71s，一次全绿无假红）+ tsc 0 + vue-tsc 0 + eslint 0/0 + check:counts 过（README 修账 1129→1130 / 7269→7273 后复跑一致）+ check:packaging 过 + check:knowledge 过 + e2e **49 过 2 跳**（1.0m，51 用例）+ soak 两段 OK（8.32→8.30MB / 8.82→8.88MB，上界 24MB）。

**改动面**：src 6 文件（state.ts / app-instance-guard.ts / font-cache.ts / snapshots.ts / client.ts / MetaFormPanel.vue——其中 4 件为注释记正/死码/风格级，行为面仅 client.ts 死条件移除与 snapshots.ts 测试钩子）+ test 改 5 新 1 + 根 README 修账 4 处 + Dev 文档链（本报告 §四/§五 + 重评二轮报告记正 3 处 + 台账 §一 + 总览 §1.3 + Dev/Docs README 行）。
