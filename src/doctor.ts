import type { N8nConnectionConfig, StartupConfig } from "./config.js";

export interface DoctorReport {
  readonly status: "pass" | "fail";
  readonly networkAccess: false;
  readonly node: { readonly major: number | null; readonly supported: boolean };
  readonly configuration: {
    readonly mode: StartupConfig["mode"];
    readonly apiUrlConfigured: true;
    readonly apiKeyConfigured: boolean;
    readonly transport: "https" | "http";
    readonly insecureHttpExplicitlyAllowed: boolean;
  };
}

export function buildDoctorReport(
  startup: StartupConfig,
  connection: N8nConnectionConfig,
  nodeVersion = process.versions.node,
): DoctorReport {
  const parsedMajor = Number(nodeVersion.split(".")[0]);
  const major = Number.isInteger(parsedMajor) ? parsedMajor : null;
  const supported = major !== null && major >= 22;
  return {
    status: supported ? "pass" : "fail",
    networkAccess: false,
    node: { major, supported },
    configuration: {
      mode: startup.mode,
      apiUrlConfigured: true,
      apiKeyConfigured: connection.apiKey.length > 0,
      transport: connection.apiUrl.protocol === "https:" ? "https" : "http",
      insecureHttpExplicitlyAllowed: startup.allowInsecureHttp,
    },
  };
}
