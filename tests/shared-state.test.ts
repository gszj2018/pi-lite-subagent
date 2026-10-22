import assert from "node:assert/strict";
import { test } from "node:test";
import { getNavigationState } from "../extension/shared-state.ts";
import { clearSharedState } from "./helpers/cleanup.ts";
import type { NavigationState } from "../extension/types.ts";

test("getNavigationState() gets a properly initialized global singleton", async (t) => {
  clearSharedState();
  t.after(clearSharedState);

  const state = getNavigationState();
  const emptyState: NavigationState = { frames: [] }
  assert.deepEqual(state, emptyState)

  state.frames.push("/tmp/0.jsonl")
  state.pending = { operation: "push", from: "/tmp/1.jsonl", to: "/tmp/2.jsonl" }

  const newState = getNavigationState();
  assert.equal(newState, state);
  assert.deepEqual(newState.frames, ["/tmp/0.jsonl"])
  assert.deepEqual(newState.pending, { operation: "push", from: "/tmp/1.jsonl", to: "/tmp/2.jsonl" })
});
