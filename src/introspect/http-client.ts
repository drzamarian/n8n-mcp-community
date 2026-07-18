import { type N8nReadClient, type ReadBudget } from "./contracts.js";
import { IntrospectCollectionError } from "./collector.js";

export interface N8nReadClientOptions {
  baseUrl: string;
  apiKey: string;
  beforeRequest?: () => void;
  fetchImplementation?: typeof fetch;
}

function isSafeEncodedPath(path: string): boolean {
  if (!/^\/[A-Za-z0-9_./%~-]*$/.test(path) || /%(?![A-Fa-f0-9]{2})/.test(path)) {
    return false;
  }
  for (const rawSegment of path.split("/").slice(1)) {
    if (rawSegment === "") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return false;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("%") ||
      /[\u0000-\u001f\u007f-\u009f]/.test(decoded)
    ) {
      return false;
    }
  }
  return true;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  truncateOnOverflow: boolean,
): Promise<{ body: Uint8Array; bytes: number }> {
  if (!response.body) return { body: new Uint8Array(), bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        if (truncateOnOverflow && remaining > 0) chunks.push(value.subarray(0, remaining));
        bytes += truncateOnOverflow ? Math.max(remaining, 0) : value.byteLength;
        await reader.cancel();
        if (!truncateOnOverflow) {
          throw new IntrospectCollectionError(
            "response_too_large",
            "The public n8n API response exceeded the Introspect byte limit.",
          );
        }
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, bytes };
}

export function createN8nReadClient(options: N8nReadClientOptions): N8nReadClient {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl = new URL(options.baseUrl);
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  const apiRoot = `${basePath}/api/v1`.replace(/\/{2,}/g, "/");
  return {
    async get(endpoint: string, query: Readonly<Record<string, string>>, budget: ReadBudget) {
      if (!isSafeEncodedPath(endpoint)) {
        throw new IntrospectCollectionError("invalid_path", "The public n8n API path is invalid.");
      }
      options.beforeRequest?.();
      if (!Number.isInteger(budget.timeoutMs) || budget.timeoutMs < 1) {
        throw new IntrospectCollectionError(
          "deadline_exceeded",
          "The Introspect request timeout is invalid.",
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget.timeoutMs);
      try {
        const requestedPath = `${apiRoot}${endpoint}`.replace(/\/{2,}/g, "/");
        const url = new URL(baseUrl.href);
        url.pathname = requestedPath;
        url.search = "";
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        if (
          url.origin !== baseUrl.origin ||
          url.pathname !== requestedPath ||
          !url.pathname.startsWith(`${apiRoot}/`)
        ) {
          throw new IntrospectCollectionError(
            "invalid_path",
            "The public n8n API origin or path changed unexpectedly.",
          );
        }
        const response = await fetchImplementation(url, {
          method: "GET",
          headers: {
            "X-N8N-API-KEY": options.apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
          redirect: "error",
        });

        if (!response.ok) {
          await readBoundedBody(response, 8_192, true);
          throw new IntrospectCollectionError(
            "upstream_http_error",
            `The public n8n API returned HTTP ${response.status}; verify the workflow ID, API access, and n8n availability.`,
            response.status,
          );
        }

        const contentLength = response.headers.get("content-length");
        if (
          contentLength &&
          /^\d+$/.test(contentLength) &&
          Number(contentLength) > budget.maxBytes
        ) {
          await response.body?.cancel();
          throw new IntrospectCollectionError(
            "response_too_large",
            "The public n8n API declared a response larger than the Introspect byte limit.",
          );
        }

        const body = await readBoundedBody(response, budget.maxBytes, false);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(body.body);
        } catch {
          throw new IntrospectCollectionError(
            "invalid_json",
            "The public n8n API response was not valid UTF-8 JSON.",
          );
        }
        try {
          return { value: JSON.parse(text) as unknown, bytes: body.bytes };
        } catch {
          throw new IntrospectCollectionError(
            "invalid_json",
            "The public n8n API response was not valid JSON.",
          );
        }
      } catch (error) {
        if (error instanceof IntrospectCollectionError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new IntrospectCollectionError(
            "deadline_exceeded",
            "The public n8n API request exceeded the Introspect deadline.",
          );
        }
        throw new IntrospectCollectionError(
          "upstream_http_error",
          "The public n8n API request failed; verify connectivity and API access.",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
