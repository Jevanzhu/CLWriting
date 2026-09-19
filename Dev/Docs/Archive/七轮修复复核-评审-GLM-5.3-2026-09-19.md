# 七轮修复复核

- 性质：七轮重评修复批独立复核报告（不承继修复批自述与批记声称；正本入 `01-评审/`，**报告完成 ≠ 收口**）。
- **处置记（2026-09-19 同日复核处置批，作者指令「全部修复」）**：P3×4 全量真修——H501 盘面闸改 statSync ENOENT-only（`book-context.ts`，isDirConfirmedMissing R35-28 同口径；新件回归×2 含 EACCES 注入反例）/ H502 写回段回收站清单在位复评（`trash.ts` 三处锁回调首行；新件端到端×2 含预持锁确定性死书窗）/ H503 JSON 详情三处统一码位口径（`withinDetailLimit` BMP O(1) 快路径；r0911b 扩反例×1）/ H504 总览 §1.3 计数行改指 Dev/Docs README 正本（销挥发性计数这一类）。**批内如实记档：H502 修复三迭代**——v1 判 bookRoot 目录存在性被锁原语取锁 mkdir 祖先链复活洗掉、v2 判 book.yaml 身份锚误伤无 book.yaml 的合法测试书面（3 文件 7 例复红）、v3 判回收站清单在位（入口必在→写回时不在=外部整删，合法 RMW 恒 0b 重写不删文件，零误伤）；本报告 §五 H502 原「锁回调首行复评」处方低估了两道放大器（取锁 mkdir 复活祖先链 + 「缺失按合法空」读口径），处方不足实证随批记档。登记×6（H505-H510）维持在案。门 = L2 win 亲跑九门一次全绿（vitest 1271 文件 = 7716 过 + 76 跳 0 败一次净跑 368.49s + tsc/vue-tsc/eslint 0 + 三 check 过〔counts 1271/7716/33/54 README 修账后对账绿〕+ e2e 51 过 3 跳 60.0s；coverage 按 CI 单腿 ubuntu·24 阈值门兜底未本地重跑）；净 +5 用例/+2 文件（全无平台门），差值锚 68 维持（mac 口径 7784 = win 7716 + 68）。随批收口归档 `Archive/`，批记 = `Archive/README.md`（2026-09-19 撤档，git `02c52430` 可取）。
- 执行模型：GLM-5.3（主审）；分域复核由 4 个只读子代理单波并行执行（单波 ≤4，子代理与主审同模型系）。
- 复核对象：七轮重评修复批全部改动面——基线 `b55d27ca` 工作树（16 变更路径，未入库；复核期零改动）。范围 = P3×5 真修（src 6 件）+ 回归测试 5 件（新 1 / 扩 4，净 +10 用例）+ 文档链（根 README 五处 + 总览三处 + Dev/Docs README + Archive 批记行 + 七轮报告归档件头部处置记与 §四）。作者指令「评审下刚刚的修复」。
- 复核方式：「声称 vs 实态」逐项对码——修复批报告处置记/总览行/批记行声称逐句拆解对源码与 diff 实态；关键正确性主张做穷举或实算验证（B 域截断边界形态穷举表 / C 域 60·24·4096 三边界 node 实算 / A 域 bookMovedFailure 全库 22 调用点逐一清点 / D 域五本账逐项 + check:counts 现树复跑）；主审对全部新发现逐条源码亲核。
- 门面口径：修复批 L2 九门系**同会话主审亲跑**（非第三方复验）——本复核为只读面，未重跑全量门；其可信度以「五件触达测试红绿推演成立 + 静态面零红 + check:counts 现树复跑绿」间接背书（四轮复核同款口径）。

## 一、结论速览

