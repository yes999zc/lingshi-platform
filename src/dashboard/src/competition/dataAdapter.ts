import type { Agent, EventRecord, Task } from "../types";

export interface CompetitionTask {
  id: string;
  title: string;
  status: CompetitionStatus;
  bounty: number;
  deadline: string;
  workflow: string;
  assignedAgentId: string | null;
}

export interface CompetitionResult {
  taskId: string;
  winner: string;
  score: number;
  settlement: number;
  updatedAt: string;
}

export interface CompetitionGraphNode {
  id: string;
  name: string;
  x: number;
  y: number;
  category: number;
  value: number;
}

export interface CompetitionGraphLink {
  source: string;
  target: string;
  value: number;
}

export interface CompetitionData {
  mode: "live" | "mock";
  tasks: CompetitionTask[];
  results: CompetitionResult[];
  graphNodes: CompetitionGraphNode[];
  graphLinks: CompetitionGraphLink[];
}

export interface PublishTaskInput {
  title: string;
  bounty: number;
  deadline: string;
}

export type CompetitionStatus = "open" | "bidding" | "assigned" | "submitted" | "scored" | "settled";

export type CompetitionScenarioId = "balanced_competition" | "one_dominant_agent" | "high_frequency_task_storm";

export const COMPETITION_SCENARIO_IDS: CompetitionScenarioId[] = [
  "balanced_competition",
  "one_dominant_agent",
  "high_frequency_task_storm"
];

const FALLBACK_AGENT_NAMES = ["Nyx-01", "Volt-Prime", "SableCore", "Aurora", "Kite-9", "Astra-7"];
const STATUS_FLOW: CompetitionStatus[] = ["open", "bidding", "assigned", "submitted", "scored", "settled"];

function clampScore(value: number) {
  return Math.max(50, Math.min(99, value));
}

function formatDeadline(offsetHours: number) {
  const ts = Date.now() + offsetHours * 60 * 60 * 1000;
  return new Date(ts).toISOString();
}

function pickAgentName(agent: Agent | undefined, fallbackIndex: number) {
  if (agent?.name?.trim()) return agent.name;
  if (agent?.agent_id) return `Agent-${agent.agent_id.slice(0, 5)}`;
  return FALLBACK_AGENT_NAMES[fallbackIndex % FALLBACK_AGENT_NAMES.length];
}

function buildMockTasks(): CompetitionTask[] {
  const titles = [
    "Neon Market Volatility Predictor",
    "Fishbone Root-Cause For API Timeout",
    "Adaptive Liquidity Route Planner",
    "Threat Signature Compression"
  ];

  return titles.map((title, index) => ({
    id: `mock-${index + 1}`,
    title,
    status: STATUS_FLOW[Math.min(index + 1, STATUS_FLOW.length - 2)],
    bounty: 80 + index * 25,
    deadline: formatDeadline((index + 8) * 3),
    workflow: index % 2 === 0 ? "workflow" : "fishbone",
    assignedAgentId: null
  }));
}

function buildTasksFromLive(tasks: Task[]): CompetitionTask[] {
  return tasks.slice(0, 12).map((task, index) => {
    const status = STATUS_FLOW.includes(task.status as CompetitionStatus)
      ? (task.status as CompetitionStatus)
      : "open";

    return {
      id: task.id,
      title: task.title || `Task ${task.id.slice(0, 6)}`,
      status,
      bounty: task.bounty_lingshi || 0,
      deadline: formatDeadline(6 + index * 2),
      workflow: index % 2 === 0 ? "workflow" : "fishbone",
      assignedAgentId: task.agent_id
    };
  });
}

function buildGraphNodes(agentNames: string[]): CompetitionGraphNode[] {
  const baseNodes: CompetitionGraphNode[] = [
    { id: "publish", name: "Publish", x: 8, y: 50, category: 0, value: 92 },
    { id: "bidding", name: "Bidding", x: 28, y: 50, category: 0, value: 88 },
    { id: "match", name: "Match", x: 48, y: 50, category: 0, value: 84 },
    { id: "review", name: "Review", x: 68, y: 50, category: 0, value: 87 },
    { id: "settle", name: "Settlement", x: 88, y: 50, category: 0, value: 94 }
  ];

  const offsetY = [18, 82, 30, 70, 12, 88];
  const offsetX = [40, 40, 52, 52, 62, 62];

  const agentNodes = agentNames.slice(0, 6).map((name, index) => ({
    id: `agent-${index}`,
    name,
    x: offsetX[index] ?? 48,
    y: offsetY[index] ?? 40,
    category: 1,
    value: 60 + index * 8
  }));

  return [...baseNodes, ...agentNodes];
}

