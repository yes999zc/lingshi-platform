import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { URL } from "node:url";

import type Database from "better-sqlite3";
import { WebSocket, WebSocketServer } from "ws";

import { createErrorEnvelope } from "../api/error-envelope";
import { hashToken } from "../auth/token";
import { createEventRepository } from "../db/event-repository";
import { getRuleEngine } from "../engine/rule-engine";

interface WebsocketEvent {
  seq: number;
  type: string;
  payload: unknown;
  emitted_at: string;
}

const UPGRADE_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_WS_UPGRADES_PER_MINUTE_PER_IP = 60;
const DEFAULT_WS_UPGRADE_MAX_TRACKED_IPS = 10_000;
const DEFAULT_WS_MAX_CONNECTIONS_PER_AGENT = 5;
const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 15 * 1000;
const UPGRADE_PRUNE_EVERY_REQUESTS = 128;

interface UpgradeRateLimitEntry {
  count: number;
  windowStartedAtMs: number;
  lastSeenAtMs: number;
}

type AuthedWebSocket = WebSocket & {
  agentId?: string;
  awaitingPong?: boolean;
  lastPingSentAtMs?: number;
};

export interface WebsocketEventHooks {
  publishEvent: (eventType: string, payload: unknown) => void;
}

function broadcastEvent(wss: WebSocketServer, event: WebsocketEvent) {
  const serialized = JSON.stringify(event);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  });
}

