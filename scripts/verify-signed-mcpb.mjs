import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { copyFile, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { signMcpbFile } from "@anthropic-ai/mcpb/node";
import { PUBLIC_CERTIFICATE_NAMES } from "./public-boundary-policy.mjs";

const execFileAsync = promisify(execFile);
const SIGNATURE_HEADER = Buffer.from("MCPB_SIG_V1", "utf8");
const SIGNATURE_FOOTER = Buffer.from("MCPB_SIG_END", "utf8");
const CODE_SIGNING_OID = "1.3.6.1.5.5.7.3.3";
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has unsupported fields.`);
}

function certificateBlocks(pem) {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function certificateFingerprint(pem) {
  return sha256(new X509Certificate(pem).raw);
}

function extractExactSignatureBlock(fileContent) {
  const footerIndex = fileContent.length - SIGNATURE_FOOTER.length;
  assert(footerIndex >= 0, "Signed MCPB has no exact signature footer.");
  assert(
    fileContent.subarray(footerIndex).equals(SIGNATURE_FOOTER),
    "Signed MCPB has trailing data or no exact signature footer.",
  );
  const headerIndex = fileContent.lastIndexOf(SIGNATURE_HEADER, footerIndex);
  assert(headerIndex >= 0, "Signed MCPB has no signature header.");
  const lengthOffset = headerIndex + SIGNATURE_HEADER.length;
  assert(lengthOffset + 4 <= footerIndex, "Signed MCPB signature length is missing.");
  const signatureLength = fileContent.readUInt32LE(lengthOffset);
  const signatureOffset = lengthOffset + 4;
  assert(signatureLength > 0, "Signed MCPB has an empty signature block.");
  assert(
    signatureOffset + signatureLength === footerIndex,
    "Signed MCPB signature framing is not canonical.",
  );
  return {
    originalContent: fileContent.subarray(0, headerIndex),
    pkcs7Signature: fileContent.subarray(signatureOffset, footerIndex),
  };
}

function verifyPayloadParity(unsignedContent, originalContent) {
  assert.equal(
    originalContent.length,
    unsignedContent.length,
    "The signed MCPB payload size differs from the reviewed unsigned candidate.",
  );
  assert(
    timingSafeEqual(originalContent, unsignedContent),
    "The signed MCPB payload differs from the reviewed unsigned candidate.",
  );
}

function resolvePinnedPath(policyDirectory, relativePath) {
  assert(
    typeof relativePath === "string" &&
      relativePath.length > 0 &&
      relativePath.length <= 256 &&
      !path.isAbsolute(relativePath) &&
      !relativePath.split(/[\\/]/).includes("..") &&
      /^[A-Za-z0-9._/-]+$/.test(relativePath) &&
      relativePath.endsWith(".pem"),
    "Signing-policy certificate paths must be bounded relative PEM paths.",
  );
  const resolved = path.resolve(policyDirectory, relativePath);
  const relative = path.relative(policyDirectory, resolved);
  assert(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Signing-policy path escapes its directory.",
  );
  return resolved;
}

async function readPinnedCertificate(policyDirectory, entry, label, expectedPath) {
  exactKeys(entry, ["path", "pemSha256"], label);
  assert.equal(entry.path, expectedPath, `${label} must use the fixed repository path.`);
  assert(SHA256.test(entry.pemSha256), `${label} PEM digest is invalid.`);
  const certificatePath = resolvePinnedPath(policyDirectory, entry.path);
  const certificateStat = await lstat(certificatePath);
  assert(
    certificateStat.isFile() && !certificateStat.isSymbolicLink(),
    `${label} must be a regular repository file, not a symbolic link.`,
  );
  const pem = await readFile(certificatePath);
  assert.equal(sha256(pem), entry.pemSha256, `${label} PEM digest mismatch.`);
  const blocks = certificateBlocks(pem.toString("utf8"));
  assert.equal(blocks.length, 1, `${label} must contain exactly one certificate.`);
  return { path: certificatePath, pem, certificate: new X509Certificate(blocks[0]) };
}

async function loadActivePolicy(policyPath) {
  const content = await readFile(policyPath, "utf8");
  const policy = JSON.parse(content);
  exactKeys(
    policy,
    ["schemaVersion", "status", "signingCertificateSha256", "trustAnchor", "intermediates"],
    "MCPB signing policy",
  );
  assert.equal(policy.schemaVersion, 1, "Unsupported MCPB signing-policy version.");
  assert.equal(
    policy.status,
    "active",
    "MCPB signing policy is unconfigured. Publication must remain blocked.",
  );
  assert(
    typeof policy.signingCertificateSha256 === "string" &&
      SHA256.test(policy.signingCertificateSha256),
    "Signing-certificate fingerprint is invalid.",
  );
  assert(
    Array.isArray(policy.intermediates) && policy.intermediates.length <= 4,
    "Signing-policy intermediates are invalid.",
  );
  const policyDirectory = path.dirname(path.resolve(policyPath));
  const trustAnchor = await readPinnedCertificate(
    policyDirectory,
    policy.trustAnchor,
    "Trust anchor",
    PUBLIC_CERTIFICATE_NAMES.trustAnchor,
  );
  assert(trustAnchor.certificate.ca, "The pinned trust anchor is not a CA certificate.");
  const intermediates = await Promise.all(
    policy.intermediates.map((entry, index) =>
      readPinnedCertificate(
        policyDirectory,
        entry,
        `Intermediate ${index + 1}`,
        PUBLIC_CERTIFICATE_NAMES.intermediates[index],
      ),
    ),
  );
  assert(
    intermediates.every(({ certificate }) => certificate.ca),
    "Every pinned intermediate must be a CA certificate.",
  );
  return {
    signingCertificateSha256: policy.signingCertificateSha256,
    trustAnchor,
    intermediates,
  };
}

async function runOpenSsl(args) {
  try {
    return await execFileAsync("openssl", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error("MCPB CMS signature or pinned certificate-chain verification failed.");
  }
}

async function verifyCmsSignature(pkcs7Signature, originalContent, policy) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcpb-signature-"));
  try {
    const signaturePath = path.join(temporaryRoot, "signature.der");
    const payloadPath = path.join(temporaryRoot, "payload.mcpb");
    const signerPath = path.join(temporaryRoot, "signer.pem");
    const embeddedPath = path.join(temporaryRoot, "embedded.pem");
    const verifiedPath = path.join(temporaryRoot, "verified.mcpb");
    const intermediatesPath = path.join(temporaryRoot, "intermediates.pem");
    await Promise.all([
      writeFile(signaturePath, pkcs7Signature, { mode: 0o600 }),
      writeFile(payloadPath, originalContent, { mode: 0o600 }),
      ...(policy.intermediates.length > 0
        ? [
            writeFile(
              intermediatesPath,
              Buffer.concat(policy.intermediates.map(({ pem }) => pem)),
              { mode: 0o600 },
            ),
          ]
        : []),
    ]);

    const verifyArguments = [
      "cms",
      "-verify",
      "-verify_retcode",
      "-binary",
      "-inform",
      "DER",
      "-in",
      signaturePath,
      "-content",
      payloadPath,
      "-CAfile",
      policy.trustAnchor.path,
      "-no-CApath",
      "-no-CAstore",
      "-purpose",
      "any",
      "-signer",
      signerPath,
      "-out",
      verifiedPath,
    ];
    if (policy.intermediates.length > 0) {
      verifyArguments.push("-certfile", intermediatesPath);
    }
    await runOpenSsl(verifyArguments);

    const verified = await readFile(verifiedPath);
    verifyPayloadParity(originalContent, verified);
    const signerPem = await readFile(signerPath, "utf8");
    const signers = certificateBlocks(signerPem);
    assert.equal(signers.length, 1, "MCPB must have exactly one signing certificate.");
    const signer = new X509Certificate(signers[0]);
    assert.equal(signer.ca, false, "MCPB signer must be an end-entity certificate.");
    assert.equal(
      sha256(signer.raw),
      policy.signingCertificateSha256,
      "MCPB signing certificate fingerprint mismatch.",
    );
    assert(
      signer.keyUsage?.includes(CODE_SIGNING_OID) === true,
      "MCPB signing certificate is not authorized for code signing.",
    );

    await runOpenSsl([
      "pkcs7",
      "-inform",
      "DER",
      "-in",
      signaturePath,
      "-print_certs",
      "-out",
      embeddedPath,
    ]);
    const embedded = certificateBlocks(await readFile(embeddedPath, "utf8"))
      .map(certificateFingerprint)
      .sort();
    const expectedEmbedded = [
      policy.signingCertificateSha256,
      ...policy.intermediates.map(({ certificate }) => sha256(certificate.raw)),
    ].sort();
    assert.deepEqual(
      embedded,
      expectedEmbedded,
      "MCPB embedded certificate inventory differs from pinned policy.",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifySignedMcpb(unsignedPath, signedPath, expectedSignedSha256, policyPath) {
  assert(SHA256.test(expectedSignedSha256), "Signed MCPB digest is invalid.");
  const [unsignedContent, signedContent, policy] = await Promise.all([
    readFile(unsignedPath),
    readFile(signedPath),
    loadActivePolicy(policyPath),
  ]);
  assert.equal(sha256(signedContent), expectedSignedSha256, "Signed MCPB digest mismatch.");
  const { originalContent, pkcs7Signature } = extractExactSignatureBlock(signedContent);
  verifyPayloadParity(unsignedContent, originalContent);
  await verifyCmsSignature(pkcs7Signature, originalContent, policy);
  return {
    signedSha256: expectedSignedSha256,
    signingCertificateSha256: policy.signingCertificateSha256,
    payloadSha256: sha256(unsignedContent),
    signatureStatus: "valid",
    payloadByteParity: true,
    policyPinned: true,
    status: "pass",
  };
}

async function generateCertificateAuthority(directory, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const keyPath = path.join(directory, `${slug}.key`);
  const certificatePath = path.join(directory, `${slug}.pem`);
  await runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=${name}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ]);
  return { keyPath, certificatePath };
}

async function generateLeafCertificate(directory, root, name, serial, extendedKeyUsage) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const keyPath = path.join(directory, `${slug}.key`);
  const requestPath = path.join(directory, `${slug}.csr`);
  const certificatePath = path.join(directory, `${slug}.pem`);
  const extensionsPath = path.join(directory, `${slug}.ext`);
  await writeFile(
    extensionsPath,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      `extendedKeyUsage=${extendedKeyUsage}`,
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await runOpenSsl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${name}`,
    "-keyout",
    keyPath,
    "-out",
    requestPath,
  ]);
  await runOpenSsl([
    "x509",
    "-req",
    "-in",
    requestPath,
    "-CA",
    root.certificatePath,
    "-CAkey",
    root.keyPath,
    "-set_serial",
    String(serial),
    "-days",
    "2",
    "-extfile",
    extensionsPath,
    "-out",
    certificatePath,
  ]);
  return { keyPath, certificatePath };
}

