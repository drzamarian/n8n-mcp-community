export type OperationMode = "read-only" | "write" | "unsafe";

export interface StartupConfig {
  readonly mode: OperationMode;
  readonly allowInsecureHttp: boolean;
}

export interface N8nConnectionConfig {
  readonly apiUrl: URL;
  readonly apiKey: string;
}

export class ConfigurationError extends Error {
  readonly code = "configuration_error";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new ConfigurationError(`${name} must be 0 or 1.`);
}

function parseMode(value: string | undefined): OperationMode {
  const mode = value ?? "read-only";
  if (mode === "read-only" || mode === "write" || mode === "unsafe") return mode;
  throw new ConfigurationError("N8N_MCP_MODE must be read-only, write, or unsafe.");
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

export function readN8nConnection(
  startup: StartupConfig,
  env: NodeJS.ProcessEnv = process.env,
): N8nConnectionConfig {
  const rawUrl = env.N8N_API_URL?.trim();
  const apiKey = env.N8N_API_KEY?.trim();
  if (!rawUrl || !apiKey) {
    throw new ConfigurationError(
      "N8N_API_URL and N8N_API_KEY are required for tools that connect to n8n.",
    );
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(rawUrl);
  } catch {
    throw new ConfigurationError("N8N_API_URL must be a valid absolute URL.");
  }
  if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
    throw new ConfigurationError("N8N_API_URL must use HTTP or HTTPS.");
  }
  if (apiUrl.username || apiUrl.password) {
    throw new ConfigurationError("N8N_API_URL must not contain embedded credentials.");
  }
  if (apiUrl.search || apiUrl.hash) {
    throw new ConfigurationError("N8N_API_URL must not contain a query string or fragment.");
  }
  if (apiUrl.protocol === "http:" && !isLoopback(apiUrl.hostname) && !startup.allowInsecureHttp) {
    throw new ConfigurationError(
      "Plaintext HTTP is allowed only for loopback URLs unless N8N_ALLOW_INSECURE_HTTP=1.",
    );
  }
  apiUrl.pathname = apiUrl.pathname.replace(/\/+$/, "");
  return { apiUrl, apiKey };
}
