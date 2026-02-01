import sshpk from "sshpk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentSignResponse,
  Client as SshpkAgentClient,
} from "sshpk-agent";
import sshpkAgent from "sshpk-agent";

const AUTH_PAYLOAD_PREFIX = "local-tunnel-auth-v1:";
const SSH_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

type SignableKey = sshpk.Key & { type: sshpk.AlgorithmType };

function isSignableKey(k: sshpk.Key): k is SignableKey {
  return k.type !== "curve25519";
}

function keyTypePreference(type: sshpk.AlgorithmType): number {
  // Prefer modern default SSH keys first.
  switch (type) {
    case "ed25519":
      return 0;
    case "ecdsa":
      return 1;
    case "rsa":
      return 2;
    case "dsa":
      return 3;
    default:
      return 99;
  }
}

function resolveSshAuthSock(input?: string): string {
  const raw = (input ?? "").trim();
  const fallback = path.join(os.homedir(), ".1password", "agent.sock");

  let socketPath = raw || fallback;

  if (!path.isAbsolute(socketPath)) {
    socketPath = path.resolve(socketPath);
  }

  if (!fs.existsSync(socketPath)) {
    throw new Error(
      [
        `SSH agent socket not found at: ${socketPath}`,
        raw
          ? `Provided via --ssh-auth-sock: ${raw}`
          : `No --ssh-auth-sock provided; tried default: ${fallback}`,
        "If you're using 1Password, enable the SSH agent and ensure it's running.",
      ].join("\n"),
    );
  }

  return socketPath;
}

function withAgentErrorHandling<T>(
  agentClient: SshpkAgentClient,
  op: (cb: (err: unknown, result?: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      agentClient.off("error", onError);
    };

    agentClient.once("error", onError);

    op((err, result) => {
      cleanup();
      if (err) {
        reject(err);
        return;
      }
      resolve(result as T);
    });
  });
}

function createAgentClient(sshAuthSock?: string) {
  const socketPath = resolveSshAuthSock(sshAuthSock);
  return new sshpkAgent.Client({ socketPath, timeout: SSH_AGENT_TIMEOUT_MS });
}

function listAgentKeys(agentClient: SshpkAgentClient) {
  return withAgentErrorHandling<sshpk.Key[]>(agentClient, (cb) => {
    agentClient.listKeys({ timeout: SSH_AGENT_TIMEOUT_MS }, cb);
  });
}

function signWithAgent(
  agentClient: SshpkAgentClient,
  key: SignableKey,
  payload: Buffer,
) {
  return new Promise<sshpk.Signature>((resolve, reject) => {
    // sshpk-agent hard-codes RSA flags for sign requests, which causes some
    // agents (notably 1Password) to reject signing with non-RSA keys.
    // Use the underlying request API so we can set the correct flags.
    const flags = key.type === "rsa" ? ["rsa-sha2-256"] : [];

    const frame = {
      type: "sign-request" as const,
      publicKey: key.toBuffer("rfc4253"),
      data: payload,
      flags,
    };

    const resps: Array<AgentSignResponse["type"]> = [
      "failure",
      "sign-response",
    ];

    withAgentErrorHandling<AgentSignResponse>(agentClient, (cb) => {
      agentClient.doRequest(frame, resps, SSH_AGENT_TIMEOUT_MS, cb);
    })
      .then((resp) => {
        if (resp.type === "failure") {
          throw new Error(
            'SSH agent returned "failure" code in response to "sign-request" (key not found, user refused confirmation, or other failure)',
          );
        }

        const sig: sshpk.Signature = sshpk.parseSignature(
          resp.signature,
          key.type,
          "ssh",
        );

        if (!sig.hashAlgorithm) {
          switch (key.type) {
            case "rsa":
              sig.hashAlgorithm = "sha256";
              break;
            case "dsa":
              sig.hashAlgorithm = "sha1";
              break;
            case "ecdsa":
              sig.hashAlgorithm =
                key.size <= 256
                  ? "sha256"
                  : key.size <= 384
                    ? "sha384"
                    : "sha512";
              break;
            case "ed25519":
              sig.hashAlgorithm = "sha512";
              break;
            default:
              throw new Error(
                `Failed to determine hash algorithm for key type ${key.type}`,
              );
          }
        }

        resolve(sig);
      })
      .catch(reject);
  });
}

async function findKeyAndSign(
  agentClient: SshpkAgentClient,
  orderedKeys: SignableKey[],
  payload: Buffer,
  keyFingerprint?: string,
  keyComment?: string,
): Promise<{ key: SignableKey; signature: sshpk.Signature }> {
  if (keyFingerprint) {
    const fp: sshpk.Fingerprint = sshpk.parseFingerprint(keyFingerprint);
    const match = orderedKeys.find((k) => fp.matches(k));
    if (!match) {
      throw new Error(`No agent key matches fingerprint: ${keyFingerprint}`);
    }
    const signature = await signWithAgent(agentClient, match, payload);
    return { key: match, signature };
  }

  if (keyComment) {
    const match = orderedKeys.find(
      (k) => typeof k.comment === "string" && k.comment.includes(keyComment),
    );
    if (!match) {
      throw new Error(`No agent key matches comment filter: ${keyComment}`);
    }
    const signature = await signWithAgent(agentClient, match, payload);
    return { key: match, signature };
  }

  const errors: string[] = [];
  for (const candidate of orderedKeys) {
    try {
      const signature = await signWithAgent(agentClient, candidate, payload);
      return { key: candidate, signature };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fp = candidate.fingerprint("sha256").toString();
      errors.push(`${candidate.type} ${fp}: ${msg}`);
    }
  }

  throw new Error(
    `SSH agent could not sign with any key. Errors:\n${errors.join("\n")}`,
  );
}

export interface BuildAuthResponseOptions {
  keyFingerprint?: string;
  keyComment?: string;
  sshAuthSock?: string;
}

export async function buildAuthResponse(
  nonce: string,
  options: BuildAuthResponseOptions,
) {
  const payload = Buffer.from(`${AUTH_PAYLOAD_PREFIX}${nonce}`, "utf8");

  const agentClient = createAgentClient(options.sshAuthSock);

  const allKeys = await listAgentKeys(agentClient);
  const keys = allKeys.filter(isSignableKey);

  if (keys.length === 0) {
    throw new Error(
      "No signable SSH keys available from agent (is 1Password SSH agent enabled?)",
    );
  }

  const { keyFingerprint, keyComment } = options;

  const orderedKeys = [...keys].sort(
    (a, b) => keyTypePreference(a.type) - keyTypePreference(b.type),
  );

  const { key, signature } = await findKeyAndSign(
    agentClient,
    orderedKeys,
    payload,
    keyFingerprint,
    keyComment,
  );

  if (!signature || !signature.hashAlgorithm) {
    throw new Error("SSH agent did not report a hashAlgorithm for signature");
  }

  return {
    type: "auth_response" as const,
    publicKey: key.toString("ssh"),
    signature: signature.toString("ssh"),
    hashAlgorithm: signature.hashAlgorithm,
  };
}
