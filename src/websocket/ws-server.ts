import type { Server } from "node:http";
import { URL } from "node:url";

import type Database from "better-sqlite3";
import { WebSocket, WebSocketServer } from "ws";

import { hashToken } from "../auth/token";

interface WebsocketEvent {
  type: string;
  payload: unknown;
  emitted_at: string;
}

type AuthedWebSocket = WebSocket & {
  agentId?: string;
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

function rejectUpgrade(socket: import("node:stream").Duplex, statusCode: 400 | 401 | 403, message: string) {
  const body = JSON.stringify({
    error: {
      code: "WS_AUTH_INVALID",
      message
    }
  });

  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Forbidden"}`,
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body
    ].join("\r\n")
  );
  socket.destroy();
}

export function attachWebsocketServer(server: Server, db: Database.Database) {
  const wss = new WebSocketServer({ noServer: true });
  const findAgentByTokenHashQuery = db.prepare(`
    SELECT agent_id
    FROM agents
    WHERE token_hash = ?
  `);

  server.on("upgrade", (request, socket, head) => {
    const parsedUrl = new URL(request.url ?? "", "http://localhost");

    if (parsedUrl.pathname !== "/ws") {
      socket.destroy();
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

    wss.handleUpgrade(request, socket, head, (ws) => {
      const authedSocket = ws as AuthedWebSocket;
      authedSocket.agentId = agentRow.agent_id;
      wss.emit("connection", authedSocket, request);
    });
  });

  wss.on("connection", (ws) => {
    const authedSocket = ws as AuthedWebSocket;

    ws.send(
      JSON.stringify({
        type: "welcome",
        message: "lingshi websocket placeholder online",
        agent_id: authedSocket.agentId ?? null
      })
    );

    ws.on("message", (rawMessage) => {
      ws.send(
        JSON.stringify({
          type: "echo",
          payload: rawMessage.toString()
        })
      );
    });
  });

  return {
    publishEvent(eventType: string, payload: unknown) {
      broadcastEvent(wss, {
        type: eventType,
        payload,
        emitted_at: new Date().toISOString()
      });
    }
  } satisfies WebsocketEventHooks;
}