function buildGraphLinks(agentCount: number, tasks: CompetitionTask[]): CompetitionGraphLink[] {
  const flowLinks: CompetitionGraphLink[] = [
    { source: "publish", target: "bidding", value: 10 },
    { source: "bidding", target: "match", value: 9 },
    { source: "match", target: "review", value: 8 },
    { source: "review", target: "settle", value: 8 }
  ];

  const agentLinks: CompetitionGraphLink[] = [];
  const linksToSpawn = Math.max(3, Math.min(agentCount, tasks.length || 4));
  for (let idx = 0; idx < linksToSpawn; idx += 1) {
    agentLinks.push({ source: "bidding", target: `agent-${idx}`, value: 4 + (idx % 3) });
    agentLinks.push({ source: `agent-${idx}`, target: "match", value: 3 + (idx % 2) });
  }

  return [...flowLinks, ...agentLinks];
}

function buildResults(tasks: CompetitionTask[], agents: Agent[]): CompetitionResult[] {
  if (!tasks.length) return [];

  const agentNames = agents.length
    ? agents.map((agent, index) => pickAgentName(agent, index))
    : FALLBACK_AGENT_NAMES;

  return tasks.slice(0, 6).map((task, index) => {
    const winner = task.assignedAgentId
      ? pickAgentName(agents.find((agent) => agent.agent_id === task.assignedAgentId), index)
      : agentNames[index % agentNames.length];

    const score = clampScore(78 + (index * 7) % 20);
    const settlement = Math.round(task.bounty * (1 + score / 240));

    return {
      taskId: task.id,
      winner,
      score,
      settlement,
      updatedAt: new Date(Date.now() - index * 8 * 60 * 1000).toISOString()
    };
  });
}

function buildScenarioTask(title: string, index: number, status: CompetitionStatus, bounty: number): CompetitionTask {
  return {
    id: `scenario-${Date.now().toString(36)}-${index}`,
    title,
    status,
    bounty,
    deadline: formatDeadline(4 + index * 2),
    workflow: index % 2 === 0 ? "workflow" : "fishbone",
    assignedAgentId: null
  };
}

function progressTask(task: CompetitionTask, steps: number, assignedAgentId: string | null): CompetitionTask {
  let nextStatus = task.status;
  for (let step = 0; step < steps; step += 1) {
    const currentIndex = STATUS_FLOW.indexOf(nextStatus);
    nextStatus = STATUS_FLOW[Math.min(currentIndex + 1, STATUS_FLOW.length - 1)];
  }

  return {
    ...task,
    status: nextStatus,
    assignedAgentId: nextStatus === "assigned" || nextStatus === "submitted" || nextStatus === "scored" || nextStatus === "settled"
      ? assignedAgentId ?? task.assignedAgentId
      : task.assignedAgentId
  };
}

function getAgentRoster(agents: Agent[]) {
  const live = agents.slice(0, 6);
  if (!live.length) {
    return FALLBACK_AGENT_NAMES.map((name, index) => ({
      agent_id: `mock-agent-${index}`,
      name,
      tier: "Outer",
      lingshi_balance: 200,
      status: "active",
      last_seen: new Date().toISOString()
    } satisfies Agent));
  }
  return live;
}

function createScenarioTasks(scenarioId: CompetitionScenarioId): CompetitionTask[] {
  if (scenarioId === "one_dominant_agent") {
    return [
      buildScenarioTask("Dominant Pattern Arbitration", 1, "bidding", 220),
      buildScenarioTask("Liquidity Shock Replay", 2, "assigned", 180),
      buildScenarioTask("Latency Collapse Root-Cause", 3, "open", 160),
      buildScenarioTask("Order Flow Integrity Scan", 4, "submitted", 205),
      buildScenarioTask("Market Drift Containment", 5, "bidding", 170)
    ];
  }

  if (scenarioId === "high_frequency_task_storm") {
    return [
      buildScenarioTask("Storm Batch #1", 1, "open", 60),
      buildScenarioTask("Storm Batch #2", 2, "bidding", 72),
      buildScenarioTask("Storm Batch #3", 3, "assigned", 88),
      buildScenarioTask("Storm Batch #4", 4, "submitted", 96),
      buildScenarioTask("Storm Batch #5", 5, "open", 64),
      buildScenarioTask("Storm Batch #6", 6, "bidding", 70),
      buildScenarioTask("Storm Batch #7", 7, "open", 58)
    ];
  }

  return [
    buildScenarioTask("Balanced: Cross-Market Signal Scan", 1, "bidding", 120),
    buildScenarioTask("Balanced: Explainability Route", 2, "assigned", 136),
    buildScenarioTask("Balanced: Risk Delta Gate", 3, "submitted", 104),
    buildScenarioTask("Balanced: Settlement Integrity", 4, "open", 142),
    buildScenarioTask("Balanced: Event Replay Compression", 5, "scored", 118)
  ];
}

function buildScenarioResult(task: CompetitionTask, agents: Agent[], tick: number, dominant: boolean): CompetitionResult {
  const dominantAgent = agents[0];
  const winnerAgent = dominant
    ? dominantAgent
    : agents[tick % Math.max(1, agents.length)];

  const winner = pickAgentName(winnerAgent, tick);
  const baseScore = dominant ? 91 : 76;
  const score = clampScore(baseScore + ((tick * 11) % (dominant ? 7 : 16)));
  const settlement = Math.round(task.bounty * (1 + score / (dominant ? 205 : 245)));

  return {
    taskId: task.id,
    winner,
    score,
    settlement,
    updatedAt: new Date().toISOString()
  };
}

