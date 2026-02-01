import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sshpk from "sshpk";

const AUTH_PAYLOAD_PREFIX = "local-tunnel-auth-v1:";
const AUTHORIZED_KEYS_PATH = new URL("../authorized_keys", import.meta.url);

const DEFAULT_AUTHORIZED_KEYS_PATH = path.join(
  os.homedir(),
  ".ssh",
  "authorized_keys",
);

export function isSignableKeyType(
  type: sshpk.AlgorithmTypeWithCurve,
): type is sshpk.AlgorithmType {
  return type !== "curve25519";
}

export function authPayload(nonce: string) {
  return Buffer.from(`${AUTH_PAYLOAD_PREFIX}${nonce}`, "utf8");
}

export function findSshPublicKeyInAuthorizedKeysLine(line: string) {
  // Check if there is any library which parses the SSH authorized_key files
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const parts = trimmed.split(/\s+/);
  for (let i = 0; i < parts.length - 1; i++) {
    const type = parts[i];
    const b64 = parts[i + 1];

    const looksLikeKeyType =
      type.startsWith("ssh-") ||
      type.startsWith("ecdsa-") ||
      type.startsWith("sk-");
    const looksLikeBase64 = /^[A-Za-z0-9+/=]+$/.test(b64);

    if (!looksLikeKeyType || !looksLikeBase64) continue;

    const comment = parts.slice(i + 2).join(" ");
    return `${type} ${b64}${comment ? ` ${comment}` : ""}`;
  }

  return null;
}

export function loadAuthorizedKeyFingerprints(
  sources: Array<{ label: string; path: string }>,
) {
  const allowed = new Set<string>();
  const loadedFrom: string[] = [];

  for (const source of sources) {
    if (!fs.existsSync(source.path)) continue;
    loadedFrom.push(`${source.label}:${source.path}`);

    const contents = fs.readFileSync(source.path, "utf8");
    for (const line of contents.split("\n")) {
      const maybeKeyLine = findSshPublicKeyInAuthorizedKeysLine(line);
      if (!maybeKeyLine) continue;

      const key = sshpk.parseKey(maybeKeyLine, "ssh");
      allowed.add(key.fingerprint().toString());
    }
  }

  if (allowed.size === 0) {
    throw new Error(
      `No authorized keys found. Add at least one public key to ${AUTHORIZED_KEYS_PATH.pathname} or ${DEFAULT_AUTHORIZED_KEYS_PATH}`,
    );
  }

  console.log(
    `[Auth] Loaded ${allowed.size} authorized key(s) from ${loadedFrom.join(", ")}`,
  );

  return allowed;
}

export function generateAuthNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function verifyAuthResponse(
  publicKey: string,
  signature: string,
  hashAlgorithm: "md5" | "sha1" | "sha256" | "sha384" | "sha512",
  nonce: string,
  allowedKeyFingerprints: Set<string>,
): { success: boolean; error?: string } {
  try {
    const key = sshpk.parseKey(publicKey, "ssh");
    const fp = key.fingerprint().toString();

    if (!allowedKeyFingerprints.has(fp)) {
      return { success: false, error: "unauthorized key" };
    }

    if (!isSignableKeyType(key.type)) {
      return { success: false, error: `unsupported key type: ${key.type}` };
    }

    const sig = sshpk.parseSignature(signature, key.type, "ssh");
    const v = key.createVerify(hashAlgorithm);
    v.update(authPayload(nonce));

    if (!v.verify(sig)) {
      return { success: false, error: "invalid signature" };
    }

    return { success: true };
  } catch {
    return { success: false, error: "auth error" };
  }
}

export function createAuthorizedKeysSet(): Set<string> {
  return loadAuthorizedKeyFingerprints([
    { label: "repo", path: AUTHORIZED_KEYS_PATH.pathname },
    { label: "default", path: DEFAULT_AUTHORIZED_KEYS_PATH },
  ]);
}
