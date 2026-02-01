import http from "node:http";
import os from "node:os";
import path from "node:path";
import { type ClientSentMessage, parseServerSentMessage } from "common";
import { WebSocket } from "partysocket";
import type { CommandModule } from "yargs";
import { buildAuthResponse } from "../ssh-auth.ts";

export const ServeCommand: CommandModule<
  unknown,
  {
    port: number;
    server: string;
    "ssh-auth-sock": string;
    "key-fingerprint"?: string;
    "key-comment"?: string;
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
        describe: "Path to ssh-agent socket",
        type: "string",
        default: path.join(os.homedir(), ".1password", "agent.sock"),
        defaultDescription: "$HOME/.1password/agent.sock",
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

            const authResponse = await buildAuthResponse(message.nonce, {
              keyFingerprint: args["key-fingerprint"],
              keyComment: args["key-comment"],
              sshAuthSock: args["ssh-auth-sock"],
            });

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
