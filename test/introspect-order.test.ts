import assert from "node:assert/strict";
import test from "node:test";
import { compareCodeUnits } from "../src/introspect/order.js";

test("Introspect ordering is locale-independent for Unicode identifiers", () => {
  assert.deepEqual(["ä", "z", "a"].sort(compareCodeUnits), ["a", "z", "ä"]);
});