async function runSelfTest() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcpb-policy-self-test-"));
  try {
    const root = await generateCertificateAuthority(temporaryRoot, "Synthetic MCPB Root");
    const rogueRoot = await generateCertificateAuthority(temporaryRoot, "Synthetic Rogue Root");
    const leaf = await generateLeafCertificate(
      temporaryRoot,
      root,
      "Synthetic MCPB Signer",
      2,
      "codeSigning",
    );
    const wrongPurposeLeaf = await generateLeafCertificate(
      temporaryRoot,
      root,
      "Synthetic TLS Signer",
      3,
      "serverAuth",
    );

    const unsignedPath = path.join(temporaryRoot, "candidate.mcpb");
    const signedPath = path.join(temporaryRoot, "candidate-signed.mcpb");
    const policyPath = path.join(temporaryRoot, "policy.json");
    const unconfiguredPath = path.join(temporaryRoot, "unconfigured.json");
    await writeFile(unsignedPath, "synthetic-reviewed-candidate", { mode: 0o600 });
    await copyFile(unsignedPath, signedPath);
    signMcpbFile(signedPath, leaf.certificatePath, leaf.keyPath);

    const pinnedRootPath = path.join(temporaryRoot, PUBLIC_CERTIFICATE_NAMES.trustAnchor);
    await copyFile(root.certificatePath, pinnedRootPath);
    const rootPem = await readFile(pinnedRootPath);
    const leafPem = await readFile(leaf.certificatePath, "utf8");
    const activePolicy = {
      schemaVersion: 1,
      status: "active",
      signingCertificateSha256: certificateFingerprint(leafPem),
      trustAnchor: { path: PUBLIC_CERTIFICATE_NAMES.trustAnchor, pemSha256: sha256(rootPem) },
      intermediates: [],
    };
    await writeFile(policyPath, `${JSON.stringify(activePolicy, null, 2)}\n`, { mode: 0o600 });
    await writeFile(
      unconfiguredPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "unconfigured",
          signingCertificateSha256: null,
          trustAnchor: null,
          intermediates: [],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const signedDigest = sha256(await readFile(signedPath));
    await verifySignedMcpb(unsignedPath, signedPath, signedDigest, policyPath);
    const wrongPathPolicy = {
      ...activePolicy,
      trustAnchor: {
        ...activePolicy.trustAnchor,
        path: path.basename(root.certificatePath),
      },
    };
    const wrongPathPolicyPath = path.join(temporaryRoot, "wrong-certificate-path.json");
    await writeFile(wrongPathPolicyPath, `${JSON.stringify(wrongPathPolicy)}\n`, { mode: 0o600 });
    await assert.rejects(
      verifySignedMcpb(unsignedPath, signedPath, signedDigest, wrongPathPolicyPath),
      /fixed repository path/,
    );
    const symlinkPolicyDirectory = await mkdtemp(path.join(temporaryRoot, "symlink-policy-"));
    await symlink(
      root.certificatePath,
      path.join(symlinkPolicyDirectory, PUBLIC_CERTIFICATE_NAMES.trustAnchor),
    );
    const symlinkPolicyPath = path.join(symlinkPolicyDirectory, "policy.json");
    await writeFile(symlinkPolicyPath, `${JSON.stringify(activePolicy)}\n`, { mode: 0o600 });
    await assert.rejects(
      verifySignedMcpb(unsignedPath, signedPath, signedDigest, symlinkPolicyPath),
      /regular repository file/,
    );
    await assert.rejects(
      verifySignedMcpb(unsignedPath, signedPath, "0".repeat(64), policyPath),
      /digest mismatch/,
    );
    await assert.rejects(
      verifySignedMcpb(unsignedPath, signedPath, signedDigest, unconfiguredPath),
      /unconfigured/,
    );

    const wrongIdentityPolicy = {
      ...activePolicy,
      signingCertificateSha256: "0".repeat(64),
    };
    const wrongIdentityPath = path.join(temporaryRoot, "wrong-identity.json");
    await writeFile(wrongIdentityPath, `${JSON.stringify(wrongIdentityPolicy)}\n`, { mode: 0o600 });
    await assert.rejects(
      verifySignedMcpb(unsignedPath, signedPath, signedDigest, wrongIdentityPath),
      /fingerprint mismatch/,
    );

    const roguePem = await readFile(rogueRoot.certificatePath);
    const wrongTrustDirectory = await mkdtemp(path.join(temporaryRoot, "wrong-trust-"));
    await copyFile(
      rogueRoot.certificatePath,
      path.join(wrongTrustDirectory, PUBLIC_CERTIFICATE_NAMES.trustAnchor),
    );
    const wrongTrustPolicy = {
      ...activePolicy,
      trustAnchor: {
        path: PUBLIC_CERTIFICATE_NAMES.trustAnchor,
        pemSha256: sha256(roguePem),
      },
    };
    const wrongTrustPath = path.join(wrongTrustDirectory, "wrong-trust.json");
    await writeFile(wrongTrustPath, `${JSON.stringify(wrongTrustPolicy)}\n`, { mode: 0o600 });
    await assert.rejects(
      verifySignedMcpb(unsignedPath, signedPath, signedDigest, wrongTrustPath),
      /CMS signature or pinned certificate-chain verification failed/,
    );

    const wrongPurposeSignedPath = path.join(temporaryRoot, "wrong-purpose.mcpb");
    await copyFile(unsignedPath, wrongPurposeSignedPath);
    signMcpbFile(
      wrongPurposeSignedPath,
      wrongPurposeLeaf.certificatePath,
      wrongPurposeLeaf.keyPath,
    );
    const wrongPurposePem = await readFile(wrongPurposeLeaf.certificatePath, "utf8");
    const wrongPurposePolicy = {
      ...activePolicy,
      signingCertificateSha256: certificateFingerprint(wrongPurposePem),
    };
    const wrongPurposePath = path.join(temporaryRoot, "wrong-purpose.json");
    await writeFile(wrongPurposePath, `${JSON.stringify(wrongPurposePolicy)}\n`, { mode: 0o600 });
    const wrongPurposeDigest = sha256(await readFile(wrongPurposeSignedPath));
    await assert.rejects(
      verifySignedMcpb(unsignedPath, wrongPurposeSignedPath, wrongPurposeDigest, wrongPurposePath),
      /not authorized for code signing/,
    );

    const alteredUnsigned = path.join(temporaryRoot, "altered.mcpb");
    await writeFile(alteredUnsigned, "synthetic-changed--candidate", { mode: 0o600 });
    await assert.rejects(
      verifySignedMcpb(alteredUnsigned, signedPath, signedDigest, policyPath),
      /payload differs/,
    );

    const corruptedPath = path.join(temporaryRoot, "corrupted.mcpb");
    const corrupted = Buffer.from(await readFile(signedPath));
    const signatureStart =
      Buffer.byteLength("synthetic-reviewed-candidate") + SIGNATURE_HEADER.length + 4;
    corrupted[signatureStart + 12] ^= 0xff;
    await writeFile(corruptedPath, corrupted, { mode: 0o600 });
    await assert.rejects(
      verifySignedMcpb(unsignedPath, corruptedPath, sha256(corrupted), policyPath),
      /CMS signature or pinned certificate-chain verification failed/,
    );

    process.stdout.write("SIGNED_MCPB_VERIFIER_SELF_TEST=pass\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--self-test") {
  await runSelfTest();
  process.exit(0);
}

const [unsignedPath, signedPath, expectedSignedSha256, policyPath] = process.argv.slice(2);
if (!unsignedPath || !signedPath || !expectedSignedSha256 || !policyPath) {
  throw new Error("Usage: verify-signed-mcpb.mjs UNSIGNED SIGNED SIGNED_SHA256 POLICY_JSON");
}

console.log(
  JSON.stringify(
    await verifySignedMcpb(unsignedPath, signedPath, expectedSignedSha256, policyPath),
    null,
    2,
  ),
);
