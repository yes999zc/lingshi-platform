import { readFile } from "node:fs/promises";
import path from "node:path";

import Fastify from "fastify";

import agentsRoutes from "./api/agents";
import ledgerRoutes from "./api/ledger";
import tasksRoutes from "./api/tasks";
import { bootstrapDatabase } from "./db/db";
import { attachWebsocketServer } from "./websocket/ws-server";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);
const DASHBOARD_FILE = path.resolve(process.cwd(), "src", "dashboard", "index.html");

export async function createServer() {
  const app = Fastify({ logger: true });
  const db = bootstrapDatabase();

  attachWebsocketServer(app.server);

  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString()
    };
  });

  app.get("/dashboard", async (_request, reply) => {
    const html = await readFile(DASHBOARD_FILE, "utf8");
    reply.type("text/html").send(html);
  });

  await app.register(agentsRoutes, { prefix: "/api", db });
  await app.register(tasksRoutes, { prefix: "/api", db });
  await app.register(ledgerRoutes, { prefix: "/api" });

  return app;
}

export async function startServer() {
  const app = await createServer();

  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  void startServer();
}
