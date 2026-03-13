const { WebSocket } = require("ws");

const BASE_URL = process.env.LINGSHI_BASE_URL ?? "http://127.0.0.1:3000";
const token = process.env.LINGSHI_AGENT_TOKEN;

if (!token) {
  console.error("Please set LINGSHI_AGENT_TOKEN to an agent bearer token.");
  process.exit(1);
}

const protocol = BASE_URL.startsWith("https") ? "wss" : "ws";
const host = BASE_URL.replace(/^https?:\/\//, "");
const wsUrl = `${protocol}://${host}/ws?token=${encodeURIComponent(token)}`;

const socket = new WebSocket(wsUrl);

socket.on("open", () => {
  console.log("WebSocket connected to", wsUrl);
});

socket.on("message", (data) => {
  try {
    const payload = JSON.parse(data.toString());
    if (payload.type === "connected") {
      console.log("Connected ack", payload);
      return;
    }
    console.log(`[event] ${payload.type}`, payload);
  } catch (error) {
    console.log("raw message", data.toString());
  }
});

socket.on("close", () => {
  console.log("WebSocket closed");
});

socket.on("error", (error) => {
  console.error("WebSocket error", error);
});
