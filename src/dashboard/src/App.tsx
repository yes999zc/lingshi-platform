import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { AgentCompetitionView } from "./competition/AgentCompetitionView";
import type { Agent, EventRecord, LedgerEntry, Task } from "./types";

const STATUS_COLUMNS = ["open", "bidding", "assigned", "submitted", "scored", "settled"] as const;

const statusLabels: Record<string, string> = {
  open: "Open",
  bidding: "Bidding",
  assigned: "Assigned",
  submitted: "Submitted",
  scored: "Scored",
  settled: "Settled"
};

const statusColors: Record<string, string> = {
  open: "#f6c45c",
  bidding: "#f58a58",
  assigned: "#7ddc9a",
  submitted: "#6ac7ff",
  scored: "#8a7dff",
  settled: "#d39bff"
};

function normalizeTier(raw: string | null | undefined) {
  if (!raw) return "Outer";
  const normalized = raw.trim();
  if (!normalized) return "Outer";
  const canonical = normalized[0].toUpperCase() + normalized.slice(1).toLowerCase();
  if (canonical === "Core" || canonical === "Elder" || canonical === "Outer") return canonical;
  return "Outer";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export default function App() {
  const [activeView, setActiveView] = useState<"overview" | "competition">("overview");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [wsStatus, setWsStatus] = useState<"offline" | "connecting" | "online" | "error">("offline");
  const [wsToken, setWsToken] = useState(() => localStorage.getItem("dashboard_token") ?? "");
  const [lastSeq, setLastSeq] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const eventStreamRef = useRef<HTMLDivElement | null>(null);
  const tierChartRef = useRef<HTMLDivElement | null>(null);
  const tierChartInstance = useRef<echarts.ECharts | null>(null);

  const totalLingshi = useMemo(() => agents.reduce((sum, agent) => sum + (agent.lingshi_balance || 0), 0), [agents]);
  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status === "online" || agent.status === "active").length,
    [agents]
  );
  const completionRate = useMemo(() => {
    if (!tasks.length) return 0;
    const settled = tasks.filter((task) => task.status === "settled").length;
    return Math.round((settled / tasks.length) * 100);
  }, [tasks]);

  const activeRatio = useMemo(() => {
    if (!agents.length) return 0;
    return Math.round((activeAgents / agents.length) * 100);
  }, [activeAgents, agents.length]);

  const backlogCount = useMemo(
    () => tasks.filter((task) => task.status === "open" || task.status === "bidding").length,
    [tasks]
  );

  const inProgressCount = useMemo(
    () => tasks.filter((task) => task.status === "assigned" || task.status === "submitted" || task.status === "scored").length,
    [tasks]
  );

  const ledgerVelocity = useMemo(() => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let total = 0;
    for (const entry of ledger) {
      const timestamp = entry.createdAt ?? entry.created_at;
      const createdAtMs = timestamp ? Date.parse(timestamp) : NaN;
      if (Number.isFinite(createdAtMs) && createdAtMs >= dayAgo) {
        total += Math.abs(entry.amount ?? 0);
      }
    }
    return total;
  }, [ledger]);

  const ecosystemScore = useMemo(() => {
    const completionFactor = completionRate / 100;
    const activityFactor = agents.length ? activeAgents / agents.length : 0;
    const backlogFactor = tasks.length ? 1 - Math.min(1, backlogCount / tasks.length) : 1;
    return Math.round((completionFactor * 0.4 + activityFactor * 0.4 + backlogFactor * 0.2) * 100);
  }, [completionRate, activeAgents, agents.length, backlogCount, tasks.length]);

  const tierCounts = useMemo(() => {
    const counts = { Outer: 0, Core: 0, Elder: 0 };
    agents.forEach((agent) => {
      counts[normalizeTier(agent.tier) as keyof typeof counts] += 1;
    });
    return counts;
  }, [agents]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    STATUS_COLUMNS.forEach((status) => {
      grouped[status] = [];
    });
    tasks.forEach((task) => {
      const status = task.status || "open";
      if (!grouped[status]) {
        grouped[status] = [];
      }
      grouped[status].push(task);
    });
    return grouped;
  }, [tasks]);

  const leaderboard = useMemo(
    () =>
      [...agents]
        .sort((a, b) => (b.lingshi_balance || 0) - (a.lingshi_balance || 0))
        .slice(0, 12),
    [agents]
  );

  const scheduleRefresh = () => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshData();
    }, 600);
  };

  const refreshData = async () => {
    try {
      const [agentsRes, tasksRes, ledgerRes, eventsRes] = await Promise.all([
        fetchJson<{ data: { agents: Agent[] } }>("/api/agents"),
        fetchJson<{ data: { tasks: Task[] } }>("/api/tasks"),
        fetchJson<{ data: LedgerEntry[] }>("/api/ledger"),
        fetchJson<{ data: { events: EventRecord[] } }>("/api/events?limit=50")
      ]);

      setAgents(agentsRes.data.agents ?? []);
      setTasks(tasksRes.data.tasks ?? []);
      setLedger(ledgerRes.data ?? []);
      setEvents(eventsRes.data.events ?? []);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshData();
    const timer = window.setInterval(() => void refreshData(), 12000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem("dashboard_token", wsToken);
  }, [wsToken]);

  useEffect(() => {
    if (!tierChartRef.current) return;

    if (!tierChartInstance.current) {
      tierChartInstance.current = echarts.init(tierChartRef.current);
    }

    tierChartInstance.current.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        formatter: "{b}: {c} ({d}%)"
      },
      series: [
        {
          type: "pie",
          radius: ["46%", "76%"],
          center: ["50%", "50%"],
          label: {
            color: "#e6eefc",
            fontFamily: "IBM Plex Mono",
            fontSize: 11
          },
          labelLine: {
            lineStyle: {
              color: "rgba(255,255,255,0.25)"
            }
          },
          data: [
            { value: tierCounts.Elder, name: "Elder", itemStyle: { color: "#ffb457" } },
            { value: tierCounts.Core, name: "Core", itemStyle: { color: "#6dd3ff" } },
            { value: tierCounts.Outer, name: "Outer", itemStyle: { color: "#7ce0a7" } }
          ]
        }
      ]
    });

    const handleResize = () => tierChartInstance.current?.resize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [tierCounts]);

  useEffect(() => {
    if (eventStreamRef.current) {
      eventStreamRef.current.scrollTop = eventStreamRef.current.scrollHeight;
    }
  }, [events]);

  const connectWebsocket = () => {
    if (!wsToken || wsStatus === "connecting" || wsStatus === "online") return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    const since = lastSeq ?? undefined;
    const url = new URL(`${protocol}://${host}/ws`);
    url.searchParams.set("token", wsToken);
    if (since !== undefined) {
      url.searchParams.set("since", String(since));
    }

    setWsStatus("connecting");
    const socket = new WebSocket(url.toString());
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      setWsStatus("online");
    });

    socket.addEventListener("close", () => {
      setWsStatus("offline");
    });

    socket.addEventListener("error", () => {
      setWsStatus("error");
    });

    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data as string) as {
          type?: string;
          seq?: number;
          payload?: unknown;
          emitted_at?: string;
          last_seq?: number | null;
        };

        if (payload.type === "connected") {
          if (payload.last_seq !== undefined && payload.last_seq !== null) {
            setLastSeq(payload.last_seq);
          }
          return;
        }

        if (typeof payload.seq === "number" && payload.type) {
          setLastSeq(payload.seq);
          setEvents((prev) => {
            const next = [...prev, {
              seq: payload.seq ?? 0,
              id: `${payload.seq}`,
              event_type: payload.type ?? "event",
              payload: payload.payload ?? null,
              created_at: payload.emitted_at ?? new Date().toISOString()
            }];
            return next.slice(-50);
          });
          scheduleRefresh();
        }
      } catch {
        // ignore malformed messages
      }
    });
  };

  const disconnectWebsocket = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setWsStatus("offline");
  };

  return (
    <div className="app">
      <div className="bg-glow" />
      <header className="topbar">
        <div>
          <p className="eyebrow">Lingshi Platform · Realtime Arena</p>
          <h1>Command Center</h1>
          <p className="sub">全局态势、任务竞标、灵石流动与事件回放</p>
        </div>
        <div className="ws-card">
          <div className="ws-row">
            <label>WS Token</label>
            <input
              value={wsToken}
              onChange={(event) => setWsToken(event.target.value)}
              placeholder="Paste agent token"
            />
          </div>
          <div className="ws-actions">
            <button onClick={connectWebsocket} disabled={!wsToken || wsStatus === "online" || wsStatus === "connecting"}>
              {wsStatus === "connecting" ? "Connecting" : "Connect"}
            </button>
            <button onClick={disconnectWebsocket} disabled={wsStatus === "offline"} className="ghost">
              Disconnect
            </button>
            <span className={`ws-status ${wsStatus}`}>{wsStatus.toUpperCase()}</span>
          </div>
        </div>
      </header>

      <section className="metrics">
        <div className="metric">
          <span>Active Agents</span>
          <strong>{activeAgents}</strong>
          <em>{agents.length} total</em>
        </div>
        <div className="metric">
          <span>Task Completion</span>
          <strong>{completionRate}%</strong>
          <em>{tasks.length} tasks</em>
        </div>
        <div className="metric">
          <span>Total Lingshi</span>
          <strong>{totalLingshi.toFixed(1)}</strong>
          <em>circulation</em>
        </div>
        <div className="metric">
          <span>Ledger Entries</span>
          <strong>{ledger.length}</strong>
          <em>latest updates</em>
        </div>
      </section>

      <section className="view-switch">
        <button
          type="button"
          className={activeView === "overview" ? "tab-btn active" : "tab-btn ghost"}
          onClick={() => setActiveView("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={activeView === "competition" ? "tab-btn active" : "tab-btn ghost"}
          onClick={() => setActiveView("competition")}
        >
          Agent Competition
        </button>
      </section>

      {activeView === "overview" ? (
        <main className="grid">
          <section className="panel leaderboard">
            <div className="panel-header">
              <h2>Leaderboard</h2>
              <span>Top balances + tier + presence</span>
            </div>
            <div className="panel-body">
              {leaderboard.map((agent, index) => (
                <div className="leader-item" key={agent.agent_id}>
                  <div>
                    <p className="leader-name">#{index + 1} {agent.name || agent.agent_id.slice(0, 6)}</p>
                    <p className="leader-meta">{agent.agent_id.slice(0, 10)} · {normalizeTier(agent.tier)}</p>
                  </div>
                  <div className="leader-right">
                    <span className={`status-dot ${agent.status === "online" ? "online" : "offline"}`} />
                    <strong>{agent.lingshi_balance.toFixed(1)}</strong>
                  </div>
                </div>
              ))}
              {!leaderboard.length && <p className="muted">暂无 agent 数据</p>}
            </div>
          </section>

          <section className="panel kanban">
            <div className="panel-header">
              <h2>Task Pool</h2>
              <span>Open → Settled lifecycle</span>
            </div>
            <div className="kanban-body">
              {STATUS_COLUMNS.map((status) => (
                <div className="kanban-col" key={status}>
                  <div className="kanban-head" style={{ borderColor: statusColors[status] }}>
                    <span>{statusLabels[status]}</span>
                    <strong>{tasksByStatus[status]?.length ?? 0}</strong>
                  </div>
                  <div className="kanban-list">
                    {(tasksByStatus[status] ?? []).slice(0, 6).map((task) => (
                      <div className="task-card" key={task.id}>
                        <p className="task-title">{task.title}</p>
                        <p className="task-meta">{task.id.slice(0, 8)} · {task.bounty_lingshi} LSP</p>
                      </div>
                    ))}
                    {(tasksByStatus[status] ?? []).length === 0 && <p className="muted">暂无任务</p>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel ecosystem">
            <div className="panel-header">
              <h2>生态健康</h2>
              <span>活跃度 · 完成率 · 灵石流速</span>
            </div>
            <div className="panel-body ecosystem-body">
              <div className="ecosystem-score">
                <span>Health Index</span>
                <strong>{ecosystemScore}</strong>
                <em>综合评分</em>
              </div>
              <div className="ecosystem-metrics">
                <div>
                  <span>Active Ratio</span>
                  <strong>{activeRatio}%</strong>
                </div>
                <div>
                  <span>Backlog</span>
                  <strong>{backlogCount}</strong>
                </div>
                <div>
                  <span>In Progress</span>
                  <strong>{inProgressCount}</strong>
                </div>
                <div>
                  <span>Lingshi Velocity</span>
                  <strong>{ledgerVelocity.toFixed(1)}</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="panel health">
            <div className="panel-header">
              <h2>Tier Distribution</h2>
              <span>Elder / Core / Outer</span>
            </div>
            <div className="panel-body">
              <div className="tier-chart" ref={tierChartRef} />
              <div className="tier-legend">
                <div>
                  <span className="dot elder" /> Elder <strong>{tierCounts.Elder}</strong>
                </div>
                <div>
                  <span className="dot core" /> Core <strong>{tierCounts.Core}</strong>
                </div>
                <div>
                  <span className="dot outer" /> Outer <strong>{tierCounts.Outer}</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="panel events">
            <div className="panel-header">
              <h2>Realtime Event Stream</h2>
              <span>{loading ? "Loading" : `Last ${events.length} events`}</span>
            </div>
            <div className="panel-body events-body" ref={eventStreamRef}>
              {events.map((eventItem) => (
                <div className="event-row" key={`${eventItem.seq}-${eventItem.id}`}>
                  <div>
                    <p className="event-type">{eventItem.event_type}</p>
                    <p className="event-time">{new Date(eventItem.created_at).toLocaleTimeString()}</p>
                  </div>
                  <code>{JSON.stringify(eventItem.payload)}</code>
                </div>
              ))}
              {!events.length && <p className="muted">暂无事件</p>}
            </div>
          </section>
        </main>
      ) : (
        <AgentCompetitionView agents={agents} tasks={tasks} events={events} wsStatus={wsStatus} />
      )}
    </div>
  );
}
