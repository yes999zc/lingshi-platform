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

const FALLBACK_AGENT_NAMES = ["Nyx-01", "Volt-Prime", "SableCore", "Aurora", "Kite-9"];

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
    { id: "publish", name: "Publish", x: 8, y: 50, category: 0, value: 90 },
    { id: "bidding", name: "Bidding", x: 28, y: 50, category: 0, value: 88 },
    { id: "match", name: "Match", x: 48, y: 50, category: 0, value: 84 },
    { id: "review", name: "Review", x: 68, y: 50, category: 0, value: 86 },
    { id: "settle", name: "Settlement", x: 88, y: 50, category: 0, value: 93 }
  ];

  const offsetY = [22, 76, 30, 68, 16, 84];
  const agentNodes = agentNames.slice(0, 6).map((name, index) => ({
    id: `agent-${index}`,
    name,
    x: 48,
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
    { source: "review", target: "settle", value: 7 }
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
