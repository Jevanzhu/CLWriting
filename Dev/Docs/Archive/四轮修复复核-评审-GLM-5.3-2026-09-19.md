# 四轮修复复核

- 性质：0918四轮修复批独立复核报告（不承继修复批自述与批记声称；正本入 `01-评审/`，**报告完成 ≠ 收口**）。
- **处置记（2026-09-19 复核处置批，作者指令「全部修复！」）**：P3×4（H401-H404）全量真修——H401 五件 d4xx 测试 rename 转行为命名 + 两处「16 新件行为命名」声称修账 / H402 README 指代漂移 / H403 四处注释勘误 / H404 三则措辞（含 G407 成因注改写；「模块级」措辞仅存于已归档四轮报告正文，按「历史正文不改写」不追改）；登记×5（H405-H409）维持在案（H408 勘误随本报告生效）。门 = L2 mac 亲跑一次全绿（vitest 1268 文件 = 7769 过 + 8 跳 0 败 + tsc/vue-tsc/eslint 0 + 三 check 过 + e2e 51 过 3 跳）；净 ±0 文件/±0 用例。随批收口归档 `Archive/`，批记 = `Archive/README.md`。
- 执行模型：GLM-5.3（主审）；分域复核由 4 个只读子代理单波并行执行（单波 ≤4，子代理与主审同模型系）。
- 复核对象：0918四轮修复批全部改动面——基线 `7fd37bd2` 工作树（57 变更路径，未入库；评审期零改动）。范围 = 30 真修 + 2 销案 + 1 缓办 + 16 新测试 + CI/构建面 + 文档链；**维持 14 项（A403/B405/B407/C402/C407/F403-F409/G409/G410）未重核**——均系四轮报告 §五「在案取舍登记」（注释自认或既有拍板），零代码改动面。作者指令「评审下这次修复」。
- 复核方式：「声称 vs 实态」逐项对码——修复批批记/总览行声称逐句拆解对源码实态；关键正确性主张做穷举验证（C401 四形态表 / C404 九形态枚举 / B402 22 类型子集表 / C406 四调用点可达性链 / G406 十四 SHA 逐一 api.github.com 核验）；主审亲核 A401 缓办依据注释在位。
- 门面口径：修复批 L2 九门 win 亲跑实录（vitest 1267 文件 = 7681 过 + 76 跳 0 败 417.10s / tsc·vue-tsc·eslint 0 / 三 check 过 / e2e 51 过 3 跳）系修复批自报——本复核为只读面，未重跑全量门；其可信度以「16 新件全数在树 + 静态面零红」间接背书。

## 一、结论速览

- **修复批全数通过独立复核：30/30 真修正确、零 P1/P2 缺陷、零回归面**。
- **销案 2 项成立**（C406 同步锁四处调用点均非 HTTP 可达 / E404 基线已含 R32-28）；**缓办 1 项依据在位**（A401 calls.ts:390 三项前置条件注释亲核）。
- 两处批内设计细化（E402 注解方案优于 boolean 标志 / B402 totals 流式计数而非 countEvents）复核均**优于原处方**，如实记档成立。
- 新增发现 **P1×0 / P2×0 / P3×4 + 登记×5**——全部为注释/文档精度与测试命名治理面，无行为缺陷；其中 1 条系对四轮报告的勘误裁定（D403 原机理误报，§五 H408）。
- 处置建议：P3×4 可一小批清掉（五件测试 rename + 纯注释/文档句子 ~12 文件、零行为），登记×5 维持在案（§六）。

## 二、真修 30 项逐项复核记

### B 域（events/server，4 修 + 1 补事件类型）