interface AgentIdRow {
  agent_id: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function resolveUpgradeIp(request: import("node:http").IncomingMessage) {
  const forwarded = request.headers["x-forwarded-for"];

  if (typeof forwarded === "string") {
    const firstIp = forwarded
      .split(",")
      .map((segment) => segment.trim())
      .find((segment) => segment.length > 0);

    if (firstIp) {
      return firstIp;
    }
  }

  return request.socket.remoteAddress ?? "unknown";
}

function statusTextForUpgradeResponse(statusCode: 400 | 401 | 403 | 429) {
  if (statusCode === 400) {
    return "Bad Request";
  }

  if (statusCode === 401) {
    return "Unauthorized";
  }

  if (statusCode === 403) {
    return "Forbidden";
  }

  return "Too Many Requests";
}

function isUpgradeWindowExpired(entry: UpgradeRateLimitEntry, now: number) {
  return now - entry.windowStartedAtMs >= UPGRADE_RATE_WINDOW_MS;
}

function touchUpgradeEntry(counters: Map<string, UpgradeRateLimitEntry>, key: string, entry: UpgradeRateLimitEntry) {
  counters.delete(key);
  counters.set(key, entry);
}

function pruneUpgradeCounters(counters: Map<string, UpgradeRateLimitEntry>, now: number, maxTrackedIps: number) {
  for (const [key, entry] of counters) {
    if (isUpgradeWindowExpired(entry, now)) {
      counters.delete(key);
    }
  }

  if (counters.size <= maxTrackedIps) {
    return;
  }

  const overflow = counters.size - maxTrackedIps;
  const oldestKeys = counters.keys();

  for (let index = 0; index < overflow; index += 1) {
    const oldest = oldestKeys.next();

    if (oldest.done) {
      break;
    }

    counters.delete(oldest.value);
  }
}

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  statusCode: 400 | 401 | 403 | 429,
  message: string,
  options: {
    code?: string;
    headers?: Record<string, string>;
  } = {}
) {
  const body = JSON.stringify(
    createErrorEnvelope(options.code ?? "WS_AUTH_INVALID", message, {
      status_code: statusCode
    })
  );
  const headerLines = [
    `HTTP/1.1 ${statusCode} ${statusTextForUpgradeResponse(statusCode)}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close"
  ];

  if (options.headers) {
    for (const [headerName, headerValue] of Object.entries(options.headers)) {
      headerLines.push(`${headerName}: ${headerValue}`);
    }
  }

  socket.write(
    [
      ...headerLines,
      "",
      body
    ].join("\r\n")
  );
  socket.destroy();
}

export function attachWebsocketServer(server: Server, db: Database.Database) {
  const wss = new WebSocketServer({ noServer: true });
  const rules = getRuleEngine().getConfig();
  const maxUpgradesPerMinutePerIp = parsePositiveInteger(
    process.env.WS_UPGRADE_RATE_LIMIT_PER_MINUTE,
    DEFAULT_WS_UPGRADES_PER_MINUTE_PER_IP
  );
  const maxTrackedUpgradeIps = parsePositiveInteger(
    process.env.WS_UPGRADE_MAX_TRACKED_IPS,
    DEFAULT_WS_UPGRADE_MAX_TRACKED_IPS
  );
  const maxConnectionsPerAgent = parsePositiveInteger(
    process.env.WS_MAX_CONNECTIONS_PER_AGENT,
    rules.websocket.max_connections_per_agent ?? DEFAULT_WS_MAX_CONNECTIONS_PER_AGENT
  );
  const heartbeatIntervalMs = parsePositiveInteger(
    process.env.WS_HEARTBEAT_INTERVAL_MS,
    (rules.websocket.ping_interval_seconds ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS / 1000) * 1000
  );
  const heartbeatTimeoutMs = parsePositiveInteger(
    process.env.WS_HEARTBEAT_TIMEOUT_MS,
    (rules.websocket.ping_timeout_seconds ?? DEFAULT_WS_HEARTBEAT_TIMEOUT_MS / 1000) * 1000
  );
  const maxMissedEventsReplay = rules.websocket.max_missed_events_replay ?? 0;
  const upgradeCounters = new Map<string, UpgradeRateLimitEntry>();
  const pendingUpgradesByAgent = new Map<string, number>();
  const activeSocketsByAgent = new Map<string, Set<AuthedWebSocket>>();
  let upgradeRequestsSincePrune = 0;
  const eventRepository = createEventRepository(db);
  const findAgentByTokenHashQuery = db.prepare(`
    SELECT agent_id
    FROM agents
    WHERE token_hash = ?
  `);

  const getPendingUpgradesForAgent = (agentId: string) => pendingUpgradesByAgent.get(agentId) ?? 0;
  const getActiveConnectionsForAgent = (agentId: string) => activeSocketsByAgent.get(agentId)?.size ?? 0;
  const getTotalOpenSlotsForAgent = (agentId: string) =>
    getActiveConnectionsForAgent(agentId) + getPendingUpgradesForAgent(agentId);

  const incrementPendingUpgrade = (agentId: string) => {
    pendingUpgradesByAgent.set(agentId, getPendingUpgradesForAgent(agentId) + 1);
  };

  const decrementPendingUpgrade = (agentId: string) => {
    const nextValue = getPendingUpgradesForAgent(agentId) - 1;

    if (nextValue <= 0) {
      pendingUpgradesByAgent.delete(agentId);
      return;
    }

    pendingUpgradesByAgent.set(agentId, nextValue);
  };

  const trackActiveSocket = (agentId: string, socket: AuthedWebSocket) => {
    const sockets = activeSocketsByAgent.get(agentId) ?? new Set<AuthedWebSocket>();
    sockets.add(socket);
    activeSocketsByAgent.set(agentId, sockets);
  };

  const untrackActiveSocket = (agentId: string, socket: AuthedWebSocket) => {
    const sockets = activeSocketsByAgent.get(agentId);

    if (!sockets) {
      return;
    }

    sockets.delete(socket);

    if (sockets.size === 0) {
      activeSocketsByAgent.delete(agentId);
    }
  };

  server.on("upgrade", (request, socket, head) => {
    const parsedUrl = new URL(request.url ?? "", "http://localhost");

    if (parsedUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const now = Date.now();
    const requestIp = resolveUpgradeIp(request);
    upgradeRequestsSincePrune += 1;

    if (upgradeRequestsSincePrune >= UPGRADE_PRUNE_EVERY_REQUESTS || upgradeCounters.size > maxTrackedUpgradeIps) {
      pruneUpgradeCounters(upgradeCounters, now, maxTrackedUpgradeIps);
      upgradeRequestsSincePrune = 0;
    }

    const currentCounter = upgradeCounters.get(requestIp);

    if (!currentCounter || isUpgradeWindowExpired(currentCounter, now)) {
      if (!currentCounter && upgradeCounters.size >= maxTrackedUpgradeIps) {
        pruneUpgradeCounters(upgradeCounters, now, maxTrackedUpgradeIps - 1);
      }

      if (!currentCounter && upgradeCounters.size >= maxTrackedUpgradeIps) {
        const oldestTrackedIp = upgradeCounters.keys().next();

        if (!oldestTrackedIp.done) {
          upgradeCounters.delete(oldestTrackedIp.value);
        }
      }

      upgradeCounters.set(requestIp, {
        count: 1,
        windowStartedAtMs: now,
        lastSeenAtMs: now
      });
    } else {
      currentCounter.count += 1;
      currentCounter.lastSeenAtMs = now;
      touchUpgradeEntry(upgradeCounters, requestIp, currentCounter);
    }

    const postUpdateCounter = upgradeCounters.get(requestIp);

    if (postUpdateCounter && postUpdateCounter.count > maxUpgradesPerMinutePerIp) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((UPGRADE_RATE_WINDOW_MS - (now - postUpdateCounter.windowStartedAtMs)) / 1000)
      );
      rejectUpgrade(socket, 429, `WebSocket upgrade rate limit exceeded for IP ${requestIp}`, {
        code: "WS_UPGRADE_RATE_LIMITED",
        headers: {
          "Retry-After": String(retryAfterSeconds)
        }
      });
      return;
    }

    const token = parsedUrl.searchParams.get("token")?.trim();

    if (!token) {
      rejectUpgrade(socket, 401, "WebSocket token query parameter is required");
      return;
    }

    const tokenHash = hashToken(token);
    const agentRow = findAgentByTokenHashQuery.get(tokenHash) as AgentIdRow | undefined;

    if (!agentRow) {
      rejectUpgrade(socket, 401, "Invalid WebSocket token");
      return;
    }

    if (getTotalOpenSlotsForAgent(agentRow.agent_id) >= maxConnectionsPerAgent) {
      rejectUpgrade(
        socket,
        403,
        `Concurrent WebSocket connection cap reached for agent ${agentRow.agent_id} (max ${maxConnectionsPerAgent})`,
        {
          code: "WS_CONNECTION_CAP_EXCEEDED"
        }
      );
      return;
    }

    incrementPendingUpgrade(agentRow.agent_id);
    let upgradeCompleted = false;

    const releasePendingIfAborted = () => {
      if (!upgradeCompleted) {
        decrementPendingUpgrade(agentRow.agent_id);
      }
    };

    socket.once("close", releasePendingIfAborted);

    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        upgradeCompleted = true;
        socket.off("close", releasePendingIfAborted);
        decrementPendingUpgrade(agentRow.agent_id);
        const authedSocket = ws as AuthedWebSocket;
        authedSocket.agentId = agentRow.agent_id;
        authedSocket.awaitingPong = false;
        authedSocket.lastPingSentAtMs = 0;
        wss.emit("connection", authedSocket, request);
      });
    } catch {
      socket.off("close", releasePendingIfAborted);
      releasePendingIfAborted();
      socket.destroy();
    }
  });

  wss.on("connection", (ws, request) => {
    const authedSocket = ws as AuthedWebSocket;
    const agentId = authedSocket.agentId;
    const parsedUrl = new URL(request?.url ?? "", "http://localhost");
    const rawSince = parsedUrl.searchParams.get("since");
    const since = rawSince ? Number.parseInt(rawSince, 10) : undefined;

    if (agentId) {
      trackActiveSocket(agentId, authedSocket);
    }

    ws.on("pong", () => {
      authedSocket.awaitingPong = false;
    });

    ws.on("close", () => {
      if (agentId) {
        untrackActiveSocket(agentId, authedSocket);
      }
    });

    const lastEvent = eventRepository.listLatestEvents(1)[0];

    ws.send(
      JSON.stringify({
        type: "connected",
        agent_id: authedSocket.agentId ?? null,
        last_seq: lastEvent?.seq ?? null,
        emitted_at: new Date().toISOString()
      })
    );

    if (since !== undefined && Number.isFinite(since) && since >= 0 && maxMissedEventsReplay > 0) {
      const replay = eventRepository.listEventsSince(since, maxMissedEventsReplay);
      for (const event of replay) {
        ws.send(
          JSON.stringify({
            seq: event.seq,
            type: event.event_type,
            payload: event.payload,
            emitted_at: event.created_at
          })
        );
      }
    }

    ws.on("message", () => {
      // No-op: server is push-only for now.
    });
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();

    wss.clients.forEach((client) => {
      const authedSocket = client as AuthedWebSocket;

      if (authedSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (authedSocket.awaitingPong) {
        if (now - (authedSocket.lastPingSentAtMs ?? 0) >= heartbeatTimeoutMs) {
          authedSocket.terminate();
        }

        return;
      }

      authedSocket.awaitingPong = true;
      authedSocket.lastPingSentAtMs = now;

      try {
        authedSocket.ping();
      } catch {
        authedSocket.terminate();
      }
    });
  }, heartbeatIntervalMs);

  heartbeatTimer.unref?.();

  wss.on("close", () => {
    clearInterval(heartbeatTimer);
    upgradeCounters.clear();
    pendingUpgradesByAgent.clear();
    activeSocketsByAgent.clear();
  });

  server.on("close", () => {
    clearInterval(heartbeatTimer);
    wss.close();
    upgradeCounters.clear();
    pendingUpgradesByAgent.clear();
    activeSocketsByAgent.clear();
  });

  return {
    publishEvent(eventType: string, payload: unknown) {
      const emittedAt = new Date().toISOString();
      let seq = -1;
      let storedPayload: unknown = payload;

      try {
        const stored = eventRepository.insertEvent({
          id: randomUUID(),
          event_type: eventType,
          payload,
          source: "api",
          created_at: emittedAt
        });
        seq = stored.seq;
        storedPayload = stored.payload;
      } catch {
        // If persistence fails, still broadcast a best-effort event.
      }

      broadcastEvent(wss, {
        seq,
        type: eventType,
        payload: storedPayload,
        emitted_at: emittedAt
      });
    }
  } satisfies WebsocketEventHooks;
}
