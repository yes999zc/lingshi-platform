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
      code: "TASK_STATE_UNKNOWN" | "TASK_STATE_TRANSITION_INVALID";
      from: string;
      to: string;
      message: string;
      allowed_next_states: readonly TaskState[];
    };

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
