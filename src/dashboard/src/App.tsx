import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";

import { AgentCompetitionView } from "./competition/AgentCompetitionView";
import type { Agent, EventRecord, LedgerEntry, Task } from "./types";
import {
  DASHBOARD_LANG_STORAGE_KEY,
  getStoredLanguage,
  statusLabelFromLang,
  translations,
  type DashboardLang
} from "./i18n";

const STATUS_COLUMNS = ["open", "bidding", "assigned", "submitted", "scored", "settled"] as const;

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

function wsStatusLabel(lang: DashboardLang, status: "offline" | "connecting" | "online" | "error") {
  if (lang === "en") return status.toUpperCase();
  if (status === "online") return "在线";
  if (status === "connecting") return "连接中";
  if (status === "offline") return "离线";
  return "错误";
}

export default function App() {
  const [lang, setLang] = useState<DashboardLang>(getStoredLanguage);
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

  const appText = translations[lang].app;
  const statusLabels = statusLabelFromLang(lang);

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
      const createdAtMs = timestamp ? Date.parse(timestamp) : Number.NaN;
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
    localStorage.setItem(DASHBOARD_LANG_STORAGE_KEY, lang);
  }, [lang]);

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
            { value: tierCounts.Elder, name: appText.tierElder, itemStyle: { color: "#ffb457" } },
            { value: tierCounts.Core, name: appText.tierCore, itemStyle: { color: "#6dd3ff" } },
            { value: tierCounts.Outer, name: appText.tierOuter, itemStyle: { color: "#7ce0a7" } }
          ]
        }
      ]
    });

    const handleResize = () => tierChartInstance.current?.resize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [appText.tierCore, appText.tierElder, appText.tierOuter, tierCounts]);

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
            const next = [
              ...prev,
              {
                seq: payload.seq ?? 0,
                id: `${payload.seq}`,
                event_type: payload.type ?? "event",
                payload: payload.payload ?? null,
                created_at: payload.emitted_at ?? new Date().toISOString()
              }
            ];
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
          <p className="eyebrow">{appText.eyebrow}</p>
          <h1>{appText.title}</h1>
          <p className="sub">{appText.subtitle}</p>
        </div>
        <div className="topbar-controls">
          <div className="lang-switch" role="group" aria-label={appText.language}>
            <span>{appText.language}</span>
            <button
              type="button"
              className={lang === "zh" ? "lang-btn active" : "lang-btn"}
              onClick={() => setLang("zh")}
            >
              ZH
            </button>
            <button
              type="button"
              className={lang === "en" ? "lang-btn active" : "lang-btn"}
              onClick={() => setLang("en")}
            >
              EN
            </button>
          </div>
          <div className="ws-card">
            <div className="ws-row">
              <label>{appText.wsToken}</label>
              <input
                value={wsToken}
                onChange={(event) => setWsToken(event.target.value)}
                placeholder={appText.wsTokenPlaceholder}
              />
            </div>
            <div className="ws-actions">
              <button onClick={connectWebsocket} disabled={!wsToken || wsStatus === "online" || wsStatus === "connecting"}>
                {wsStatus === "connecting" ? appText.connecting : appText.connect}
              </button>
              <button onClick={disconnectWebsocket} disabled={wsStatus === "offline"} className="ghost">
                {appText.disconnect}
              </button>
              <span className={`ws-status ${wsStatus}`}>{wsStatusLabel(lang, wsStatus)}</span>
            </div>
          </div>
        </div>
      </header>

      <section className="metrics">
        <div className="metric">
          <span>{appText.activeAgents}</span>
          <strong>{activeAgents}</strong>
          <em>
            {agents.length} {appText.total}
          </em>
        </div>
        <div className="metric">
          <span>{appText.taskCompletion}</span>
          <strong>{completionRate}%</strong>
          <em>
            {tasks.length} {appText.tasks}
          </em>
        </div>
        <div className="metric">
          <span>{appText.totalLingshi}</span>
          <strong>{totalLingshi.toFixed(1)}</strong>
          <em>{appText.circulation}</em>
        </div>
        <div className="metric">
          <span>{appText.ledgerEntries}</span>
          <strong>{ledger.length}</strong>
          <em>{appText.latestUpdates}</em>
        </div>
      </section>

      <section className="view-switch">
        <button
          type="button"
          className={activeView === "overview" ? "tab-btn active" : "tab-btn ghost"}
          onClick={() => setActiveView("overview")}
        >
          {appText.overview}
        </button>
        <button
          type="button"
          className={activeView === "competition" ? "tab-btn active" : "tab-btn ghost"}
          onClick={() => setActiveView("competition")}
        >
          {appText.agentCompetition}
        </button>
      </section>

      {activeView === "overview" ? (
        <main className="grid">
          <section className="panel leaderboard">
            <div className="panel-header">
              <h2>{appText.leaderboard}</h2>
              <span>{appText.leaderboardSub}</span>
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
              {!leaderboard.length && <p className="muted">{appText.noAgentData}</p>}
            </div>
          </section>

          <section className="panel kanban">
            <div className="panel-header">
              <h2>{appText.taskPool}</h2>
              <span>{appText.taskPoolSub}</span>
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
                    {(tasksByStatus[status] ?? []).length === 0 && <p className="muted">{appText.noTasks}</p>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel ecosystem">
            <div className="panel-header">
              <h2>{appText.ecosystemHealth}</h2>
              <span>{appText.ecosystemHealthSub}</span>
            </div>
            <div className="panel-body ecosystem-body">
              <div className="ecosystem-score">
                <span>{appText.healthIndex}</span>
                <strong>{ecosystemScore}</strong>
                <em>{appText.compositeScore}</em>
              </div>
              <div className="ecosystem-metrics">
                <div>
                  <span>{appText.activeRatio}</span>
                  <strong>{activeRatio}%</strong>
                </div>
                <div>
                  <span>{appText.backlog}</span>
                  <strong>{backlogCount}</strong>
                </div>
                <div>
                  <span>{appText.inProgress}</span>
                  <strong>{inProgressCount}</strong>
                </div>
                <div>
                  <span>{appText.lingshiVelocity}</span>
                  <strong>{ledgerVelocity.toFixed(1)}</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="panel health">
            <div className="panel-header">
              <h2>{appText.tierDistribution}</h2>
              <span>{appText.tierDistributionSub}</span>
            </div>
            <div className="panel-body">
              <div className="tier-chart" ref={tierChartRef} />
              <div className="tier-legend">
                <div>
                  <span className="dot elder" /> {appText.tierElder} <strong>{tierCounts.Elder}</strong>
                </div>
                <div>
                  <span className="dot core" /> {appText.tierCore} <strong>{tierCounts.Core}</strong>
                </div>
                <div>
                  <span className="dot outer" /> {appText.tierOuter} <strong>{tierCounts.Outer}</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="panel events">
            <div className="panel-header">
              <h2>{appText.realtimeEvents}</h2>
              <span>{loading ? appText.loading : `${appText.lastEvents} ${events.length}`}</span>
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
              {!events.length && <p className="muted">{appText.noEvents}</p>}
            </div>
          </section>
        </main>
      ) : (
        <AgentCompetitionView agents={agents} tasks={tasks} events={events} wsStatus={wsStatus} lang={lang} />
      )}
    </div>
  );
}
