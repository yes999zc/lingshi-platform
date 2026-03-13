import type Database from "better-sqlite3";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { createEventRepository } from "../db/event-repository";
import { getRuleEngine } from "../engine/rule-engine";

interface EventsRouteOptions {
  db: Database.Database;
}

interface ValidationIssue {
  field: string;
  message: string;
}

function sendValidationError(reply: FastifyReply, issues: ValidationIssue[]) {
  return reply.code(400).send({
    error: {
      code: "VALIDATION_ERROR",
      message: "Invalid request payload",
      details: issues
    }
  });
}

const eventsRoutes: FastifyPluginAsync<EventsRouteOptions> = async (app, options) => {
  const { db } = options;
  const rules = getRuleEngine().getConfig();
  const eventRepo = createEventRepository(db);

  app.get<{ Querystring: { since?: string; limit?: string } }>("/events", async (request, reply) => {
    const issues: ValidationIssue[] = [];
    const rawSince = request.query.since;
    const rawLimit = request.query.limit;

    let since: number | undefined = undefined;
    if (rawSince) {
      const parsed = Number.parseInt(rawSince, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        since = parsed;
      } else {
        issues.push({ field: "since", message: "since must be a non-negative integer" });
      }
    }

    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : rules.events.max_events_per_query;
    if (!Number.isFinite(limit) || limit <= 0) {
      issues.push({ field: "limit", message: "limit must be a positive integer" });
    }

    if (issues.length > 0) {
      return sendValidationError(reply, issues);
    }

    const cappedLimit = Math.min(limit, rules.events.max_events_per_query);
    const events = since !== undefined
      ? eventRepo.listEventsSince(since, cappedLimit)
      : eventRepo.listLatestEvents(cappedLimit);

    return {
      data: {
        events
      }
    };
  });
};

export default eventsRoutes;
