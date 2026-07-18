import { inspectWorkflow } from "../src/introspect/engine.js";
import type { N8nReadClient } from "../src/introspect/contracts.js";
import { compareCodeUnits } from "../src/introspect/order.js";

const client: N8nReadClient = {
  async get(endpoint) {
    if (endpoint.startsWith("/workflows/")) {
      return {
        value: {
          id: "workflow-1",
          name: "Deterministic fixture",
          active: false,
          triggerCount: 1,
          nodes: [
            {
              name: "Manual Trigger",
              type: "n8n-nodes-base.manualTrigger",
              typeVersion: 1,
              parameters: {},
            },
          ],
          connections: {},
          settings: {},
        },
        bytes: 100,
      };
    }
    return {
      value: {
        data: [
          {
            id: "execution-1",
            status: "success",
            mode: "trigger",
            startedAt: "2026-07-17T09:00:00-03:00",
            stoppedAt: "2026-07-17T09:00:01-03:00",
            workflowId: "workflow-1",
          },
        ],
        nextCursor: null,
      },
      bytes: 100,
    };
  },
};

const result = await inspectWorkflow(client, { workflowId: "workflow-1" });
const orderedUnicode = ["ä-node", "z-node", "a-node"].sort(compareCodeUnits);
process.stdout.write(`${JSON.stringify({ orderedUnicode, result })}\n`);
