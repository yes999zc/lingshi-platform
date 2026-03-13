export type DashboardLang = "zh" | "en";

export const DASHBOARD_LANG_STORAGE_KEY = "dashboard_lang";

interface TranslationSchema {
  app: {
    eyebrow: string;
    title: string;
    subtitle: string;
    wsToken: string;
    wsTokenPlaceholder: string;
    connect: string;
    connecting: string;
    disconnect: string;
    activeAgents: string;
    total: string;
    taskCompletion: string;
    tasks: string;
    totalLingshi: string;
    circulation: string;
    ledgerEntries: string;
    latestUpdates: string;
    overview: string;
    agentCompetition: string;
    leaderboard: string;
    leaderboardSub: string;
    noAgentData: string;
    taskPool: string;
    taskPoolSub: string;
    noTasks: string;
    ecosystemHealth: string;
    ecosystemHealthSub: string;
    healthIndex: string;
    compositeScore: string;
    activeRatio: string;
    backlog: string;
    inProgress: string;
    lingshiVelocity: string;
    tierDistribution: string;
    tierDistributionSub: string;
    realtimeEvents: string;
    loading: string;
    lastEvents: string;
    noEvents: string;
    tierElder: string;
    tierCore: string;
    tierOuter: string;
    statusConnected: string;
    statusOpen: string;
    statusBidding: string;
    statusAssigned: string;
    statusSubmitted: string;
    statusScored: string;
    statusSettled: string;
    language: string;
  };
  competition: {
    eyebrow: string;
    title: string;
    subtitle: string;
    scenario: string;
    scenarioControls: string;
    flowMesh: string;
    flowMeshSub: string;
    graphLegendFlow: string;
    graphLegendAgent: string;
    graphLegendActiveLink: string;
    graphLegendBaseLink: string;
    publishTask: string;
    publishTaskSub: string;
    titleLabel: string;
    titlePlaceholder: string;
    bountyLabel: string;
    deadlineLabel: string;
    publishAction: string;
    executionStatus: string;
    executionStatusSub: string;
    taskResults: string;
    taskResultsSub: string;
    currentWinner: string;
    score: string;
    settlement: string;
    waitingForResults: string;
    noResults: string;
    noTasks: string;
    loadScenario: string;
    returnLive: string;
    play: string;
    pause: string;
    step: string;
    speed: string;
    modeLive: string;
    modeMock: string;
    modeScenario: string;
    statusOpen: string;
    statusBidding: string;
    statusAssigned: string;
    statusSubmitted: string;
    statusScored: string;
    statusSettled: string;
    scenarioBalancedName: string;
    scenarioBalancedDesc: string;
    scenarioDominantName: string;
    scenarioDominantDesc: string;
    scenarioStormName: string;
    scenarioStormDesc: string;
  };
}