- **B401 ✅**：`has_branch_meta` VIRTUAL 生成列（instr 确定性函数）+ `idx_events_branch_meta(session_id,seq) WHERE has_branch_meta=1` 部分索引在位；EXPLAIN QUERY PLAN 实证 firstBranchMetaSeq 走 SEARCH 索引（LIKE 全表扫消除）；查询谓词与索引 WHERE 逐字一致；instr 与 LIKE 对 stringify 键次逐位等价复核（键序不敏感）；新库/存量库单路径幂等 ALTER 防双态 schema 漂移。**table_xinfo 陷阱实证**——`table_info` 不列 hidden 生成列，修复批批记「坑测试实证后修正」复核属实。残留：`src/events/store.ts:486-490` 注释仍写「PRAGMA table_info 判列后 ALTER」→ H403-①。
- **B402 ✅**：audit 双 `listEvents` 全量物化 → `iterateEvents` 流式（每流只持页窗口条目）；FOLD_INPUT_TYPES 与 foldSurface 消费集全表对码（SURFACE 三类 + compaction/end，22 类型逐一比对无缺无滥）；totals 流式计数逐位保持旧值——修复批故意偏差（不用 countEvents：骨架计数含坏行会偏大于旧值）如实记档复核成立；响应形状逐字段不变；dead pageSlice 已删。残留：`test/e2e/audit.spec.ts:8` 头注仍提「服务端 pageSlice 同语义」→ H403-④。
- **B403 ✅**：chat-history 尾窗 covered 改纯行数口径 `tail >= totalEvents`（与 SQL LIMIT 消费原语同口径）；坏行被 safeRowToEvent 丢弃不再引发触底误判——修复前「坏行灰落初始尾窗即丢头部旧史」机理消除。
- **B404 ✅**：merge-undo 定位改双趟 type 下推（structure.merge-undo undo 集 → 最新未被 undo 的 structure.merge），不再无过滤全流逐条 parse；病态「merge→undo→同 hash 重并」形态正确返回 null 走 body/disk 链。残留：`src/document/structure-merge.ts:379-383`「差异仅在病态形态」措辞过窄（正常形态亦有路径差异面）→ H403-③。
- **B406 ✅**：`chat_gap` 事件类型不入 SURFACE_EVENT_TYPES、无 surfaceOp（不污染折叠面）；溢出批次头补标 data.dropped；sourceIdxs/pendingSurfaceIdx「先滤蒸发引用（−dropped）再 +1」次序经反例证明（先 +1 会错位引用蒸发前坐标）。

### C 域（desktop/fs，4 修）

- **C401 ✅**：workdir 读失败防覆写闸**四形态全枚举**——①ENOENT：维持建新库原语义；②非 ENOENT 读失败：置 `workdirReadFailed` → 拒写 + 人话报错「已阻止写入以保护历史记录，请重启应用」+ arming 回滚快照置空（防失败窗内快照覆盖）；③写前重读成功：磁盘真身 setCurrent 为基底合并；④重读成功但 JSON 损坏：parseStore 空库基底放行覆写——**系 parseStore 既有容错语义，非本批回归**（可选增强见 H406）。
- **C403 ✅**：exitNow(err) → log.error + exit(1)、无参 exit(0)、close 悬置 2s 兜底（零参）exit(0)、exiting 幂等维持——M-8/R-20/R1010b 三锚语义逐字未动。
- **C404 ✅**：**九形态穷举枚举无一「v2 凭据在库 → 误重建」形态**——自愈重建仅当 v2VaultPresent=false（providers.json 缺失 / 无 vault / v<2 且无 byOs）；v2 在库或状态未知一律不重建并 warn。「重建 = 永久摧毁 v2 凭据」红线维持。范围外两处见 H407。
- **C405 ✅**：relaunch 延时 timer 单槽（clear-旧-再-set + 自清 + unref）。

### A 域（ai，2 修）

- **A402 ✅**：内嵌 write_chapter 以 owner `self-heal:<bookName>` 登记 ctrl——非 `chat:` 前缀 → 跨 owner 不误中止；/interrupt 全停覆盖；finally 注销防泄漏；E002（`chat:` 前缀排除于 isWriterRunning）口径未破。
- **A404 ✅**：providers 解析缓存单槽 → Map LRU 容量 8（delete+set 读提升、逐出最旧）；mtime 校验维持；四处失效点改逐键 delete。

### D 域（document/metrics/format，5 修）

- **D401 ✅**：伏笔片段代理对边界回退（start--/end-- 越半区回撤，复合字符不再劈半）。
- **D402 ✅**：对话标签阈值 clamp `min(max(baseline*1.3, 0.5), 0.99)` 双侧封。
- **D403 ✅（留痕性修复）**：U+3000 缩进 warn 对齐 R26-37 tab 口径（warn-once、解析行为零变）。**勘误裁定：四轮报告原 P3 机理系误报**——yaml 深栈匹配系纯宽度数值比较、无奇偶换算参与，统一全角缩进与 2 空格缩进解析全等（H408）；本修复价值独立成立（留痕）。
- **D404 ✅**：`.md` 剥离加 i 标志（`.MD` 不再穿透）。
- **D405 ✅**：并列计数 tiebreak 码元序（计数 desc 后全序确定，R0912-5 先例同口径）。

