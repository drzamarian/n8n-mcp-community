export type OperationMode = "read-only" | "write" | "unsafe";

export interface StartupConfig {
  readonly mode: OperationMode;
  readonly allowInsecureHttp: boolean;
}

export interface N8nConnectionConfig {
  readonly apiUrl: URL;
  readonly apiKey: string;
}

/**
 * Stable, secret-free reason codes for each distinct configuration rule failure.
 * Each value names the exact rule that failed so `doctor` and startup output can
 * point the operator at a single setting without echoing any configured value.
 */
export type ConfigurationReason =
  | "mode_invalid"
  | "insecure_http_flag_invalid"
  | "api_url_missing"
  | "api_key_missing"
  | "api_key_invalid"
  | "api_url_invalid"
  | "api_url_scheme_unsupported"
  | "api_url_embedded_credentials"
  | "api_url_query_or_fragment"
  | "api_url_insecure_http";

export class ConfigurationError extends Error {
  readonly code = "configuration_error";
  readonly reason: ConfigurationReason;
  /** Name of the offending environment variable. Never its value. */
  readonly setting: string;

  constructor(reason: ConfigurationReason, setting: string, message: string) {
    super(message);
    this.name = "ConfigurationError";
    this.reason = reason;
    this.setting = setting;
  }
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new ConfigurationError("insecure_http_flag_invalid", name, `${name} must be 0 or 1.`);
}

function parseMode(value: string | undefined): OperationMode {
  const mode = value ?? "read-only";
  if (mode === "read-only" || mode === "write" || mode === "unsafe") return mode;
  throw new ConfigurationError(
    "mode_invalid",
    "N8N_MCP_MODE",
    "N8N_MCP_MODE must be read-only, write, or unsafe.",
  );
}

export function readStartupConfig(env: NodeJS.ProcessEnv = process.env): StartupConfig {
  return {
    mode: parseMode(env.N8N_MCP_MODE),
    allowInsecureHttp: parseBoolean(env.N8N_ALLOW_INSECURE_HTTP, "N8N_ALLOW_INSECURE_HTTP"),
  };
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

function isLegalHeaderValue(value: string): boolean {
  // Reject any value the fetch/undici layer would refuse as an HTTP header value
  // (control characters, CR, LF, or non-Latin-1 code points) so an invalid API key
  // fails at config load with a constant message instead of surfacing a TypeError
  // whose text can embed the raw key on every tool call.
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

export function readN8nConnection(
  startup: StartupConfig,
  env: NodeJS.ProcessEnv = process.env,
): N8nConnectionConfig {
  const rawUrl = env.N8N_API_URL?.trim();
  const apiKey = env.N8N_API_KEY?.trim();
  if (!rawUrl) {
    throw new ConfigurationError(
      "api_url_missing",
      "N8N_API_URL",
      "N8N_API_URL is required for tools that connect to n8n.",
    );
  }
  if (!apiKey) {
    throw new ConfigurationError(
      "api_key_missing",
      "N8N_API_KEY",
      "N8N_API_KEY is required for tools that connect to n8n.",
    );
  }
  if (!isLegalHeaderValue(apiKey)) {
    throw new ConfigurationError(
      "api_key_invalid",
      "N8N_API_KEY",
      "N8N_API_KEY must be a valid HTTP header value.",
    );
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(rawUrl);
  } catch {
    throw new ConfigurationError(
      "api_url_invalid",
      "N8N_API_URL",
      "N8N_API_URL must be a valid absolute URL.",
    );
  }
  if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
    throw new ConfigurationError(
      "api_url_scheme_unsupported",
      "N8N_API_URL",
      "N8N_API_URL must use HTTP or HTTPS.",
    );
  }
  if (apiUrl.username || apiUrl.password) {
    throw new ConfigurationError(
      "api_url_embedded_credentials",
      "N8N_API_URL",
      "N8N_API_URL must not contain embedded credentials.",
    );
  }
  if (apiUrl.search || apiUrl.hash) {
    throw new ConfigurationError(
      "api_url_query_or_fragment",
      "N8N_API_URL",
      "N8N_API_URL must not contain a query string or fragment.",
    );
  }
  if (apiUrl.protocol === "http:" && !isLoopback(apiUrl.hostname) && !startup.allowInsecureHttp) {
    throw new ConfigurationError(
      "api_url_insecure_http",
      "N8N_API_URL",
      "Plaintext HTTP is allowed only for loopback URLs unless N8N_ALLOW_INSECURE_HTTP=1.",
    );
  }
  apiUrl.pathname = apiUrl.pathname.replace(/\/+$/, "");
  return { apiUrl, apiKey };
}
