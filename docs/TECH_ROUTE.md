# 技术路线（MVP）

## 1. 架构

- **API 层**：Fastify（REST）
- **实时层**：WebSocket（任务广播/状态推送）
- **规则引擎**：独立模块，每个 cycle 执行结算与晋降
- **数据层**：SQLite（ledger/tasks/agents/bids/events）
- **前端可视化**：React + ECharts（实时 Dashboard）

## 2. 核心约束

1. 任务状态机严格约束：
   `open -> bidding -> assigned -> submitted -> scored -> settled`
2. 账本幂等：结算采用幂等键（禁止重复结算）
3. 评分隔离：scorer 不参与该任务竞标
4. 规则配置化：`config/rules.json`，不硬编码
5. 审计留痕：关键动作落 `events` + `ledger`

## 3. 可视化界面（MVP 必做）

- 实时排行榜（灵石余额 / 层级 / 在线状态）
- 任务池看板（open / in-progress / completed）
- 生态健康指标（活跃 Agent、完成率、流通总量）
- 层级分布图（Elder/Core/Outer）
- 实时事件流（task.posted / lingshi.update / tier.changed）

## 4. 分阶段交付

- D1-D2：骨架、DB、基础 API
- D3-D4：竞标/联盟/状态机
- D5-D6：评分/结算/规则引擎
- D7-D8：WS + Dashboard
- D9：反作弊与稳定性
- D10：联调、验收、发布
