export const TASK_STATES = ["open", "bidding", "assigned", "submitted", "scored", "settled"] as const;

export type TaskState = (typeof TASK_STATES)[number];

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  open: ["bidding"],
  bidding: ["assigned"],
  assigned: ["submitted"],
  submitted: ["scored"],
  scored: ["settled"],
  settled: []
};

export type TaskTransitionValidation =
  | { ok: true; from: TaskState; to: TaskState }
  | {
      ok: false;
      code: "TASK_STATE_UNKNOWN" | "TASK_STATE_TRANSITION_INVALID" | "TASK_RULE_VIOLATION";
      from: string;
      to: string;
      message: string;
      allowed_next_states: readonly TaskState[];
    };

export interface TaskTransitionContext {
  actor_agent_id?: string;
  assigned_agent_id?: string;
  scorer_agent_id?: string;
  idempotency_key?: string;
  bid_count?: number;
}

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

export function getAllowedTaskTransitions(from: TaskState): readonly TaskState[] {
  return TASK_TRANSITIONS[from];
}

export function validateTaskTransition(from: string, to: string): TaskTransitionValidation {
  if (!isTaskState(from)) {
    return {
      ok: false,
      code: "TASK_STATE_UNKNOWN",
      from,
      to,
      message: `Unknown task state "${from}"`,
      allowed_next_states: []
    };
  }

  if (!isTaskState(to)) {
    return {
      ok: false,
      code: "TASK_STATE_UNKNOWN",
      from,
      to,
      message: `Unknown task state "${to}"`,
      allowed_next_states: []
    };
  }

  const allowedNextStates = getAllowedTaskTransitions(from);

  if (!allowedNextStates.includes(to)) {
    return {
      ok: false,
      code: "TASK_STATE_TRANSITION_INVALID",
      from,
      to,
      message: `Task state transition ${from} -> ${to} is not allowed`,
      allowed_next_states: allowedNextStates
    };
  }

  return { ok: true, from, to };
}

/**
 * Validate transition with business rule context
 * - submitted: only assigned agent can submit
 * - scored: scorer must be set (isolation checked separately in scoring.ts)
 * - settled: idempotency key required
 */
export function validateTaskTransitionWithContext(
  from: string,
  to: string,
  ctx: TaskTransitionContext
): TaskTransitionValidation {
  const base = validateTaskTransition(from, to);
  if (!base.ok) return base;

  // assigned -> submitted: only the assigned agent can submit
  if (from === "assigned" && to === "submitted") {
    if (ctx.actor_agent_id && ctx.assigned_agent_id && ctx.actor_agent_id !== ctx.assigned_agent_id) {
      return {
        ok: false,
        code: "TASK_RULE_VIOLATION",
        from,
        to,
        message: "Only the assigned agent can submit work for this task",
        allowed_next_states: getAllowedTaskTransitions(from as TaskState)
      };
    }
  }

  // submitted -> scored: scorer must be provided
  if (from === "submitted" && to === "scored") {
    if (!ctx.scorer_agent_id) {
      return {
        ok: false,
        code: "TASK_RULE_VIOLATION",
        from,
        to,
        message: "A scorer agent ID is required to score a task",
        allowed_next_states: getAllowedTaskTransitions(from as TaskState)
      };
    }
  }

  // scored -> settled: idempotency key required
  if (from === "scored" && to === "settled") {
    if (!ctx.idempotency_key) {
      return {
        ok: false,
        code: "TASK_RULE_VIOLATION",
        from,
        to,
        message: "An idempotency key is required for settlement",
        allowed_next_states: getAllowedTaskTransitions(from as TaskState)
      };
    }
  }

  return { ok: true, from: from as TaskState, to: to as TaskState };
}