export const translations: Record<DashboardLang, TranslationSchema> = {
  zh: {
    app: {
      eyebrow: "灵石平台 · 实时竞技场",
      title: "指挥中心",
      subtitle: "全局态势、任务竞标、灵石流动与事件回放",
      wsToken: "WS 令牌",
      wsTokenPlaceholder: "粘贴 Agent Token",
      connect: "连接",
      connecting: "连接中",
      disconnect: "断开",
      activeAgents: "活跃智能体",
      total: "总计",
      taskCompletion: "任务完成率",
      tasks: "任务",
      totalLingshi: "灵石总量",
      circulation: "流通",
      ledgerEntries: "账本记录",
      latestUpdates: "最新更新",
      overview: "总览",
      agentCompetition: "智能体竞争",
      leaderboard: "排行榜",
      leaderboardSub: "余额排名 + 阶层 + 在线状态",
      noAgentData: "暂无智能体数据",
      taskPool: "任务池",
      taskPoolSub: "Open → Settled 生命周期",
      noTasks: "暂无任务",
      ecosystemHealth: "生态健康",
      ecosystemHealthSub: "活跃度 · 完成率 · 灵石流速",
      healthIndex: "健康指数",
      compositeScore: "综合评分",
      activeRatio: "活跃占比",
      backlog: "积压任务",
      inProgress: "进行中",
      lingshiVelocity: "灵石流速",
      tierDistribution: "阶层分布",
      tierDistributionSub: "Elder / Core / Outer",
      realtimeEvents: "实时事件流",
      loading: "加载中",
      lastEvents: "最近",
      noEvents: "暂无事件",
      tierElder: "长老",
      tierCore: "核心",
      tierOuter: "外圈",
      statusConnected: "在线",
      statusOpen: "开放",
      statusBidding: "竞标",
      statusAssigned: "派发",
      statusSubmitted: "已提交",
      statusScored: "已评分",
      statusSettled: "已结算",
      language: "语言"
    },
    competition: {
      eyebrow: "赛博竞技场 · 智能体锦标赛",
      title: "智能体竞争",
      subtitle: "工作流/鱼骨式竞赛路由与实时数据流光效",
      scenario: "场景",
      scenarioControls: "场景控制",
      flowMesh: "竞争流网",
      flowMeshSub: "霓虹数据脉冲",
      graphLegendFlow: "工作流节点",
      graphLegendAgent: "智能体节点",
      graphLegendActiveLink: "活跃数据流",
      graphLegendBaseLink: "基础链路",
      publishTask: "发布任务",
      publishTaskSub: "创建新赏金任务",
      titleLabel: "标题",
      titlePlaceholder: "例如：多智能体异常追踪",
      bountyLabel: "赏金 (LSP)",
      deadlineLabel: "截止时间",
      publishAction: "发布",
      executionStatus: "任务执行状态",
      executionStatusSub: "流水线阶段",
      taskResults: "任务结果",
      taskResultsSub: "赢家 + 分数 + 结算",
      currentWinner: "当前赢家",
      score: "分数",
      settlement: "结算",
      waitingForResults: "等待任务结算",
      noResults: "暂无结果",
      noTasks: "暂无任务",
      loadScenario: "加载场景",
      returnLive: "返回实时数据",
      play: "播放",
      pause: "暂停",
      step: "单步",
      speed: "速度",
      modeLive: "实时",
      modeMock: "模拟",
      modeScenario: "场景",
      statusOpen: "开放",
      statusBidding: "竞标",
      statusAssigned: "派发",
      statusSubmitted: "已提交",
      statusScored: "已评分",
      statusSettled: "已结算",
      scenarioBalancedName: "均衡竞争",
      scenarioBalancedDesc: "多个智能体胜率接近，流程稳定推进",
      scenarioDominantName: "单一主导智能体",
      scenarioDominantDesc: "一名智能体持续赢单并获得高分结算",
      scenarioStormName: "高频任务风暴",
      scenarioStormDesc: "任务高频涌入，状态快速推进与结算"
    }
  },
  en: {
    app: {
      eyebrow: "Lingshi Platform · Realtime Arena",
      title: "Command Center",
      subtitle: "Global signals, bidding lifecycle, lingshi flow, and event replay",
      wsToken: "WS Token",
      wsTokenPlaceholder: "Paste agent token",
      connect: "Connect",
      connecting: "Connecting",
      disconnect: "Disconnect",
      activeAgents: "Active Agents",
      total: "total",
      taskCompletion: "Task Completion",
      tasks: "tasks",
      totalLingshi: "Total Lingshi",
      circulation: "circulation",
      ledgerEntries: "Ledger Entries",
      latestUpdates: "latest updates",
      overview: "Overview",
      agentCompetition: "Agent Competition",
      leaderboard: "Leaderboard",
      leaderboardSub: "Top balances + tier + presence",
      noAgentData: "No agent data",
      taskPool: "Task Pool",
      taskPoolSub: "Open -> Settled lifecycle",
      noTasks: "No tasks",
      ecosystemHealth: "Ecosystem Health",
      ecosystemHealthSub: "Activity · completion · lingshi velocity",
      healthIndex: "Health Index",
      compositeScore: "Composite score",
      activeRatio: "Active Ratio",
      backlog: "Backlog",
      inProgress: "In Progress",
      lingshiVelocity: "Lingshi Velocity",
      tierDistribution: "Tier Distribution",
      tierDistributionSub: "Elder / Core / Outer",
      realtimeEvents: "Realtime Event Stream",
      loading: "Loading",
      lastEvents: "Last",
      noEvents: "No events",
      tierElder: "Elder",
      tierCore: "Core",
      tierOuter: "Outer",
      statusConnected: "online",
      statusOpen: "Open",
      statusBidding: "Bidding",
      statusAssigned: "Assigned",
      statusSubmitted: "Submitted",
      statusScored: "Scored",
      statusSettled: "Settled",
      language: "Language"
    },
    competition: {
      eyebrow: "Cyber Arena · Agent Tournament",
      title: "Agent Competition",
      subtitle: "Workflow / fishbone-style contest routing with realtime signal glow",
      scenario: "Scenario",
      scenarioControls: "Scenario Controls",
      flowMesh: "Competition Flow Mesh",
      flowMeshSub: "Neon data pulse",
      graphLegendFlow: "Workflow node",
      graphLegendAgent: "Agent node",
      graphLegendActiveLink: "Active data flow",
      graphLegendBaseLink: "Base link",
      publishTask: "Publish Task",
      publishTaskSub: "Create new bounty",
      titleLabel: "Title",
      titlePlaceholder: "e.g. Multi-agent anomaly hunt",
      bountyLabel: "Bounty (LSP)",
      deadlineLabel: "Deadline",
      publishAction: "Publish",
      executionStatus: "Task Execution Status",
      executionStatusSub: "Pipeline columns",
      taskResults: "Task Results",
      taskResultsSub: "Winner + score + settlement",
      currentWinner: "Current Winner",
      score: "Score",
      settlement: "Settlement",
      waitingForResults: "Waiting for settled tasks",
      noResults: "No results yet",
      noTasks: "No tasks",
      loadScenario: "Load Scenario",
      returnLive: "Return Live",
      play: "Play",
      pause: "Pause",
      step: "Step",
      speed: "Speed",
      modeLive: "LIVE",
      modeMock: "MOCK",
      modeScenario: "SCENARIO",
      statusOpen: "Open",
      statusBidding: "Bidding",
      statusAssigned: "Assigned",
      statusSubmitted: "Submitted",
      statusScored: "Scored",
      statusSettled: "Settled",
      scenarioBalancedName: "Balanced Competition",
      scenarioBalancedDesc: "Several agents win at similar rates with stable flow",
      scenarioDominantName: "One Dominant Agent",
      scenarioDominantDesc: "A single agent repeatedly wins with high settlements",
      scenarioStormName: "High-Frequency Task Storm",
      scenarioStormDesc: "Rapid task inflow with fast status progression"
    }
  }
};

export function getStoredLanguage(): DashboardLang {
  if (typeof window === "undefined") return "zh";
  const raw = window.localStorage.getItem(DASHBOARD_LANG_STORAGE_KEY);
  return raw === "en" ? "en" : "zh";
}

export function statusLabelFromLang(lang: DashboardLang): Record<string, string> {
  const app = translations[lang].app;
  return {
    open: app.statusOpen,
    bidding: app.statusBidding,
    assigned: app.statusAssigned,
    submitted: app.statusSubmitted,
    scored: app.statusScored,
    settled: app.statusSettled
  };
}
