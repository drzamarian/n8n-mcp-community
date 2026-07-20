import type { N8nConnectionConfig, StartupConfig } from "./config.js";
import { N8nApiError, type N8nClient } from "./n8n/client.js";

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

/** Documented support floor. Named in reports; never asserted as the remote version. */
export const DOCUMENTED_N8N_FLOOR = "n8n Community 2.30.5";

/** Per-endpoint availability observed by the floor probe. Availability only, never data. */
export type EndpointAvailability = "available" | "not_found" | "error";

/**
 * Overall floor diagnosis. Exactly three truthful values:
 * - `floor_compatible`: the instance is reachable and every floor-marker endpoint responded.
 * - `below_floor_indicators`: the instance is reachable but a floor-marker endpoint is absent
 *   (404) — characteristic of an n8n release below the documented floor.
 * - `inconclusive`: the instance could not be reached usefully, or the markers failed for a
 *   reason (e.g. 403 key scope, 5xx) that does not distinguish version.
 */
export type FloorDiagnosis = "floor_compatible" | "below_floor_indicators" | "inconclusive";

export interface FloorProbeEndpointResult {
  /** Stable method+path label, e.g. `GET /credentials`. Carries no instance data. */
  readonly endpoint: string;
  readonly availability: EndpointAvailability;
}

export interface FloorCompatibilityReport {
  readonly diagnosis: FloorDiagnosis;
  /** The documented support floor being tested against. Not a detected remote version. */
  readonly documentedFloor: string;
  /**
   * Always false: the n8n Public API exposes no version, so no version is ever detected or
   * fabricated. The diagnosis is inferred purely from endpoint availability.
   */
  readonly remoteVersionDetected: false;
  readonly endpoints: readonly FloorProbeEndpointResult[];
}

/**
 * Bounded, value-free Public API reads whose joint availability distinguishes a
 * supported-floor instance from a below-floor one. `GET /workflows` exists on every
 * Public-API-enabled n8n release and acts as a reachability control; `GET /credentials`
 * is available only from the documented 2.30.5 floor onward (docs/compatibility.md), so
 * its absence on a reachable instance is a below-floor indicator. Each read fetches a
 * single page of size 1 and inspects only availability — never any workflow, credential,
 * or other value.
 */
const FLOOR_PROBE_ENDPOINTS = [
  { endpoint: "GET /workflows", path: "/workflows", role: "control" },
  { endpoint: "GET /credentials", path: "/credentials", role: "floor_marker" },
] as const;

async function probeEndpointAvailability(
  client: N8nClient,
  path: string,
): Promise<EndpointAvailability> {
  try {
    await client.request({ path, query: { limit: "1" } });
    return "available";
  } catch (error) {
    if (error instanceof N8nApiError && error.status === 404) return "not_found";
    return "error";
  }
}

function deriveFloorDiagnosis(
  control: EndpointAvailability,
  markerNotFound: boolean,
  markerError: boolean,
): FloorDiagnosis {
  // No usable reachability control means nothing can be concluded about the floor.
  if (control !== "available") return "inconclusive";
  // A reachable instance missing a floor-marker namespace (404) is a below-floor signal.
  if (markerNotFound) return "below_floor_indicators";
  // A marker that failed for a non-404 reason (403 key scope, 5xx) is not a version signal.
  if (markerError) return "inconclusive";
  return "floor_compatible";
}

/**
 * Bounded, read-only floor-compatibility probe against the operator-configured instance.
 * Contacts a fixed set of cheap Public API reads (one page of size 1 each, existing client
 * timeouts) and reports only per-endpoint availability plus an overall diagnosis. It never
 * reads response data, never queries or claims a remote version, and never contacts anything
 * other than the configured instance.
 */
export async function probeFloorCompatibility(
  client: N8nClient,
): Promise<FloorCompatibilityReport> {
  const endpoints: FloorProbeEndpointResult[] = [];
  let control: EndpointAvailability = "error";
  let markerNotFound = false;
  let markerError = false;
  for (const target of FLOOR_PROBE_ENDPOINTS) {
    const availability = await probeEndpointAvailability(client, target.path);
    endpoints.push({ endpoint: target.endpoint, availability });
    if (target.role === "control") {
      control = availability;
    } else if (availability === "not_found") {
      markerNotFound = true;
    } else if (availability !== "available") {
      markerError = true;
    }
  }
  return {
    diagnosis: deriveFloorDiagnosis(control, markerNotFound, markerError),
    documentedFloor: DOCUMENTED_N8N_FLOOR,
    remoteVersionDetected: false,
    endpoints,
  };
}
