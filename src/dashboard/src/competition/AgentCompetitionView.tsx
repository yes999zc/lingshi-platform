import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import * as echarts from "echarts";

import type { Agent, EventRecord, Task } from "../types";
import {
  advanceCompetitionTasks,
  buildResultForTask,
  createCompetitionData,
  mapPublishedTask,
  type CompetitionResult,
  type CompetitionStatus
} from "./dataAdapter";

const STATUS_COLUMNS: CompetitionStatus[] = ["open", "bidding", "assigned", "submitted", "scored", "settled"];

const statusLabels: Record<CompetitionStatus, string> = {
  open: "Open",
  bidding: "Bidding",
  assigned: "Assigned",
  submitted: "Submitted",
  scored: "Scored",
  settled: "Settled"
};

const statusColors: Record<CompetitionStatus, string> = {
  open: "#f6c45c",
  bidding: "#ff6f59",
  assigned: "#3efcc4",
  submitted: "#51e2ff",
  scored: "#7fa0ff",
  settled: "#ff65db"
};

interface AgentCompetitionViewProps {
  agents: Agent[];
  tasks: Task[];
  events: EventRecord[];
  wsStatus: "offline" | "connecting" | "online" | "error";
}

export function AgentCompetitionView({ agents, tasks, events, wsStatus }: AgentCompetitionViewProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const flowTick = useRef(0);
  const [competitionData, setCompetitionData] = useState(() => createCompetitionData(agents, tasks, events));

  const [publishTitle, setPublishTitle] = useState("Neural Arbitrage Detection");
  const [publishBounty, setPublishBounty] = useState(128);
  const [publishDeadline, setPublishDeadline] = useState(() => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return future.toISOString().slice(0, 16);
  });

  useEffect(() => {
    setCompetitionData(createCompetitionData(agents, tasks, events));
  }, [agents, tasks, events]);

  useEffect(() => {
    if (competitionData.mode === "live" && wsStatus === "online") {
      return;
    }

    const timer = window.setInterval(() => {
      setCompetitionData((prev) => {
        const nextTasks = advanceCompetitionTasks(prev.tasks);
        const taskToSettle = nextTasks.find((task) => task.status === "settled" && !prev.results.some((result) => result.taskId === task.id));

        let nextResults = prev.results;
        if (taskToSettle) {
          const appended = buildResultForTask(taskToSettle, agents, prev.results.length + 1);
          nextResults = [appended, ...prev.results].slice(0, 10);
        }

        return {
          ...prev,
          tasks: nextTasks,
          results: nextResults
        };
      });
    }, 4500);

    return () => window.clearInterval(timer);
  }, [agents, competitionData.mode, wsStatus]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<CompetitionStatus, typeof competitionData.tasks> = {
      open: [],
      bidding: [],
      assigned: [],
      submitted: [],
      scored: [],
      settled: []
    };

    competitionData.tasks.forEach((task) => {
      grouped[task.status].push(task);
    });

    return grouped;
  }, [competitionData.tasks]);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }

    const chart = chartInstance.current;

    const buildChartOption = () => {
      const tick = flowTick.current;
      return {
        backgroundColor: "transparent",
        tooltip: {
          trigger: "item"
        },
        animationDurationUpdate: 700,
        animationEasingUpdate: "quarticInOut",
        series: [
          {
            type: "graph",
            coordinateSystem: null,
            layout: "none",
            roam: true,
            draggable: false,
            symbol: "circle",
            label: {
              show: true,
              position: "inside",
              color: "#f5fcff",
              fontFamily: "IBM Plex Mono",
              fontSize: 11,
              formatter: (params: { data: { name: string } }) => params.data.name
            },
            categories: [
              { name: "workflow" },
              { name: "agent" }
            ],
            data: competitionData.graphNodes.map((node) => ({
              ...node,
              symbolSize: node.category === 0 ? 70 : 52,
              itemStyle: {
                color: node.category === 0 ? "#1f3354" : "#21213b",
                borderColor: node.category === 0 ? "#3efcc4" : "#ff65db",
                borderWidth: 1.8,
                shadowBlur: node.category === 0 ? 20 : 14,
                shadowColor: node.category === 0 ? "rgba(62,252,196,0.55)" : "rgba(255,101,219,0.42)"
              }
            })),
            links: competitionData.graphLinks.map((link, index) => {
              const active = (index + tick) % Math.max(competitionData.graphLinks.length, 1) === 0;
              return {
                ...link,
                lineStyle: {
                  color: active ? "#58e8ff" : "rgba(130, 226, 255, 0.34)",
                  width: active ? 3.2 : 1.5,
                  opacity: active ? 0.95 : 0.55,
                  curveness: index % 2 === 0 ? 0.2 : -0.2,
                  shadowBlur: active ? 12 : 0,
                  shadowColor: "rgba(88,232,255,0.55)"
                }
              };
            }),
            edgeSymbol: ["none", "arrow"],
            edgeSymbolSize: [0, 8]
          }
        ]
      };
    };

    chart.setOption(buildChartOption());

    const pulse = window.setInterval(() => {
      flowTick.current += 1;
      chart.setOption(buildChartOption());
    }, 900);

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.clearInterval(pulse);
      window.removeEventListener("resize", onResize);
    };
  }, [competitionData.graphLinks, competitionData.graphNodes]);

  useEffect(() => () => {
    chartInstance.current?.dispose();
    chartInstance.current = null;
  }, []);

  const handlePublishTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!publishTitle.trim() || !publishDeadline || !Number.isFinite(publishBounty) || publishBounty <= 0) {
      return;
    }

    const publishedTask = mapPublishedTask({
      title: publishTitle.trim(),
      bounty: publishBounty,
      deadline: publishDeadline
    });

    setCompetitionData((prev) => ({
      ...prev,
      tasks: [publishedTask, ...prev.tasks].slice(0, 18)
    }));

    setPublishTitle("");
    setPublishBounty(96);
  };

  const latestResult: CompetitionResult | null = competitionData.results[0] ?? null;

  return (
    <section className="competition-wrap">
      <div className="competition-banner">
        <div>
          <p className="eyebrow">Cyber Arena · Agent Tournament</p>
          <h2>Agent Competition</h2>
          <p className="sub">Workflow / fishbone-style contest routing with realtime signal glow.</p>
        </div>
        <div className="competition-badges">
          <span className={`mode-badge ${competitionData.mode}`}>{competitionData.mode.toUpperCase()} DATA</span>
          <span className={`mode-badge ${wsStatus}`}>WS {wsStatus.toUpperCase()}</span>
        </div>
      </div>

      <div className="competition-graph panel">
        <div className="panel-header">
          <h2>Competition Flow Mesh</h2>
          <span>Neon data pulse</span>
        </div>
        <div className="panel-body">
          <div className="competition-chart" ref={chartRef} />
        </div>
      </div>

      <div className="competition-panels">
        <section className="panel publish-panel">
          <div className="panel-header">
            <h2>Publish Task</h2>
            <span>Create new bounty</span>
          </div>
          <form className="panel-body publish-form" onSubmit={handlePublishTask}>
            <label>
              <span>Title</span>
              <input
                value={publishTitle}
                onChange={(event) => setPublishTitle(event.target.value)}
                placeholder="e.g. Multi-agent anomaly hunt"
              />
            </label>
            <label>
              <span>Bounty (LSP)</span>
              <input
                type="number"
                min={1}
                step={1}
                value={publishBounty}
                onChange={(event) => setPublishBounty(Number(event.target.value))}
              />
            </label>
            <label>
              <span>Deadline</span>
              <input
                type="datetime-local"
                value={publishDeadline}
                onChange={(event) => setPublishDeadline(event.target.value)}
              />
            </label>
            <button type="submit">Publish</button>
          </form>
        </section>

        <section className="panel execution-panel">
          <div className="panel-header">
            <h2>Task Execution Status</h2>
            <span>Pipeline columns</span>
          </div>
          <div className="execution-board">
            {STATUS_COLUMNS.map((status) => (
              <div className="execution-col" key={status}>
                <div className="execution-head" style={{ borderColor: statusColors[status] }}>
                  <span>{statusLabels[status]}</span>
                  <strong>{tasksByStatus[status].length}</strong>
                </div>
                <div className="execution-list">
                  {tasksByStatus[status].slice(0, 4).map((task) => (
                    <article className="execution-card" key={task.id}>
                      <p>{task.title}</p>
                      <small>{task.bounty} LSP</small>
                    </article>
                  ))}
                  {tasksByStatus[status].length === 0 && <p className="muted">No tasks</p>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel results-panel">
          <div className="panel-header">
            <h2>Task Results</h2>
            <span>Winner + score + settlement</span>
          </div>
          <div className="panel-body results-body">
            {latestResult ? (
              <div className="winner-card">
                <p className="winner-label">Current Winner</p>
                <strong>{latestResult.winner}</strong>
                <p>Score: {latestResult.score}</p>
                <p>Settlement: {latestResult.settlement} LSP</p>
              </div>
            ) : (
              <p className="muted">Waiting for settled tasks</p>
            )}
            <div className="results-table">
              {competitionData.results.slice(0, 6).map((result) => (
                <div className="result-row" key={`${result.taskId}-${result.updatedAt}`}>
                  <div>
                    <p>{result.taskId.slice(0, 10)}</p>
                    <small>{new Date(result.updatedAt).toLocaleTimeString()}</small>
                  </div>
                  <div>
                    <p>{result.winner}</p>
                    <small>{result.score} pts</small>
                  </div>
                  <strong>{result.settlement} LSP</strong>
                </div>
              ))}
              {!competitionData.results.length && <p className="muted">No results yet</p>}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
