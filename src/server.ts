import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";

import agentsRoutes from "./api/agents";
import eventsRoutes from "./api/events";
import ledgerRoutes from "./api/ledger";
import tasksRoutes from "./api/tasks";
import { bootstrapDatabase } from "./db/db";
import { initializeRules } from "./engine/rule-engine";
import { attachWebsocketServer } from "./websocket/ws-server";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);
const DASHBOARD_PUBLIC_HOST = process.env.DASHBOARD_PUBLIC_HOST;
const DASHBOARD_SOURCE_FILE = path.resolve(process.cwd(), "src", "dashboard", "index.html");
const DASHBOARD_DIST_DIR = path.resolve(process.cwd(), "src", "dashboard", "dist");
const DASHBOARD_DIST_INDEX = path.resolve(DASHBOARD_DIST_DIR, "index.html");

function resolveLanHost(): string | null {
  if (DASHBOARD_PUBLIC_HOST) {
    return DASHBOARD_PUBLIC_HOST;
  }

  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (
        ip.startsWith("192.168.") ||
        ip.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
      ) {
        candidates.push(ip);
      }
    }
  }

  return candidates[0] ?? null;
}

export interface CreateServerOptions {
  dbPath?: string;
  schemaPath?: string;
}

export async function createServer(options: CreateServerOptions = {}) {
  const ruleLoad = initializeRules();
  if (!ruleLoad.valid) {
    throw new Error(`Rule configuration invalid: ${ruleLoad.errors.join("; ")}`);
  }

  const app = Fastify({ logger: true });
  const db = bootstrapDatabase({
    dbPath: options.dbPath,
    schemaPath: options.schemaPath
  });
  const websocketHooks = attachWebsocketServer(app.server, db);

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
    const filePath = fs.existsSync(DASHBOARD_DIST_INDEX) ? DASHBOARD_DIST_INDEX : DASHBOARD_SOURCE_FILE;
    const html = await readFile(filePath, "utf8");
    reply.type("text/html").send(html);
  });

  if (fs.existsSync(DASHBOARD_DIST_DIR)) {
    try {
      const staticModule = await import("@fastify/static");
      const fastifyStatic = (staticModule as any).default ?? staticModule;

      await app.register(fastifyStatic, {
        root: DASHBOARD_DIST_DIR,
        prefix: "/dashboard/",
        decorateReply: false
      });
    } catch {
      // Optional dependency; skip static hosting when unavailable.
    }
  }

  await app.register(agentsRoutes, { prefix: "/api", db });
  await app.register(eventsRoutes, { prefix: "/api", db });
  await app.register(tasksRoutes, { prefix: "/api", db, publishEvent: websocketHooks.publishEvent });
  await app.register(ledgerRoutes, { prefix: "/api", db });

  return app;
}

export async function startServer() {
  const app = await createServer();

  try {
    await app.listen({ host: HOST, port: PORT });

    const lanHost = resolveLanHost();
    if (lanHost) {
      app.log.info(`Dashboard URL (LAN): http://${lanHost}:${PORT}/dashboard`);
    } else {
      app.log.warn("Dashboard URL (LAN): unavailable, set DASHBOARD_PUBLIC_HOST to force one");
    }

    app.log.info(`Dashboard URL (Local): http://127.0.0.1:${PORT}/dashboard`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  void startServer();
}
