import http from "node:http";
import { type ClientSentMessage, parseServerSentMessage } from "common";
import { WebSocket } from "partysocket";
import type { CommandModule } from "yargs";
import sshpk from "sshpk";
import sshpkAgent from "sshpk-agent";

const AUTH_PAYLOAD_PREFIX = "local-tunnel-auth-v1:";

function isSignableKeyType(
  type: sshpk.AlgorithmTypeWithCurve,
): type is sshpk.AlgorithmType {
  return type !== "curve25519";
}

export const ServeCommand: CommandModule<
  unknown,
  {
    port: number;
    server: string;
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

    const agentClient = new sshpkAgent.Client();

    function listAgentKeys() {
      return new Promise<sshpk.Key[]>((resolve, reject) => {
        agentClient.listKeys((err, keys) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(keys);
        });
      });
    }

    function signWithAgent(key: sshpk.Key, payload: Buffer) {
      return new Promise<sshpk.Signature>((resolve, reject) => {
        agentClient.sign(key, payload, (err, signature) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(signature);
        });
      });
    }

    async function buildAuthResponse(nonce: string) {
      const payload = Buffer.from(`${AUTH_PAYLOAD_PREFIX}${nonce}`, "utf8");

      const keys = (await listAgentKeys()).filter((k) =>
        isSignableKeyType(k.type),
      );
      if (keys.length === 0) {
        throw new Error(
          "No signable SSH keys available from agent (is 1Password SSH agent enabled?)",
        );
      }

      const { keyFingerprint, keyComment } = args;

      let key = keys[0];
      if (keyFingerprint) {
        const fp: sshpk.Fingerprint = sshpk.parseFingerprint(keyFingerprint);
        const match = keys.find((k) => fp.matches(k));
        if (!match) {
          throw new Error(
            `No agent key matches fingerprint: ${keyFingerprint}`,
          );
        }
        key = match;
      } else if (keyComment) {
        const match = keys.find(
          (k) =>
            typeof k.comment === "string" && k.comment.includes(keyComment),
        );
        if (!match) {
          throw new Error(`No agent key matches comment filter: ${keyComment}`);
        }
        key = match;
      }

      const signature = await signWithAgent(key, payload);

      if (!signature.hashAlgorithm) {
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
