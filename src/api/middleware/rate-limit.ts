import type { preHandlerHookHandler } from "fastify";

import { sendError } from "../error-envelope";

const WINDOW_MS = 60 * 1000;
const DEFAULT_REQUESTS_PER_MINUTE = 60;
const DEFAULT_MAX_TRACKED_KEYS = 10_000;
const PRUNE_EVERY_REQUESTS = 256;

interface RateLimitEntry {
  count: number;
  windowStartedAtMs: number;
  lastSeenAtMs: number;
}

export interface AgentRateLimitOptions {
  maxRequestsPerMinute?: number;
  maxTrackedKeys?: number;
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

export function resolveRateLimitPerMinuteFromEnv() {
  return parsePositiveInteger(process.env.AGENT_REQUEST_RATE_LIMIT_PER_MINUTE, DEFAULT_REQUESTS_PER_MINUTE);
}

export function resolveRateLimitMaxTrackedKeysFromEnv() {
  return parsePositiveInteger(process.env.AGENT_REQUEST_RATE_LIMIT_MAX_TRACKED_KEYS, DEFAULT_MAX_TRACKED_KEYS);
}

function isWindowExpired(entry: RateLimitEntry, now: number) {
  return now - entry.windowStartedAtMs >= WINDOW_MS;
}

function touchEntry(counters: Map<string, RateLimitEntry>, key: string, entry: RateLimitEntry) {
  counters.delete(key);
  counters.set(key, entry);
}

function pruneCounters(counters: Map<string, RateLimitEntry>, now: number, maxTrackedKeys: number) {
  for (const [key, entry] of counters) {
    if (isWindowExpired(entry, now)) {
      counters.delete(key);
    }
  }

  if (counters.size <= maxTrackedKeys) {
    return;
  }

  const overflow = counters.size - maxTrackedKeys;
  const oldestKeys = counters.keys();

  for (let index = 0; index < overflow; index += 1) {
    const oldest = oldestKeys.next();

    if (oldest.done) {
      break;
    }

    counters.delete(oldest.value);
  }
}

export function createAgentRateLimitMiddleware(options: AgentRateLimitOptions = {}): preHandlerHookHandler {
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
  const maxTrackedKeys =
    typeof options.maxTrackedKeys === "number" && Number.isFinite(options.maxTrackedKeys) && options.maxTrackedKeys > 0
      ? Math.floor(options.maxTrackedKeys)
      : DEFAULT_MAX_TRACKED_KEYS;
  const counters = new Map<string, RateLimitEntry>();
  let requestCountSincePrune = 0;

  return async (request, reply) => {
    const now = Date.now();
    requestCountSincePrune += 1;

    if (requestCountSincePrune >= PRUNE_EVERY_REQUESTS || counters.size > maxTrackedKeys) {
      pruneCounters(counters, now, maxTrackedKeys);
      requestCountSincePrune = 0;
    }

    const agentId = request.agentAuth?.agentId ?? "anonymous";
    const key = `${request.ip}:${agentId}`;
    const current = counters.get(key);

    if (!current) {
      if (counters.size >= maxTrackedKeys) {
        pruneCounters(counters, now, maxTrackedKeys - 1);
      }

      if (counters.size >= maxTrackedKeys) {
        const oldest = counters.keys().next();

        if (!oldest.done) {
          counters.delete(oldest.value);
        }
      }

      counters.set(key, {
        count: 1,
        windowStartedAtMs: now,
        lastSeenAtMs: now
      });
      return;
    }

    if (isWindowExpired(current, now)) {
      current.count = 1;
      current.windowStartedAtMs = now;
      current.lastSeenAtMs = now;
      touchEntry(counters, key, current);
      return;
    }

    current.count += 1;
    current.lastSeenAtMs = now;
    touchEntry(counters, key, current);

    if (current.count <= maxRequestsPerMinute) {
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - (now - current.windowStartedAtMs)) / 1000));
    reply.header("Retry-After", String(retryAfterSeconds));

    return sendError(
      reply,
      429,
      "RATE_LIMIT_EXCEEDED",
      `Rate limit exceeded: max ${maxRequestsPerMinute} requests per minute per IP/agent`,
      {
        key,
        limit_per_minute: maxRequestsPerMinute,
        retry_after_seconds: retryAfterSeconds
      }
    );
  };
}
