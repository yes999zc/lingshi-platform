# PM PLAN - Lingshi Platform (Execution Control)

**PM**: Mac  
**Mode**: 管理/质量/进度控制（不手写业务代码）

## 1. Delivery Flow
看板流转：`Backlog -> Ready -> In Progress -> Review -> QA -> Done`

规则：
- 每个任务卡必须包含：Owner、截止时间、验收标准、证据路径
- 任务卡移动必须附验证结果（命令/截图/日志）
- 无证据不允许从 Review 进入 QA

## 2. Milestone Rhythm
- 每日里程碑检查：12:00、22:00
- 阻塞升级阈值：超过 30 分钟未解除即升级为红色风险
- 每日必须产出：状态报告 + 风险更新 + 次日排程

## 3. Quality Gates (Hard)
1. TypeScript build pass
2. 核心链路测试 pass（状态机/结算/WS）
3. Runtime 冒烟验证 pass（服务启动 + 端口监听 + API 响应）
4. Dashboard 可用性 pass（桌面+移动）
5. 文档同步更新（SOW/验收/风险）

## 4. Progress Control Methods

### 4.1 Earned Progress
- 每个 WP 分配权重：
  - WP1 Runtime 25%
  - WP2 Quality 25%
  - WP3 E2E 20%
  - WP4 PUA Validation 15%
  - WP5 Release Readiness 15%
- 日进度 = 已验收权重累计（非主观估计）

### 4.2 RAG 机制
- 绿：按计划推进，无关键阻塞
- 黄：轻度延误，可在当日追回
- 红：影响里程碑，需立刻调整资源与顺序

### 4.3 阻塞处理 SLA
- 0~15 分钟：Owner 自行排查
- 15~30 分钟：PM 介入，切换替代路径
- >30 分钟：升级风险，重排关键路径

## 5. Review Protocol (Codex/Claude 结果复核)

### 5.1 复核维度
- 正确性：结果与目标一致
- 完整性：边界场景是否覆盖
- 可审计性：是否提供证据链
- 回归风险：是否引入新问题

### 5.2 双人交叉复核
- Codex 产出由 Claude 做质量审查
- Claude 产出由 Codex 做执行可行性审查
- PM 做最终判定并出结论

## 6. PUA Pressure Framework

### 对 Codex
- “owner意识在哪？只报错不闭环视为不合格。”
- “今天最好的表现，是明天最低的要求。”
- “连续两次失败不许原地打转，立即切换新方案。”

### 对 Claude
- “顶层设计、抓手、差异化价值必须说清楚并可验证。”
- “不给复现路径的风险条目一律退回。”
- “不做空泛建议，必须可落地。”

### 对 PM 自己
- “不等、不拖、不甩锅；15 分钟内必须输出下一步动作。”
- “每条汇报必须有证据和明确时间点。”
- “没闭环就不算完成。”