### E 域（frontend，3 修）

- **E402 ✅**：程序化替换回发抑制——`programmaticReplace` Annotation（**setup 级定义、实例间隔离**）；applyExternalReplace / applyDocSwitch 两处二段 replace 事务带注解；updateListener 无条件更新 lastLocalEmit 后按注解跳过 emit。R51-I-6/R8B-P1-1/R62-18 三锚语义未触；「注解优于 boolean 标志」批内设计细化复核成立（空→空文档切换事例：boolean 方案漏判、注解方案命中）。声称精度残留两则 → H404。
- **E401 ✅**：流式正文 150ms **trailing debounce**（尾沿去抖，非节流——批记「节流」措辞失实 H404）；本地 rendered ref + onBeforeUnmount 清 timer；按钮 disabled 直连 textOut 即时态不受去抖影响。
- **E403 ✅**：终局标签补 `failed: '失败'`。

### F 域（测试装置，2 修）

- **F401 ✅**：conflict.spec reportRestoreFailure + 分步 try/catch 对齐 edit-save.spec 同款。
- **F402 ✅**：GET_TOKEN_EXEMPT_PATHS 模块导出单源 + 双向差集守卫（非空地板）；governance 同步守卫件消费同源。

### G 域（构建/CI，8 修 + 1 门扩）

- **G401 ✅**：npm audit 双包非阻塞起步——实测复核 `npm --prefix src/studio/web-next audit` 确扫子包锁（根 10 / 子包 3，两集合不同）；存量漏洞面登记 H405。
- **G402 ✅**：win vitest 重跑兜底抽 composite action（`.github/actions/win-vitest-retry`）单源。
- **G403 ✅**：win 腿 e2e + release-smoke 接线（首期观察档；撤标志无计数锚 H409）。
- **G404 ✅**：tag 门 soak 接线。
- **G405 ✅**：`npm run setup` 一键装齐双包 + prebuild 人话守卫；README 连带文档面——「上面第一行」指代漂移 → H402。
- **G406 ✅**：全部 14 处 action 引用 SHA 钉版逐一 api.github.com 核验一致。
- **G407 ✅**：缓存键改 lock 提版单源；**成因注记失准**——pwsh 7 `>>` 默认 UTF-8 无 BOM，真正硬伤是 `$GITHUB_OUTPUT` 在 pwsh 不展开（须 `$env:GITHUB_OUTPUT`），「UTF-16 保险」注系成因误写 → H404。
- **G408 ✅**：soak `--plan` 计划数动态断言。
- **G411 ✅**：check-counts 漂移门清单补 typescript（sharedRuntimeVersionDrift 零漂移实测过）。

## 三、销案 2 + 缓办 1 复核

- **C406 销案 ✅ 独立复核成立**：四处同步锁调用点全量清点均非 HTTP 可达——生产路径走异步孪生（async 族）或零调用方；repairBooks 系 listen 前启动段。HTTP handler 内不可能触达同步锁 →「事件循环阻塞 P2」不成立。
- **E404 销案 ✅**：基线 `7fd37bd2` 已含 R32-28 index.html `#boot-shell` 静态加载指示（四轮评审时误报为缺失）。
- **A401 缓办 ✅ 依据在位**：`src/ai/calls.ts:390` 注释三项前置条件（记完即读消费者盘点 / 全写方 Promise 化上溯 / writeChains 接管面）主审亲核在位——G102/D204 先例口径。

## 四、测试面复核（16 新件）

