# SOW - Helper Agents

## Claude CLI（架构与规则负责人）

### Scope
- 规则引擎与结算规则设计
- 状态机约束与反作弊策略
- 架构 ADR、验收标准文档

### Deliverables
- `config/rules.json` v1
- `src/engine/rule-engine.ts`
- `src/engine/scoring.ts`
- `src/engine/tier-manager.ts`
- `docs/ADR-001-architecture.md`
- `docs/ACCEPTANCE_CRITERIA.md`

### Acceptance
- 规则可配置生效
- 非法状态跳转可拦截
- 结算公式可复算可审计

---

## Codex CLI（工程实现与前端负责人）

### Scope
- API/DB/WS 主体编码
- Dashboard 可视化页面实现
- SDK 示例与工程脚手架

### Deliverables
- `src/api/*` 核心路由
- `src/db/*` schema + access layer
- `src/websocket/ws-server.ts`
- `src/dashboard/*`（React）
- `examples/simple-agent.*`

### Acceptance
- API/WS 联调通过
- Dashboard 实时更新稳定
- 测试与 lint 通过