- **修复批 5 项真修全部通过独立复核**：接线正确（trash 重验与六族先例逐字同款、盘面闸位置与 fail-closed 语义相符）、单源收敛无行为外溢（两个单源本体零改动）、回归测试红绿有效（旧实现下均复红）。
- **七轮-4 勘误成立**：`chapterNoFromName` 正则实推演 `0012.md` 不命中（`src/format/filename.ts:145`），仓内三处测试钉定（filename.test / chapter-no-callshape / process/summary.ts:563-574 留记），「不扩识别集、维持 R1010c-EN-P2-1 登记」与实态一致。
- 账面五本账（用例数 +10/+1 文件 / 路径数 16 / README 五处修账 / 门数字 / 修法明细）**全数核实成立**；差值锚 68 论证的平台门前提经 grep 实证；文档链五件互指零悬空。
- 新增发现 **P1×0 / P2×0 / P3×4 + 登记×6**——H501 盘面闸裸 existsSync 违仓内 ENOENT-only 纪律 / H502 孤儿阻止面测试强度不足 / H503 JSON 详情截断量纲失配（本批引入）/ H504 总览 §1.3 计数残留（本批引入）；全部为守卫口径精度、测试强度与文档精度面，无行为缺陷、无回滚项。
- 处置建议：P3×4 可一小批清掉（H501 一处改 ENOENT-only 判定 / H503 三处切码位口径 / H504 一字修账 / H502 补端到端用例或转登记），登记×6 维持在案（§六）。

## 二、真修 5 项逐项复核记

### 七轮-1 + 七轮-2（trash 两端点补重验 + bookMovedFailure 盘面闸）

- **接线 ✅**：trash.restore 守卫在 resolveBookOrReply（`documents-crud.ts:272-273`）后、restoreTrash（:282）前（:279-280）；trash.delete 同构（:293-299）。三实参与错误出口（`replyError(res, structStatus(...), ...)`）与 words-diary.post（:59-60）逐字一致；structStatus('BOOK_MOVED')→409；import 零新增。
- **盘面闸 ✅**：`book-context.ts:97` 在注册比对（:86-89）通过之后；existsSync 复用 :12 既有 import；capturedRoot = resolveBook 产物的书绝对根目录；fail-closed、文案与注册比对分支同文（单一不变量）。
- **波及面（关键主张穷举）✅**：全库 22 个调用点逐一清点——全部为写端点（POST/PUT/DELETE），无 GET 热路径，每写请求多一次 stat 量级可忽略。场景面：新建书登记最后写（init.ts:67-76）无数伪窗口；改名多 await 陈旧注册窗真实存在且盘面闸恰好兜住，**且顺带封住改名登记锁超时跳过整写（books-rename.ts:247-249）留下的持久性陈旧登记漏面**（旧代码会持续对旧路径 mkdir 成孤儿）——净收益为正；case-only 改名 win/mac 走 R71-8 原位分支无数伪、Linux 真搬移窗内 BOOK_MOVED 是本意；repairBooks 只改登记不搬目录、relink 仅在新盘面已存在且旧路径 ENOENT 确认缺失时发生；移动硬盘/网络盘卷离线时 books.jsonl 同卷先读失败（readBooks 容错返 []）→ NOT_FOUND，与旧行为等效、无新增误伤面。
- **落地面机理 ✅（一处注释引用瑕疵见 H510）**：孤儿重建面真实存在——trash.ts:423（finishRestoreBookkeeping，withManifestLockAsync :406 之后）/:216（writeTrashManifest，经 :443-445/:536-538 RMW 到达）跨进程内 await 窗；:344 的 originalPath mkdir 实在同步段（修复批注释 :276 引用张冠李戴，机理成立但所指行号段错位）。
- **保留意见**：H501（裸 existsSync）/ H502（测试强度）——见 §五。

### 七轮-3（chat 队列溢出预览码位截断）

- **✅ 全形态接住**：import 路径正确（`chat.ts:36` `../../shared/text.js`，NodeNext 风格与同文件一致）；clipByCodePoints（`shared/text.ts:34-36` = Array.from 码位切片重组）语义与用法匹配。边界穷举：恰跨第 40/41 码元代理对（旧劈孤立高代理→乱码，新完整保留）✅；40 码位含 astral（旧误截断+乱码，新原样完整不加 …）✅；全 BMP 形态行为逐位一致 ✅；省略号判据与实际截断同源（旧判据按码元与截断不同源）✅。
- **口径代价（登记 H505）**：预览上限由 40 码元变 40 码位，astral 密集消息下 notice 文案 UTF-16 长度最多 80 码元——单条瞬态文案，可接受。

