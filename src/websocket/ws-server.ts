import type { Server } from "node:http";

import { WebSocketServer } from "ws";

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

  return wss;
}
