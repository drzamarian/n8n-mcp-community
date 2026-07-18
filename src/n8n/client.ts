import type { N8nConnectionConfig } from "../config.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

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

export class N8nApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "N8nApiError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly root?: boolean;
  readonly timeoutMs?: number;
  readonly responseMode?: "json" | "status";
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new N8nApiError("response_too_large", "The n8n response exceeds the 2 MiB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class N8nClient {
  readonly #config: N8nConnectionConfig;

  constructor(config: N8nConnectionConfig) {
    this.#config = config;
  }

  async request(options: RequestOptions): Promise<unknown> {
    if (!isSafeEncodedPath(options.path)) {
      throw new N8nApiError("invalid_path", "The requested n8n API path is invalid.");
    }
    const prefix = options.root ? "" : "/api/v1";
    const basePath = this.#config.apiUrl.pathname.replace(/\/$/, "");
    const requestRoot = `${basePath}${prefix}`.replace(/\/{2,}/g, "/");
    const requestedPath = `${requestRoot}${options.path}`.replace(/\/{2,}/g, "/");
    const url = new URL(this.#config.apiUrl.href);
    url.pathname = requestedPath;
    url.search = "";
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const requiredPathPrefix = requestRoot === "" ? "/" : `${requestRoot}/`;
    if (
      url.origin !== this.#config.apiUrl.origin ||
      url.pathname !== requestedPath ||
      !url.pathname.startsWith(requiredPathPrefix)
    ) {
      throw new N8nApiError(
        "origin_mismatch",
        "The n8n request origin or API path changed unexpectedly.",
      );
    }

    const headers = new Headers({ "X-N8N-API-KEY": this.#config.apiKey });
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        throw new N8nApiError("request_too_large", "The n8n request exceeds the 2 MiB limit.");
      }
      headers.set("Content-Type", "application/json");
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new N8nApiError(
        "request_failed",
        "The n8n request failed before a response was received.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new N8nApiError(
        "redirect_rejected",
        "The n8n response attempted a redirect.",
        response.status,
      );
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new N8nApiError("response_too_large", "The n8n response exceeds the 2 MiB limit.");
    }
    const bytes = await readBounded(response);
    if (!response.ok) {
      throw new N8nApiError(
        "upstream_error",
        `The n8n API returned HTTP ${response.status}.`,
        response.status,
      );
    }
    if (options.responseMode === "status") {
      return { ok: true, status: response.status };
    }
    if (bytes.byteLength === 0) return null;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new N8nApiError("invalid_json", "The n8n API returned invalid JSON.");
    }
  }
}
