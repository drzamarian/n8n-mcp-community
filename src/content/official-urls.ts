export const OFFICIAL_N8N_DOCUMENTATION_URLS = Object.freeze({
  webhook: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/",
  code: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.code/",
  httpRequest: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/",
  if: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.if/",
  splitInBatches:
    "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/",
});

const OFFICIAL_N8N_DOCUMENTATION_URL_SET = new Set<string>(
  Object.values(OFFICIAL_N8N_DOCUMENTATION_URLS),
);

export function isOfficialN8nDocumentationUrl(value: string): boolean {
  return OFFICIAL_N8N_DOCUMENTATION_URL_SET.has(value);
}
