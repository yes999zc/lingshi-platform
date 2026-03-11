import type { Server } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

interface WebsocketEvent {
  type: string;
  payload: unknown;
  emitted_at: string;
}

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

export function attachWebsocketServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        type: "welcome",
        message: "lingshi websocket placeholder online"
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