### 七轮-4（定稿章号拦截收敛 chapterNoFromName 单源）

- **✅ 无回归面**：basename 提取 `e.path.split('/').pop() ?? ''` 与旧代码逐字相同；清单 path 生产链（service.ts doCreate/doCopy 逐段 sanitize、draft-pipeline 经 resolveDraftPath、trash 回填、finalize 补建）恒 posix 正斜杠，无 win 反斜杠写入面。窄→宽收敛**无「旧拦新不拦」形态**（`-` 命中集两口径数值相同；大数前缀旧 Number 相等恒假不拦、新返回 null 不拦，等效）。
- **新拦旧不拦面** = em-dash（U+2014）/ 空白类（`\s` 含 \u00A0 等，登记 H506 附注）；**裸数字+.md 按勘误确不命中**——正则实推演：`0012.md` 贪婪吃 0012 后遇 `.` 不属任何分支、回溯均不匹配 → null；`0012` 裸尾 `$` 命中 → 12（正文 basename 恒带 .md，裸尾形态在本消费点不可达）。R1010c-EN-P2-1 留记真身 `src/process/summary.ts:563-574`，与 draft-path.ts:129-130「不扩集」注释一致。
- **单源纪律 ✅**：filename.ts 本体零改动，draft-path 为纯新增消费方（callshape 与 finalize.ts:423-425 一致），其余 17 个消费文件未触碰。

### 七轮-5（前端四处码位截断）

- **✅ 四处全改 + 无第五处漏改**：AuditEventList.vue:66/:73/:120 + StyleEntryPanel.vue:84；import 五级相对路径验算正确（components/audit → 根 src/shared/text），与 stores/chat.ts:64 既有跨包先例同形态；web-next vite/tsconfig 无 alias 可走（不存在「应走未走」）。横切扫查 web-next 其余 10 处 `.slice(0,` 逐个判定均为数组/ISO 日期/路径界/已是码位口径（stores/chat.ts:70）——修复批「其余命中安全面」声称属实。
- **✅ 守卫零扰动**：StyleEntryPanel FE-3 书名捕获（:83）与 R36-22 三处切书复检（:92/:97/:100）原样未动；AuditEventList null/undefined 防御与 goal 摘要组装逐字保持。
- **保留意见**：H503（JSON 详情量纲失配，本批引入）——见 §五。

## 三、测试面复核（净 +10 用例）

- **红绿有效性逐一推演 ✅**（对守卫存在性与截断行为）：
  - trash 新件 4 例：撤销七轮-1（去守卫）→ 窗口用例走回收站清单查询 → 404 NOT_FOUND ≠ 409 复红；仅撤销七轮-2（留守卫去盘面校验）→ disk-deleted 用例复红——**两项修复隔离可测**；正控真跑通回收站查询路径（trash.ts:127-133 → :282 404）并证盘面校验对完好书无数伪。装置与 r1010b-srv-documents-bookmoved 先例逐段同构。
  - chat-steer +1：'甲'×39+'𠮷'+… 构造真把代理对放在第 40/41 码元边界；旧实现双重复红（toContain('𠮷') 失败 + 孤立代理扫描失败）；abortChat 早退不等 11 轮续链。
  - draft +1：装置链（定稿宽名登记 + 磁盘再改名）真让精确 path 分支失配、只剩章号分支把关；旧窄正则对 em-dash/空格双组复红；正控（非定稿章不误伤）在宽命名定稿条目在场环境下验证不跨章牵连。
  - r0911b +3：60/60/4096 三边界经 node 实算均恰跨代理对（含 JSON 前缀 10 码元 + 4085 甲的逐步验算）；expectNoLoneSurrogate 对前缀式截断伪影（孤立高代理）充分。
  - r36-22 +1：23+'𠮷' 构造实测旧 slice 劈半、新完整；ui.ask spy 装置与既有用例同构。
