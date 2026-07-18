import { OFFICIAL_N8N_DOCUMENTATION_URLS } from "./official-urls.js";

export interface NodeDocumentation {
  readonly type: string;
  readonly title: string;
  readonly summary: string;
  readonly guidance: readonly string[];
  readonly officialUrl: string;
}

export const NODE_DOCUMENTATION = Object.freeze({
  webhook: Object.freeze({
    type: "n8n-nodes-base.webhook",
    title: "Webhook node",
    summary: "Starts a workflow when its test or production webhook receives an HTTP request.",
    guidance: Object.freeze([
      "Use a unique path and the narrowest required HTTP method.",
      "Configure authentication when the caller is not already protected by a trusted gateway.",
      "Use Respond to Webhook when the response must depend on downstream workflow data.",
    ]),
    officialUrl: OFFICIAL_N8N_DOCUMENTATION_URLS.webhook,
  }),
  code: Object.freeze({
    type: "n8n-nodes-base.code",
    title: "Code node",
    summary: "Runs bounded custom JavaScript or Python logic inside an n8n workflow.",
    guidance: Object.freeze([
      "Prefer standard nodes when they express the same operation clearly.",
      "Treat input items as untrusted and return the item structure expected by downstream nodes.",
      "Do not embed credentials or secrets in source code.",
    ]),
    officialUrl: OFFICIAL_N8N_DOCUMENTATION_URLS.code,
  }),
  "http-request": Object.freeze({
    type: "n8n-nodes-base.httpRequest",
    title: "HTTP Request node",
    summary:
      "Calls an HTTP API from a workflow using configured credentials, headers, query parameters, and body data.",
    guidance: Object.freeze([
      "Use stored n8n credentials instead of literal authorization values.",
      "Set explicit timeouts and retry only operations that are safe to repeat.",
      "Validate and minimize response data before passing it downstream.",
    ]),
    officialUrl: OFFICIAL_N8N_DOCUMENTATION_URLS.httpRequest,
  }),
  if: Object.freeze({
    type: "n8n-nodes-base.if",
    title: "If node",
    summary: "Routes each input item to a true or false output based on configured conditions.",
    guidance: Object.freeze([
      "Choose explicit type-aware operators and handle missing values intentionally.",
      "Keep condition groups small enough to review and test.",
      "Name the node after the business decision it represents.",
    ]),
    officialUrl: OFFICIAL_N8N_DOCUMENTATION_URLS.if,
  }),
} satisfies Readonly<Record<string, NodeDocumentation>>);

export type DocumentedNode = keyof typeof NODE_DOCUMENTATION;
