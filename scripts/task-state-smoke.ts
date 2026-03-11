import assert from "node:assert/strict";

import { validateTaskTransition } from "../src/engine/task-state";

const allowedTransitions = [
  ["open", "bidding"],
  ["bidding", "assigned"],
  ["assigned", "submitted"],
  ["submitted", "scored"],
  ["scored", "settled"]
] as const;

for (const [from, to] of allowedTransitions) {
  const result = validateTaskTransition(from, to);
  assert.equal(result.ok, true, `expected ${from} -> ${to} to be allowed`);
}

const rejectedTransitions = [
  ["open", "assigned"],
  ["bidding", "scored"],
  ["submitted", "settled"],
  ["settled", "open"],
  ["cancelled", "open"]
] as const;

for (const [from, to] of rejectedTransitions) {
  const result = validateTaskTransition(from, to);
  assert.equal(result.ok, false, `expected ${from} -> ${to} to be rejected`);
}

console.log("task-state smoke checks passed");