function nextScenarioTaskTitle(counter: number) {
  return `Storm Batch #${counter}`;
}

export function createCompetitionData(agents: Agent[], tasks: Task[], events: EventRecord[]): CompetitionData {
  const hasLiveSignals = agents.length > 0 || tasks.length > 0 || events.length > 0;
  const mode: CompetitionData["mode"] = hasLiveSignals ? "live" : "mock";

  const competitionTasks = hasLiveSignals ? buildTasksFromLive(tasks) : buildMockTasks();
  const names = (hasLiveSignals ? agents : []).slice(0, 6).map((agent, index) => pickAgentName(agent, index));
  const agentNames = names.length ? names : FALLBACK_AGENT_NAMES;

  return {
    mode,
    tasks: competitionTasks,
    results: buildResults(competitionTasks, agents),
    graphNodes: buildGraphNodes(agentNames),
    graphLinks: buildGraphLinks(agentNames.length, competitionTasks)
  };
}

export function createScenarioCompetitionData(scenarioId: CompetitionScenarioId, agents: Agent[]): CompetitionData {
  const roster = getAgentRoster(agents);
  const scenarioTasks = createScenarioTasks(scenarioId);
  const names = roster.map((agent, index) => pickAgentName(agent, index));

  return {
    mode: "mock",
    tasks: scenarioTasks,
    results: [],
    graphNodes: buildGraphNodes(names),
    graphLinks: buildGraphLinks(names.length, scenarioTasks)
  };
}

export function advanceCompetitionScenario(
  tasks: CompetitionTask[],
  results: CompetitionResult[],
  agents: Agent[],
  scenarioId: CompetitionScenarioId,
  tick: number
): { tasks: CompetitionTask[]; results: CompetitionResult[] } {
  if (!tasks.length) return { tasks, results };

  const roster = getAgentRoster(agents);
  const dominantAgentId = roster[0]?.agent_id ?? null;
  const nextTasks = [...tasks];
  const newlySettled: CompetitionTask[] = [];

  const baseSteps = scenarioId === "high_frequency_task_storm" ? 2 : 1;
  const candidatesToAdvance = scenarioId === "high_frequency_task_storm" ? 2 : 1;

  let moved = 0;
  for (let index = 0; index < nextTasks.length && moved < candidatesToAdvance; index += 1) {
    const task = nextTasks[index];
    if (task.status === "settled") continue;

    const assignedAgentId = scenarioId === "one_dominant_agent"
      ? dominantAgentId
      : roster[(tick + index) % Math.max(1, roster.length)]?.agent_id ?? null;

    const progressed = progressTask(task, baseSteps, assignedAgentId);
    nextTasks[index] = progressed;

    if (progressed.status === "settled" && !results.some((result) => result.taskId === progressed.id)) {
      newlySettled.push(progressed);
    }

    moved += 1;
  }

  if (scenarioId === "high_frequency_task_storm" && tick % 2 === 0) {
    const counter = nextTasks.length + 1;
    nextTasks.unshift(buildScenarioTask(nextScenarioTaskTitle(counter), counter, "open", 55 + (counter % 8) * 9));
    if (nextTasks.length > 18) {
      nextTasks.length = 18;
    }
  }

  let nextResults = results;
  if (newlySettled.length) {
    const scenarioDominant = scenarioId === "one_dominant_agent";
    const appended = newlySettled.map((task, index) =>
      buildScenarioResult(task, roster, tick + index, scenarioDominant)
    );

    nextResults = [...appended, ...results].slice(0, 12);
  }

  return {
    tasks: nextTasks,
    results: nextResults
  };
}

export function advanceCompetitionTasks(tasks: CompetitionTask[]): CompetitionTask[] {
  if (!tasks.length) return tasks;

  const next = [...tasks];
  const candidateIndex = next.findIndex((task) => task.status !== "settled");
  if (candidateIndex === -1) return next;

  const candidate = next[candidateIndex];
  const statusIndex = STATUS_FLOW.findIndex((item) => item === candidate.status);
  const nextStatus = STATUS_FLOW[Math.min(statusIndex + 1, STATUS_FLOW.length - 1)];
  next[candidateIndex] = {
    ...candidate,
    status: nextStatus
  };

  return next;
}

export function buildResultForTask(task: CompetitionTask, agents: Agent[], seed: number): CompetitionResult {
  const winner = pickAgentName(agents[seed % Math.max(1, agents.length)], seed);
  const score = clampScore(72 + (seed * 13) % 27);

  return {
    taskId: task.id,
    winner,
    score,
    settlement: Math.round(task.bounty * (1 + score / 250)),
    updatedAt: new Date().toISOString()
  };
}

export function mapPublishedTask(input: PublishTaskInput): CompetitionTask {
  return {
    id: `publish-${Date.now().toString(36)}`,
    title: input.title,
    status: "open",
    bounty: input.bounty,
    deadline: new Date(input.deadline).toISOString(),
    workflow: "workflow",
    assignedAgentId: null
  };
}
