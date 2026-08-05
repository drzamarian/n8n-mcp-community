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

test("unsafe operations require unsafe mode and no second authorization input", () => {
  assert.throws(
    () => authorizeOperation("read-only", "unsafe"),
    (error: unknown) =>
      error instanceof PolicyError && error.message === "This tool requires N8N_MCP_MODE=unsafe.",
  );
  assert.throws(
    () => authorizeOperation("write", "unsafe"),
    (error: unknown) =>
      error instanceof PolicyError && error.message === "This tool requires N8N_MCP_MODE=unsafe.",
  );
  assert.doesNotThrow(() => authorizeOperation("unsafe", "unsafe"));
});
