export const PUBLIC_CERTIFICATE_NAMES = Object.freeze({
  trustAnchor: "mcpb-trust-anchor.pem",
  intermediates: Object.freeze([
    "mcpb-intermediate-1.pem",
    "mcpb-intermediate-2.pem",
    "mcpb-intermediate-3.pem",
    "mcpb-intermediate-4.pem",
  ]),
});

function normalizedPath(file) {
  return file.replaceAll("\\", "/");
}

export function allowedPublicCertificatePaths(policy, packagePrivate) {
  if (typeof packagePrivate !== "boolean") {
    throw new Error("Package private state must be an explicit boolean.");
  }
  if (
    (packagePrivate === true && policy?.status !== "unconfigured") ||
    (packagePrivate === false && policy?.status !== "active")
  ) {
    throw new Error("Package state and MCPB signing-policy status are inconsistent.");
  }
  if (policy?.status === "unconfigured") return new Set();
  if (policy?.status !== "active") {
    throw new Error("MCPB signing policy has an unsupported status.");
  }
  if (policy.trustAnchor?.path !== PUBLIC_CERTIFICATE_NAMES.trustAnchor) {
    throw new Error("Active MCPB signing policy must use the fixed public trust-anchor path.");
  }
  if (!Array.isArray(policy.intermediates) || policy.intermediates.length > 4) {
    throw new Error("Active MCPB signing policy has an invalid intermediate-certificate list.");
  }

  const names = [
    policy.trustAnchor.path,
    ...policy.intermediates.map((entry, index) => {
      const expected = PUBLIC_CERTIFICATE_NAMES.intermediates[index];
      if (entry?.path !== expected) {
        throw new Error("Active MCPB signing policy must use fixed sequential intermediate paths.");
      }
      return entry.path;
    }),
  ];
  return new Set(names.map((name) => `release/${name}`));
}

export function isForbiddenPublicPath(file, allowedCertificates = new Set()) {
  const candidate = normalizedPath(file);
  if (candidate === ".env.example") return false;
  if (allowedCertificates.has(candidate)) return false;

  return (
    /(^|\/)(?:agents|architect|claude|gemini|memory|soul)\.md$/i.test(candidate) ||
    /(^|\/)(?:sdds?|glama|release-artifacts|signed-handoff|\.agents|\.audit|\.claude|\.codex|\.opencode|\.secrets|\.semgrep-rules|\.ssh)(\/|$)/i.test(
      candidate,
    ) ||
    /(^|\/)\.env[^/]*$/i.test(candidate) ||
    /(^|\/)\.(?:netrc|npmrc|pypirc)$/i.test(candidate) ||
    /(^|\/)sbom\.cdx\.json$/i.test(candidate) ||
    /(?:^|\/)(?:id_dsa|id_ecdsa|id_ed25519|id_rsa)[^/]*$/i.test(candidate) ||
    /\.(?:asc|gpg|jks|key|keystore|p12|p8|pem|pfx|ppk)$/i.test(candidate) ||
    /\.(?:mcpb|tgz)$/i.test(candidate)
  );
}

export function isForbiddenMcpbProjectPath(file) {
  const candidate = normalizedPath(file);
  return /(?:^|\/)(?:src|test)(?:\/|$)/i.test(candidate) || isForbiddenPublicPath(candidate);
}
