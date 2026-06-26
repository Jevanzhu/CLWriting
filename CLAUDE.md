# CLWriting UI 分支

当前分支：`feat/ui`

负责：
- `src/studio/web/src/pages`
- `src/studio/web/src/components`
- `src/studio/web/src/layouts`
- `src/studio/web/src/styles`
- `src/studio/web/src/composables` 中的轻量 UI 逻辑

不负责：
- CLI、状态机、缓存、导入导出等底层逻辑。
- `src/studio/server` 业务语义和写入规则。
- API / DTO / schema 契约，除非只是前端类型对齐。
- `main` 或 `feat/core` 集成职责。

资料：
- 默认只看 `../Dev/UI/Plans/桌面端与界面计划.md`。
- mockup / 视觉蓝图任务再读：`../Dev/UI/Plans/ui-shell-mockup-计划.md`
- 状态、api、types、stores 任务再读：`../Dev/UI/Plans/前端底层架构.md`
- 具体画面对齐时按需读：`Mockup`

UI 红线：
- 保持“总览 / 编辑 / 工作台”三态。
- 编辑态中栏编辑器常驻；数据展示不要挤占编辑器。
