# SOW - Lingshi Platform v0.1.0 (PM Baseline)

**Owner**: Mac (Project Manager)  
**Date**: 2026-03-12  
**Execution Model**: PM orchestration (Mac) + delivery agents (Codex/Claude)

---

## 1) Scope

### In Scope
1. Runtime stabilization（服务可启动、端口监听、基础 API/WS 可用）
2. Rule engine quality hardening（规则/评分/层级/结算可审计）
3. Dashboard verification（实时更新、桌面+移动端可用）
4. PUA agent validation（单次验证 + AB 测试）
5. Release readiness（文档、验收标准、风险登记、发布检查）

### Out of Scope (for this phase)
1. 新业务模块扩展
2. 大规模性能基准（>1k 并发）
3. 生产级自动扩缩容

---

## 2) Work Breakdown Structure (WBS)

## WP1 - Runtime Stabilization
- 1.1 环境与依赖核验
- 1.2 启动链路验证（dev/start）
- 1.3 API/WS 冒烟测试
- 1.4 运行证据归档（命令、日志、结果）

## WP2 - Rule & Settlement Quality
- 2.1 规则配置可追踪性检查
- 2.2 状态机非法跳转覆盖
- 2.3 结算一致性/幂等验证
- 2.4 边界条件风险清单

## WP3 - Dashboard & E2E Validation
- 3.1 Dashboard 实时数据链路验证
- 3.2 桌面/移动可用性验证
- 3.3 E2E 联调（API → WS → UI）

## WP4 - PUA Validation Pack
- 4.1 pua-agent 单次执行验证
- 4.2 AB 测试（baseline vs PUA）
- 4.3 输出对比报告（成功率/耗时/修复率）

## WP5 - Release Readiness
- 5.1 验收标准收敛
- 5.2 风险登记更新
- 5.3 文档补齐（README/API/运维）
- 5.4 发布门禁核对

---

## 3) Deliverables

1. `docs/PROJECT_SCHEDULE.md`（主时间线与里程碑）
2. `docs/reports/day1-codex-runtime-report.md`
3. `docs/reports/day1-claude-quality-report.md`
4. `docs/ACCEPTANCE_CRITERIA.md`（新增 Day1 QA section）
5. `docs/RISK_REGISTER.md`（风险更新）
6. Day1/Day2/Day3 PM 状态报告

---

## 4) Acceptance Criteria

1. Runtime: 服务可启动，端口监听，基础接口可响应
2. Quality: 规则引擎与结算链路具备可审计证据
3. Test: 冒烟 + 关键链路测试通过
4. Governance: 风险清单、验收标准、日汇报完整

---

## 5) RACI / Task Assignment

| Work Package | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| WP1 Runtime Stabilization | Codex | Mac | Claude | 9哥 |
| WP2 Rule & Settlement Quality | Claude | Mac | Codex | 9哥 |
| WP3 Dashboard & E2E | Codex | Mac | Claude | 9哥 |
| WP4 PUA Validation | Claude | Mac | Codex | 9哥 |
| WP5 Release Readiness | Codex + Claude | Mac | - | 9哥 |

---

## 6) PUA Pressure Policy (Execution Contract)

### For Codex
- 端到端闭环，不接受“只报错不收敛”。
- 每个结论必须有日志证据。
- 连续两次失败必须换本质不同方案。

### For Claude
- 必须给出顶层设计抓手与可验证标准。
- 风险条目必须包含影响面 + 复现步骤。
- 禁止空泛建议，必须可落地。

### For PM (Mac Self-PUA)
- 不做 NPC，不等用户催。
- 每个里程碑必须有硬证据与状态判定。
- 发现阻塞 15 分钟内通报，给 A/B 备选路径。

---

## 7) Reporting Cadence

- 固定汇报：12:00 / 22:00
- 阻塞汇报：实时（<=15 分钟）
- 里程碑汇报：完成即报（含证据路径）
