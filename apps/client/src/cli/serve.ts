import http from "node:http";
import { type ClientSentMessage, parseServerSentMessage } from "common";
import { WebSocket } from "partysocket";
import sshpk from "sshpk";
import type {
  AgentSignResponse,
  Client as SshpkAgentClient,
} from "sshpk-agent";
import sshpkAgent from "sshpk-agent";
import type { CommandModule } from "yargs";

const AUTH_PAYLOAD_PREFIX = "local-tunnel-auth-v1:";
const SSH_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

type SignableKey = sshpk.Key & { type: sshpk.AlgorithmType };

function isSignableKeyType(
  type: sshpk.AlgorithmTypeWithCurve,
): type is sshpk.AlgorithmType {
  return type !== "curve25519";
}

function isSignableKey(k: sshpk.Key): k is SignableKey {
  return isSignableKeyType(k.type);
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

export const ServeCommand: CommandModule<
  unknown,
  {
    port: number;
    server: string;
    sshAuthSock?: string;
    keyFingerprint?: string;
    keyComment?: string;
  }
> = {
  command: "serve <port>",
  describe: "Serves localhost to internet",
  builder: (yargs) => {
    return yargs
      .positional("port", {
        describe: "local port to proxy",
        type: "number",
        demandOption: true,
      })
      .option("server", {
        describe: "server to connect to",
        type: "string",
        default: "wss://nive.town",
      })
      .option("ssh-auth-sock", {
        describe: "Path to ssh-agent socket (defaults to SSH_AUTH_SOCK)",
        type: "string",
      })
      .option("key-fingerprint", {
        describe: "SSH key fingerprint to use (from ssh-agent)",
        type: "string",
      })
      .option("key-comment", {
        describe: "Pick key whose comment includes this string",
        type: "string",
      });
  },
  handler: async (args) => {
    const { port, server } = args;

    let clientId: string | null = null;

    function sendMessageFromClient(ws: WebSocket, message: ClientSentMessage) {
      ws.send(JSON.stringify(message));
    }

    function createAgentClient() {
      const socketPath = args.sshAuthSock ?? process.env.SSH_AUTH_SOCK;
      if (!socketPath || typeof socketPath !== "string") {
        throw new Error(
          "No SSH agent detected. Set SSH_AUTH_SOCK (or pass --ssh-auth-sock) so the client can sign the auth challenge.",
        );
      }

      return new sshpkAgent.Client({
        socketPath,
        timeout: SSH_AGENT_TIMEOUT_MS,
      });
    }

    function listAgentKeys(agentClient: SshpkAgentClient) {
      return new Promise<sshpk.Key[]>((resolve, reject) => {
        agentClient.listKeys({ timeout: SSH_AGENT_TIMEOUT_MS }, (err, keys) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(keys);
        });
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

        agentClient.doRequest(
          frame,
          resps,
          SSH_AGENT_TIMEOUT_MS,
          (err, resp) => {
            if (err) {
              reject(err);
              return;
            }

            if (resp.type === "failure") {
              reject(
                new Error(
                  'SSH agent returned "failure" code in response to "sign-request" (key not found, user refused confirmation, or other failure)',
                ),
              );
              return;
            }

            try {
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
            } catch (e) {
              reject(e);
            }
          },
        );
      });
    }

    async function buildAuthResponse(nonce: string) {
      const payload = Buffer.from(`${AUTH_PAYLOAD_PREFIX}${nonce}`, "utf8");

      const agentClient = createAgentClient();

      const allKeys = await listAgentKeys(agentClient);
      const keys = allKeys.filter(isSignableKey);

      if (keys.length === 0) {
        throw new Error(
          "No signable SSH keys available from agent (is 1Password SSH agent enabled?)",
        );
      }

      const { keyFingerprint, keyComment } = args;

      const orderedKeys = [...keys].sort(
        (a, b) => keyTypePreference(a.type) - keyTypePreference(b.type),
      );

      let key: SignableKey | null = null;
      let signature: sshpk.Signature | null = null;

      if (keyFingerprint) {
        const fp: sshpk.Fingerprint = sshpk.parseFingerprint(keyFingerprint);
        const match = orderedKeys.find((k) => fp.matches(k));
        if (!match) {
          throw new Error(
            `No agent key matches fingerprint: ${keyFingerprint}`,
          );
        }
        key = match;
        signature = await signWithAgent(agentClient, key, payload);
      } else if (keyComment) {
        const match = orderedKeys.find(
          (k) =>
            typeof k.comment === "string" && k.comment.includes(keyComment),
        );
        if (!match) {
          throw new Error(`No agent key matches comment filter: ${keyComment}`);
        }
        key = match;
        signature = await signWithAgent(agentClient, key, payload);
      } else {
        const errors: string[] = [];
        for (const candidate of orderedKeys) {
          try {
            const sig = await signWithAgent(agentClient, candidate, payload);
            key = candidate;
            signature = sig;
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const fp = candidate.fingerprint("sha256").toString();
            errors.push(`${candidate.type} ${fp}: ${msg}`);
          }
        }

        if (!key || !signature) {
          throw new Error(
            `SSH agent could not sign with any key. Errors:\n${errors.join("\n")}`,
          );
        }
      }

      if (!signature || !signature.hashAlgorithm) {
        throw new Error(
          "SSH agent did not report a hashAlgorithm for signature",
        );
      }

      return {
        type: "auth_response" as const,
        publicKey: key.toString("ssh"),
        signature: signature.toString("ssh"),
        hashAlgorithm: signature.hashAlgorithm,
      };
    }

    const url = new URL(server);
    url.searchParams.set("subdomain", `${port}`);
    console.log(`[Client] Connecting to tunnel server... ${url.toString()}`);

    const ws = new WebSocket(url.toString());

    ws.addEventListener("open", () => {
      console.log("[Client] Connected to tunnel server");
    });

    ws.addEventListener("message", async ({ data }: { data: Buffer }) => {
      try {
        const message = parseServerSentMessage(data.toString());

        if (message.type === "auth_challenge") {
          try {
            console.log("[CLIENT] Got auth challenge from server");
            const authResponse = await buildAuthResponse(message.nonce);
            console.log("[CLIENT] Sending auth response to server");
            sendMessageFromClient(ws, authResponse);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Client] Authentication failed: ${msg}`);
            ws.close();
          }

          return;
        }

        if (message.type === "registered") {
          clientId = message.clientId;
          console.log(`[Client] Registered with ID: ${clientId}`);
          console.log(
            `[Client] Waiting for requests to proxy to localhost:${port}...`,
          );
          return;
        }

        if (message.type === "request") {
          const { requestId, method, url: requestUrl, headers, body } = message;
          console.log(
            `[Client] Received request to proxy: ${method} ${requestUrl}`,
          );

          const localReq = http.request(
            {
              host: "localhost",
              port: port,
              path: requestUrl,
              method: method,
              headers: {
                ...headers,
                host: `localhost:${port}`,
              },
            },
            (localRes) => {
              console.log(
                `[Client] Got response from localhost:${port} - ${localRes.statusCode}`,
              );

              const chunks: Buffer[] = [];
              localRes.on("data", (chunk) => {
                chunks.push(chunk);
              });

              localRes.on("end", () => {
                const responseBody = Buffer.concat(chunks).toString("base64");

                const response = {
                  type: "response",
                  requestId,
                  statusCode: localRes.statusCode ?? 200,
                  headers: localRes.headers,
                  body: responseBody,
                } as const;

                sendMessageFromClient(ws, response);
                console.log(`[Client] Sent response for request ${requestId}`);
              });
            },
          );

          localReq.on("error", (err) => {
            console.error(
              "[Client] Error connecting to local server:",
              err.message,
            );

            const response = {
              type: "response",
              requestId,
              statusCode: 502,
              headers: { "Content-Type": "text/plain" },
              body: Buffer.from("Could not connect to local server").toString(
                "base64",
              ),
            } as const;

            sendMessageFromClient(ws, response);
          });

          if (body) {
            localReq.write(Buffer.from(body, "base64"));
          }
          localReq.end();
        }
      } catch (err) {
        console.error(err);
      }
    });

    ws.addEventListener("error", (err: Error) => {
      console.error("[Client] WebSocket error:", err);
    });

    ws.addEventListener("close", (data) => {
      console.log(`[Client] Connection closed: ${data.reason}`);
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("\n[Client] Shutting down...");
      ws.close();
    });
  },
};