- **强度注记（H502/H508）**：trash 窗口用例未播种回收站条目——证明的是「守卫先于回收站清单查询触发」，`existsSync(bookRoot)===false` 的「无孤儿重建」断言在该形态下恒真（无区分力）；真实孤儿落地面（trash.ts:216/:423 经锁 await）未被端到端覆盖，入口守卫对「清单已读到、书在调用内锁等待期间死亡」的残窗只收窄不消除。r36-22 用例未钉「…」判据半（24 码位/25 码元形态新旧判据同产 …）。新件行为命名合规（文件名与用例名零批次号前缀）。

## 四、文档链与账面复核

- **五本账 ✅**：用例数（git diff 逐文件实数 it( = 4+1+1+3+1 = 10，非模板串假阳性）；路径数（git status 实数 16 = src 6 + test 5 + README 1 + Dev/Docs 3 + 归档 1）；README 五处修账（:8/:103/:119×2/:125 全在位，7769/1268 残留 3 处均为历史沿革前锚、应保留）；门数字（批记/总览/报告三处全标「win 亲跑」口径、无冒称第三方，coverage 明示「未本地重跑」）；修法明细（批记行与 src diff 逐项吻合，含 StyleEntryPanel 判据随改句）。
- **check:counts 现树复跑绿**（本复核亲跑）：实测 1269 文件 / 7711 单测 / 33 spec / 54 用例与 README 一致——counts 臂现树可复现。
- **交叉引用 ✅**：总览 §1.3 七轮行 ↔ §三 阶段 33 行 ↔ 批记行 ↔ 报告头部互指零悬空；Archive 15 篇 / 01-评审 0 篇与 Dev/Docs README 计数一致。
- **发现 H504（本批引入）**：总览:22 §1.3 标题「实态 1 篇」系收口时漏回改（git diff 实证本批 0→1 引入）——报告已归档、01-评审 实态 0 篇，与同批 Dev/Docs README「0 篇」、批记「1→0」自相矛盾。本复核报告落位 01-评审/ 后该计数又为 1（偶然回准），但批内自相矛盾事实在案，按 H401 先例口径定 P3。
- **措辞精度（登记 H509）**：报告 §四「端点内多 await 的 intra-call 窗……由入口盘面闸一次收口」——入口闸时序上不覆盖 intra-call 窗，「一次收口」并置「未另立时序改造」有轻度歧义（批记行措辞无此歧义）。
- **存证限制（非发现，如实记档）**：七轮报告从未入 git，其「§一/§二/§三 历史正文未改写」无 diff 可比，仅内部一致性佐证（无翻案证据）。

## 五、新增发现（主审逐条源码亲核成立）

### H501 | P3 | 盘面闸用裸 existsSync，违仓内 ENOENT-only 纪律

- 位置：`src/studio/server/book-context.ts:97`。
- 机理：existsSync 对一切 stat 错误返 false；仓内 `src/install/books-repair.ts:69-77`（isDirConfirmedMissing，R35-28 立条、P3-13 四轮重评再加固）明文认定「EACCES/EIO 等瞬态不可读（网络盘离线、权限故障、杀软/同步盘锁）不得误判为已删」。盘面闸恰恰用了裸 existsSync。
- 触发：书根 stat 瞬时失败 + 任意写端点请求 → 22 个写端点 409 BOOK_MOVED，文案「书已改名或已删除」与事实不符。自愈（重试即过）、fail-closed，故 P3。
- 建议：改 `statSync(capturedRoot)` catch 后仅 ENOENT 判缺失（与 isDirConfirmedMissing 同口径），或直接复用该助手（install → studio 引用方向允许与否随实现裁量）。现有 4 例测试在该口径下行为不变（rmSync/renameSync 均产 ENOENT）。

### H502 | P3 | 孤儿阻止面端到端未覆盖；入口守卫对调用内窗口只收窄不消除

- 位置：`test/studio/trash-book-registration-guard.test.ts`（强度）/ trash.ts:216/:423/:406（残窗）。
- 机理：窗口用例全走「清单空 404」分支，mkdir 孤儿面未被任何用例触达；入口单次守卫挡不住「清单已读到、书在 withManifestLockAsync 等待期间被删」的调用内竞态（knowledge.ts:157 有「每 100 条让出后复核」先例可循）。
- 建议：或播种清单条目 + 注入锁等待模拟调用内死亡补端到端用例，或在锁回调首行复评一次；概率低、损害为无 book.yaml 孤儿目录（repairBooks 不认领、肉眼可清），亦可转登记不催改。

### H503 | P3 | JSON 详情截断量纲失配（本批引入）：截断按码位、阈值与计数按码元

- 位置：`src/studio/web-next/src/components/audit/AuditEventList.vue:119-124`。
- 机理：detailText 截断改 clipByCodePoints（4096 码位）但触发阈值（`s.length <= JSON_DETAIL_LIMIT`）与 suffix 计数（`${s.length} 字符`）及 detailTruncated（:124）仍按 UTF-16 码元——旧实现三者同码元自洽，本批只换 clip 一处成跨量纲。实证反例（node 验算）：`{k:'甲'×4082+'𠮷'}` stringify 后 4097 码元/4096 码位——进截断分支、clip 返回原串一字未删，却追加「…（已截断，完整 JSON 共 4097 字符）」；旧代码同例真删 1 码元。
- 建议：触发条件与计数同改码位口径（`codePointLength(s) > JSON_DETAIL_LIMIT` 一类），detailTruncated 同步。纯文案窄域，BMP CJK 负载不受影响。

### H504 | P3 | 总览 §1.3 标题计数收口残留（本批引入）

- 位置：`Dev/Docs/00-总览与实施路线-2026-08-15.md:22`。
- 机理：见 §四——本批 0→1 引入的「实态 1 篇」与同批 Dev/Docs README「0 篇」/批记「1→0」自相矛盾。本复核报告落位后计数回准，批内矛盾事实在案。
- 建议：随下一文档触达批把该行改为动态准确表述（或依赖本报告在位期间的实态）。

### 登记×6（维持在案，不催改）

- **H505**：七轮-3 预览上限 40 码元→40 码位，astral 密集下 notice 最长 80 码元——码位口径合理代价。
- **H506**：chapterNoFromName `\s` 分支认全空白类（含 \u00A0），略超「-—空格」直觉描述；draft-path.ts:126 注释「裸尾均认」在本消费点（basename 恒带 .md）不可达——注释精度。
- **H507**：`stores/chat.ts:69-71` 本地 clipByCodePoints 与 shared 实现逐字重复仍在库（本批未触碰）——web-next 范围内「单源」尚不成立（双实现并存），后续可收编。
- **H508**：r36-22 新用例未钉「…」判据半（24 码位/25 码元形态）——建议补 `'甲'×23+'𠮷'` 无尾字用例断言无「…」。
- **H509**：报告 §四「一次收口」措辞歧义（§四存证限制同节）。
- **H510**：documents-crud.ts:276 注释引 :344 为「多 await 后 mkdir」落地面，实为同步段（真跨 await 落地面 = :216/:423）；book-context.ts:94「恢复均先落盘后登记」中「恢复」无自动化流程对应——两处注释精度。

## 六、处置建议

- **P3×4 可一小批清掉**：H501（一处 ENOENT-only 判定 + 既有 4 例回归不受影响）/ H503（三处切码位口径 + 1 例钉反例）/ H504（一字修账）/ H502（补端到端用例或转登记）——合计 ~4 文件 + 测试扩例，零行为回滚面。
- **登记×6 维持在案**（H505-H510），随各自触达面渐进。
- 修复批收口态不受本复核影响（零 P1/P2、五项真修全部成立）；本报告处置面 = P3 级——P3×4 处置后本报告收口归档。
