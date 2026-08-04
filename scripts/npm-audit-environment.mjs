import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const auditGlobalConfig = fileURLToPath(new URL("npm-audit-global.npmrc", import.meta.url));
const auditUserConfig = fileURLToPath(new URL("npm-audit.npmrc", import.meta.url));
const publicRegistry = "https://registry.npmjs.org";

const ambientTransportKeys = new Set([
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "node_extra_ca_certs",
  "node_tls_reject_unauthorized",
  "no_proxy",
  "ssl_cert_dir",
  "ssl_cert_file",
]);

function isNpmConfig(key) {
  const normalized = key.toLowerCase();
  return normalized.startsWith("npm_config_");
}

export function npmAuditEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (isNpmConfig(key) || ambientTransportKeys.has(normalized)) {
      delete env[key];
    }
  }
  return {
    ...env,
    npm_config_globalconfig: auditGlobalConfig,
    npm_config_registry: publicRegistry,
    npm_config_strict_ssl: "true",
    npm_config_userconfig: auditUserConfig,
  };
}

export function assertNoProjectNpmConfig(directory, fileExists = existsSync) {
  if (fileExists(path.join(directory, ".npmrc"))) {
    throw new Error("npm audit refuses an ambient project .npmrc file.");
  }
}

export function verifyNpmAuditEnvironmentPolicySelfTest() {
  const observed = npmAuditEnvironment({
    PATH: "/synthetic/system/path",
    NPM_CONFIG_ALLOW_SCRIPTS: "true",
    NPM_CONFIG_GLOBALCONFIG: "/untrusted/global-npmrc",
    NPM_CONFIG_REGISTRY: "https://mirror.invalid",
    NPM_CONFIG_STRICT_SSL: "false",
    HTTPS_PROXY: "http://proxy.invalid",
    NODE_EXTRA_CA_CERTS: "/untrusted/ca.pem",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    SSL_CERT_FILE: "/untrusted/cert.pem",
    npm_config_userconfig: "/untrusted/user-npmrc",
    "npm_config_@hono:registry": "https://scoped-mirror.invalid",
  });
  const unexpectedNpmConfigKeys = Object.keys(observed).filter(
    (key) =>
      isNpmConfig(key) &&
      ![
        "npm_config_globalconfig",
        "npm_config_registry",
        "npm_config_strict_ssl",
        "npm_config_userconfig",
      ].includes(key),
  );
  let rejectsProjectConfig = false;
  try {
    assertNoProjectNpmConfig("/synthetic/project", () => true);
  } catch {
    rejectsProjectConfig = true;
  }
  assertNoProjectNpmConfig("/synthetic/project", () => false);
  if (
    observed.PATH !== "/synthetic/system/path" ||
    observed.NPM_CONFIG_ALLOW_SCRIPTS !== undefined ||
    observed.NPM_CONFIG_GLOBALCONFIG !== undefined ||
    observed.NPM_CONFIG_REGISTRY !== undefined ||
    observed.NPM_CONFIG_STRICT_SSL !== undefined ||
    observed.HTTPS_PROXY !== undefined ||
    observed.NODE_EXTRA_CA_CERTS !== undefined ||
    observed.NODE_TLS_REJECT_UNAUTHORIZED !== undefined ||
    observed.SSL_CERT_FILE !== undefined ||
    observed.npm_config_globalconfig !== auditGlobalConfig ||
    observed.npm_config_registry !== publicRegistry ||
    observed.npm_config_strict_ssl !== "true" ||
    observed.npm_config_userconfig !== auditUserConfig ||
    unexpectedNpmConfigKeys.length !== 0 ||
    !rejectsProjectConfig
  ) {
    throw new Error("npm audit environment policy self-test failed.");
  }
}
