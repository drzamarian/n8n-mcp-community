import assert from "node:assert/strict";
import test from "node:test";
import { authorizeOperation, PolicyError } from "../src/security/operation-policy.js";

test("read-only operations are allowed in every mode", () => {
  for (const mode of ["read-only", "write", "unsafe"] as const) {
    assert.doesNotThrow(() => authorizeOperation(mode, "read-only"));
  }
});

test("writes require write or unsafe mode", () => {
  assert.throws(() => authorizeOperation("read-only", "write"), PolicyError);
  assert.doesNotThrow(() => authorizeOperation("write", "write"));
  assert.doesNotThrow(() => authorizeOperation("unsafe", "write"));
});

test("unsafe operations require unsafe mode and an exact confirmation", () => {
  const exact = { supplied: "DELETE wf_1", expected: "DELETE wf_1" };
  assert.throws(() => authorizeOperation("read-only", "unsafe", exact), PolicyError);
  assert.throws(() => authorizeOperation("write", "unsafe", exact), PolicyError);
  assert.throws(
    () => authorizeOperation("unsafe", "unsafe"),
    (error: unknown) =>
      error instanceof PolicyError &&
      error.message === "The supplied confirmation did not match the required exact phrase.",
  );
  assert.throws(
    () =>
      authorizeOperation("unsafe", "unsafe", {
        supplied: "delete wf_1",
        expected: "DELETE wf_1",
      }),
    (error: unknown) =>
      error instanceof PolicyError &&
      error.message === "The supplied confirmation did not match the required exact phrase." &&
      !error.message.includes("DELETE wf_1"),
  );
  assert.doesNotThrow(() => authorizeOperation("unsafe", "unsafe", exact));
});