- 16 新件全数在树且执行绿（修复批 L2 实录 7681 过 + 76 跳 0 败）。
- 覆盖质量抽查：B401 EXPLAIN 断言、B406 蒸发次序反例、C404 红线形态（v2 在库不重建）、E402 空→空切换事例等关键回归均有专测锚定；既有件扩例改写未见断言面弱化。
- **命名合规 11/16**：五件以批次号前缀命名违纪（治理正本「测试命名」条：新测试按被测行为命名、不以批次号命名、批次号留头注）——`test/document/d401-foreshadow-snippet-surrogate-boundary.test.ts` / `test/metrics/d402-dialogue-tag-threshold-clamp.test.ts` / `test/format/d403-yaml-wide-space-indent-warn.test.ts` / `test/document/d404-finalize-md-extension-case.test.ts` / `test/metrics/d405-short-index-distribution-tie-sort.test.ts`；批记「回归测试 16 新件行为命名」声称与实态不符 → H401。

## 五、新增发现（P3×4 + 登记×5，编号 H4xx = 本复核批）

| 编号 | 级别 | 发现 | 锚点 |
|---|---|---|---|
| H401 | P3·治理 | 五件测试文件名以批次号（d4xx）前缀命名，违反治理「测试命名」条；批记/总览「16 新件行为命名」声称失实（实 11+5） | 见 §四清单 |
| H402 | P3·文档 | README「上面第一行」指代漂移——G405 插入 `npm run setup` 行后所指已成第二行（`npm --prefix src/studio/web-next ci`） | `README.md:117` |
| H403 | P3·注释 | 注释失实四处：①store.ts「PRAGMA table_info 判列」实为 table_xinfo（②branch-meta-index-plan.test.ts「误报形态」两形态实测皆不命中——注释所述误保护形态不存在 ③structure-merge.ts「差异仅在病态形态」过窄 ④audit.spec.ts 头注残留已删 pageSlice） | `src/events/store.ts:488` / `test/events/branch-meta-index-plan.test.ts:47` / `src/document/structure-merge.ts:379` / `test/e2e/audit.spec.ts:8` |
| H404 | P3·声称精度 | 三则措辞失实：G407 成因注（UTF-16 → 实为 $GITHUB_OUTPUT 不展开）/ E401「节流」→ 实为 trailing debounce / E402 批注「模块级」→ 实为 setup 实例级 + E402-⑧「各复红」实为 3/4 | 见 §二各条 |
| H405 | 登记 | G401 存量漏洞面实测：根包 10 advisories（critical 1 + high 5，electron/@vitest 族 devDependencies 传递为主）、子包 3（brace-expansion/nanoid/postcss）——audit 起步位非阻塞成立，但**翻 blocker 前需先清存量高危**（升级链评估另立） | `npm audit` 实测 |
| H406 | 登记 | C401 形态④残余：重读成功但 JSON 损坏时基底仍为空放行覆写——parseStore 既有容错语义、非本批回归；可选增强 = 写前 parse 失败 warn 一句留痕 | `src/desktop/workdir-controller.ts` |
| H407 | 登记 | C404 两处范围外：warn 前半句「请从桌面应用启动」在桌面进程内自指（P4 级文案）；os-kek.json 缺失 + v2 vault 在库 = 双丢固有损失面（只能重录 key，不在本修复声称面） | `src/desktop/os-kek.ts` |
| H408 | 勘误裁定 | **四轮报告 D403 原机理误报**：yaml 深栈匹配纯数值比较、无奇偶换算参与，统一 U+3000 缩进与 2 空格缩进解析全等；四轮报告 D403 条目机理段系误报——按治理「历史正文不改写」口径不追改归档正本，勘误以本报告 + 批记行为准；本批 D403 修复为留痕性保守动作（行为零变）、价值独立成立 | `src/format/yaml.ts` |
| H409 | 登记·微小留白 | C405 timer unref 无专测断言；G403「首期观察档」撤标志无计数锚（靠人工记）——均不立项 | — |

## 六、处置建议

- **P3×4（H401-H404）可一小批清掉**：H401 五件 rename（去 d4xx 前缀、批次号留头注——头注已有四轮-D4xx 锚，纯 rename 零行为、vitest 自动发现）+ 总览/批记「16 新件行为命名」两处修账；H402 README 一句；H403 四处注释句子；H404 三则措辞（含 G407 成因注改写）。合计约 12 文件句子级改动，零行为面。
- **登记×5（H405-H409）维持在案**：H405 建议翻 blocker 前先清存量高危（另立升级链评估批）；H408 勘误落本报告即生效。
- 修复批收口态不受本复核影响（零 P1/P2）；本报告处置面 = P3 级——P3×4 处置后本报告收口归档。
