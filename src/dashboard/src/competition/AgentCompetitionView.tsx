import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import * as echarts from "echarts";

import type { Agent, EventRecord, Task } from "../types";
import { translations, type DashboardLang } from "../i18n";
import {
  advanceCompetitionScenario,
  advanceCompetitionTasks,
  buildResultForTask,
  COMPETITION_SCENARIO_IDS,
  createCompetitionData,
  createScenarioCompetitionData,
  mapPublishedTask,
  type CompetitionResult,
  type CompetitionScenarioId,
  type CompetitionStatus
} from "./dataAdapter";

const STATUS_COLUMNS: CompetitionStatus[] = ["open", "bidding", "assigned", "submitted", "scored", "settled"];

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
  lang: DashboardLang;
}

function wsStatusLabel(lang: DashboardLang, status: "offline" | "connecting" | "online" | "error") {
  if (lang === "en") return status.toUpperCase();
  if (status === "online") return "在线";
  if (status === "connecting") return "连接中";
  if (status === "offline") return "离线";
  return "错误";
}

export function AgentCompetitionView({ agents, tasks, events, wsStatus, lang }: AgentCompetitionViewProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const flowTick = useRef(0);
  const scenarioTick = useRef(0);

  const [competitionData, setCompetitionData] = useState(() => createCompetitionData(agents, tasks, events));
  const [selectedScenarioId, setSelectedScenarioId] = useState<CompetitionScenarioId>("balanced_competition");
  const [activeScenarioId, setActiveScenarioId] = useState<CompetitionScenarioId | null>(null);
  const [isScenarioPlaying, setIsScenarioPlaying] = useState(false);
  const [scenarioSpeedMs, setScenarioSpeedMs] = useState(900);

  const [publishTitle, setPublishTitle] = useState("Neural Arbitrage Detection");
  const [publishBounty, setPublishBounty] = useState(128);
  const [publishDeadline, setPublishDeadline] = useState(() => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return future.toISOString().slice(0, 16);
  });

  const text = translations[lang].competition;

  const statusLabels: Record<CompetitionStatus, string> = {
    open: text.statusOpen,
    bidding: text.statusBidding,
    assigned: text.statusAssigned,
    submitted: text.statusSubmitted,
    scored: text.statusScored,
    settled: text.statusSettled
  };

  const scenarioOptions = useMemo(() => {
    return {
      balanced_competition: {
        name: text.scenarioBalancedName,
        description: text.scenarioBalancedDesc
      },
      one_dominant_agent: {
        name: text.scenarioDominantName,
        description: text.scenarioDominantDesc
      },
      high_frequency_task_storm: {
        name: text.scenarioStormName,
        description: text.scenarioStormDesc
      }
    } satisfies Record<CompetitionScenarioId, { name: string; description: string }>;
  }, [
    text.scenarioBalancedDesc,
    text.scenarioBalancedName,
    text.scenarioDominantDesc,
    text.scenarioDominantName,
    text.scenarioStormDesc,
    text.scenarioStormName
  ]);

  useEffect(() => {
    if (activeScenarioId) return;
    setCompetitionData(createCompetitionData(agents, tasks, events));
  }, [agents, tasks, events, activeScenarioId]);

  useEffect(() => {
    if (activeScenarioId) {
      if (!isScenarioPlaying) return;
      const timer = window.setInterval(() => {
        scenarioTick.current += 1;
        setCompetitionData((prev) => {
          const next = advanceCompetitionScenario(prev.tasks, prev.results, agents, activeScenarioId, scenarioTick.current);
          return {
            ...prev,
            tasks: next.tasks,
            results: next.results
          };
        });
      }, scenarioSpeedMs);
      return () => window.clearInterval(timer);
    }

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
  }, [activeScenarioId, agents, competitionData.mode, isScenarioPlaying, scenarioSpeedMs, wsStatus]);

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
      const edgeCount = Math.max(competitionData.graphLinks.length, 1);
      const activeHead = tick % edgeCount;
      return {
        backgroundColor: "transparent",
        tooltip: {
          trigger: "item",
          formatter: (params: { dataType?: string; data?: { source?: string; target?: string; value?: number; name?: string } }) => {
            if (params.dataType === "edge") {
              const source = params.data?.source ?? "-";
              const target = params.data?.target ?? "-";
              const value = params.data?.value ?? 0;
              return `${source} -> ${target}<br/>Flow: ${value}`;
            }
            return `${params.data?.name ?? "Node"}`;
          }
        },
        legend: {
          top: 4,
          left: "center",
          itemWidth: 12,
          itemHeight: 8,
          textStyle: {
            color: "#cce2ff",
            fontSize: 11,
            fontFamily: "IBM Plex Mono"
          },
          data: [text.graphLegendFlow, text.graphLegendAgent]
        },
        animationDurationUpdate: 420,
        animationEasingUpdate: "cubicOut",
        series: [
          {
            type: "graph",
            coordinateSystem: null,
            layout: "none",
            roam: true,
            draggable: false,
            symbol: "circle",
            emphasis: {
              focus: "adjacency"
            },
            label: {
              show: true,
              position: "inside",
              color: "#f5fcff",
              fontFamily: "IBM Plex Mono",
              fontSize: 11,
              formatter: (params: { data: { name: string } }) => params.data.name
            },
            categories: [
              { name: text.graphLegendFlow },
              { name: text.graphLegendAgent }
            ],
            data: competitionData.graphNodes.map((node) => ({
              ...node,
              symbol: node.category === 0 ? "roundRect" : "circle",
              symbolSize: node.category === 0 ? [86, 34] : 50,
              itemStyle: {
                color: node.category === 0 ? "#183153" : "#261739",
                borderColor: node.category === 0 ? "#3efcc4" : "#ff65db",
                borderWidth: node.category === 0 ? 2.2 : 1.8,
                shadowBlur: node.category === 0 ? 26 : 18,
                shadowColor: node.category === 0 ? "rgba(62,252,196,0.52)" : "rgba(255,101,219,0.46)"
              },
              label: {
                position: node.category === 0 ? "inside" : "right",
                fontSize: node.category === 0 ? 11 : 10,
                padding: node.category === 0 ? 0 : [0, 0, 0, 6],
                color: node.category === 0 ? "#e9f8ff" : "#ffd8f5"
              }
            })),
            links: competitionData.graphLinks.map((link, index) => {
              const distance = Math.abs(index - activeHead);
              const wrappedDistance = Math.min(distance, edgeCount - distance);
              const activeBand = wrappedDistance <= 1;

              return {
                ...link,
                lineStyle: {
                  color: activeBand ? "#58e8ff" : "rgba(130, 226, 255, 0.3)",
                  width: activeBand ? 3.4 : 1.4,
                  opacity: activeBand ? 0.98 : 0.5,
                  curveness: index % 2 === 0 ? 0.18 : -0.16,
                  shadowBlur: activeBand ? 14 : 0,
                  shadowColor: "rgba(88,232,255,0.56)"
                }
              };
            }),
            edgeSymbol: ["none", "arrow"],
            edgeSymbolSize: [0, 10]
          }
        ]
      };
    };

    chart.setOption(buildChartOption());

    const pulse = window.setInterval(() => {
      flowTick.current += 1;
      chart.setOption(buildChartOption());
    }, 420);

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.clearInterval(pulse);
      window.removeEventListener("resize", onResize);
    };
  }, [competitionData.graphLinks, competitionData.graphNodes, text.graphLegendAgent, text.graphLegendFlow]);

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

  const handleLoadScenario = () => {
    scenarioTick.current = 0;
    setActiveScenarioId(selectedScenarioId);
    setIsScenarioPlaying(true);
    setCompetitionData(createScenarioCompetitionData(selectedScenarioId, agents));
  };

  const handleReturnLive = () => {
    scenarioTick.current = 0;
    setIsScenarioPlaying(false);
    setActiveScenarioId(null);
    setCompetitionData(createCompetitionData(agents, tasks, events));
  };

  const handleStep = () => {
    if (!activeScenarioId) return;
    scenarioTick.current += 1;
    setCompetitionData((prev) => {
      const next = advanceCompetitionScenario(prev.tasks, prev.results, agents, activeScenarioId, scenarioTick.current);
      return {
        ...prev,
        tasks: next.tasks,
        results: next.results
      };
    });
  };

  const latestResult: CompetitionResult | null = competitionData.results[0] ?? null;
  const currentScenario = activeScenarioId ? scenarioOptions[activeScenarioId] : scenarioOptions[selectedScenarioId];

  const sourceBadge = activeScenarioId
    ? text.modeScenario
    : competitionData.mode === "live"
      ? text.modeLive
      : text.modeMock;

  return (
    <section className="competition-wrap">
      <div className="competition-banner">
        <div>
          <p className="eyebrow">{text.eyebrow}</p>
          <h2>{text.title}</h2>
          <p className="sub">{text.subtitle}</p>
        </div>
        <div className="competition-badges">
          <span className={`mode-badge ${activeScenarioId ? "mock" : competitionData.mode}`}>{sourceBadge}</span>
          <span className={`mode-badge ${wsStatus}`}>WS {wsStatusLabel(lang, wsStatus)}</span>
        </div>
      </div>

      <div className="competition-graph panel">
        <div className="panel-header">
          <h2>{text.flowMesh}</h2>
          <span>{text.flowMeshSub}</span>
        </div>
        <div className="panel-body">
          <div className="competition-chart" ref={chartRef} />
          <div className="graph-legend">
            <div><span className="legend-dot flow" /> {text.graphLegendFlow}</div>
            <div><span className="legend-dot agent" /> {text.graphLegendAgent}</div>
            <div><span className="legend-line active" /> {text.graphLegendActiveLink}</div>
            <div><span className="legend-line base" /> {text.graphLegendBaseLink}</div>
          </div>
        </div>
      </div>

      <div className="competition-panels">
        <section className="panel publish-panel">
          <div className="panel-header">
            <h2>{text.publishTask}</h2>
            <span>{text.publishTaskSub}</span>
          </div>
          <div className="panel-body scenario-controls">
            <div className="scenario-header">
              <strong>{text.scenarioControls}</strong>
              <small>{currentScenario.description}</small>
            </div>
            <div className="scenario-row">
              <label htmlFor="scenario-select">{text.scenario}</label>
              <select
                id="scenario-select"
                value={selectedScenarioId}
                onChange={(event) => setSelectedScenarioId(event.target.value as CompetitionScenarioId)}
              >
                {COMPETITION_SCENARIO_IDS.map((scenarioId) => (
                  <option key={scenarioId} value={scenarioId}>
                    {scenarioOptions[scenarioId].name}
                  </option>
                ))}
              </select>
            </div>
            <div className="scenario-actions">
              <button type="button" onClick={handleLoadScenario}>{text.loadScenario}</button>
              <button type="button" className="ghost" onClick={handleReturnLive}>{text.returnLive}</button>
              <button type="button" className="ghost" onClick={() => setIsScenarioPlaying((prev) => !prev)} disabled={!activeScenarioId}>
                {isScenarioPlaying ? text.pause : text.play}
              </button>
              <button type="button" className="ghost" onClick={handleStep} disabled={!activeScenarioId}>{text.step}</button>
            </div>
            <div className="scenario-row speed-row">
              <label htmlFor="scenario-speed">{text.speed}</label>
              <input
                id="scenario-speed"
                type="range"
                min={350}
                max={1800}
                step={50}
                value={scenarioSpeedMs}
                onChange={(event) => setScenarioSpeedMs(Number(event.target.value))}
                disabled={!activeScenarioId}
              />
              <small>{scenarioSpeedMs}ms</small>
            </div>
          </div>
          <form className="panel-body publish-form" onSubmit={handlePublishTask}>
            <label>
              <span>{text.titleLabel}</span>
              <input
                value={publishTitle}
                onChange={(event) => setPublishTitle(event.target.value)}
                placeholder={text.titlePlaceholder}
              />
            </label>
            <label>
              <span>{text.bountyLabel}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={publishBounty}
                onChange={(event) => setPublishBounty(Number(event.target.value))}
              />
            </label>
            <label>
              <span>{text.deadlineLabel}</span>
              <input
                type="datetime-local"
                value={publishDeadline}
                onChange={(event) => setPublishDeadline(event.target.value)}
              />
            </label>
            <button type="submit">{text.publishAction}</button>
          </form>
        </section>

        <section className="panel execution-panel">
          <div className="panel-header">
            <h2>{text.executionStatus}</h2>
            <span>{text.executionStatusSub}</span>
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
                  {tasksByStatus[status].length === 0 && <p className="muted">{text.noTasks}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel results-panel">
          <div className="panel-header">
            <h2>{text.taskResults}</h2>
            <span>{text.taskResultsSub}</span>
          </div>
          <div className="panel-body results-body">
            {latestResult ? (
              <div className="winner-card">
                <p className="winner-label">{text.currentWinner}</p>
                <strong>{latestResult.winner}</strong>
                <p>{text.score}: {latestResult.score}</p>
                <p>{text.settlement}: {latestResult.settlement} LSP</p>
              </div>
            ) : (
              <p className="muted">{text.waitingForResults}</p>
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
              {!competitionData.results.length && <p className="muted">{text.noResults}</p>}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
