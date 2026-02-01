import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseClientSentMessage, type ServerSentMessage } from "common";
import sshpk from "sshpk";
import { type WebSocket, WebSocketServer } from "ws";

const CONTROL_SERVER_PORT = 9001;
const PROXY_SERVER_PORT = 9000;

const AUTH_PAYLOAD_PREFIX = "local-tunnel-auth-v1:";
const AUTHORIZED_KEYS_PATH = new URL("../authorized_keys", import.meta.url);
const DEFAULT_AUTHORIZED_KEYS_PATH = path.join(
  os.homedir(),
  ".ssh",
  "authorized_keys",
);

function isSignableKeyType(
  type: sshpk.AlgorithmTypeWithCurve,
): type is sshpk.AlgorithmType {
  return type !== "curve25519";
}

function authPayload(nonce: string) {
  return Buffer.from(`${AUTH_PAYLOAD_PREFIX}${nonce}`, "utf8");
}

function findSshPublicKeyInAuthorizedKeysLine(line: string) {
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

function loadAuthorizedKeyFingerprints(
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

const allowedKeyFingerprints = loadAuthorizedKeyFingerprints([
  { label: "repo", path: AUTHORIZED_KEYS_PATH.pathname },
  { label: "default", path: DEFAULT_AUTHORIZED_KEYS_PATH },
]);

const controlServer = http.createServer();
const websocketServer = new WebSocketServer({ server: controlServer });

const clients = new Map<string, { clientId: string; ws: WebSocket }>();

function sendMessageFromServer(ws: WebSocket, args: ServerSentMessage) {
  ws.send(JSON.stringify(args));
}

websocketServer.on("connection", (ws, req) => {
  const clientId = randomUUID();

  console.log({ url: req.url });

  if (!req.url) {
    ws.close();
    return;
  }

  const url = new URL(req.url, "http://localhost");

  const domain = url.searchParams.get("subdomain");

  console.log({ domain });

  if (!domain) {
    ws.close();
    return;
  }

  const nonce = randomBytes(32).toString("base64url");

  sendMessageFromServer(ws, {
    type: "auth_challenge",
    nonce,
  });

  const onAuthMessage = (data: Buffer) => {
    const message = parseClientSentMessage(data.toString());

    if (message.type !== "auth_response") {
      ws.close(1008, "auth required");
      return;
    }

    try {
      const key = sshpk.parseKey(message.publicKey, "ssh");
      const fp = key.fingerprint().toString();

      if (!allowedKeyFingerprints.has(fp)) {
        ws.close(1008, "unauthorized key");
        return;
      }

      if (!isSignableKeyType(key.type)) {
        ws.close(1008, `unsupported key type: ${key.type}`);
        return;
      }

      const sig = sshpk.parseSignature(message.signature, key.type, "ssh");
      const v = key.createVerify(message.hashAlgorithm);
      v.update(authPayload(nonce));

      if (!v.verify(sig)) {
        ws.close(1008, "invalid signature");
        return;
      }

      ws.removeListener("message", onAuthMessage);

      const existingClient = clients.get(domain);
      if (existingClient) {
        existingClient.ws.close();
      }

      clients.set(domain, { clientId, ws });

      sendMessageFromServer(ws, {
        type: "registered",
        clientId,
        subdomain: domain,
      });
    } catch {
      ws.close(1008, "auth error");
    }
  };

  ws.on("message", onAuthMessage);

  ws.on("close", () => {
    console.log(`Client: ${clientId} closed`);
    const current = clients.get(domain);
    if (current?.ws === ws) {
      clients.delete(domain);
    }
  });

  ws.on("error", (err) => {
    console.error(`Websocket error for client ${clientId}: ${err}`);
    const current = clients.get(domain);
    if (current?.ws === ws) {
      clients.delete(domain);
    }
  });
});

controlServer.listen(CONTROL_SERVER_PORT, () => {
  console.log(
    `websocket controll server is listening on: ${CONTROL_SERVER_PORT}`,
  );
});

async function readWholeRequest(req: http.IncomingMessage) {
  return new Promise<Array<Buffer>>((res, rej) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (data: Buffer) => {
      chunks.push(data);
    });

    req.on("end", () => {
      res(chunks);
    });

    req.on("error", (err) => {
      rej(err);
    });
  });
}

async function handleIncomingProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse<http.IncomingMessage> & {
    req: http.IncomingMessage;
  },
) {
  try {
    console.log(`[browser] request: ${req.method} ${req.url}`);

    const host = req.headers.host;

    if (!host) {
      res.writeHead(400, "bad request - missing host header");
      res.end();
      return;
    }

    const hostParts = host.split(".");

    if (hostParts.length !== 3) {
      res.writeHead(400, "bad request - no subdomin or too many subdomain");
      res.end();
      return;
    }

    const subdomain = hostParts[0];

    const client = clients.get(subdomain);

    if (!client) {
      console.log(
        `[browser] there no matching client for subdomain: ${subdomain}`,
      );
      res.writeHead(503, "no client listening");
      res.end();
      return;
    }

    const wholeContent = await readWholeRequest(req);

    const body = Buffer.concat(wholeContent).toString("base64");
    const requestId = crypto.randomUUID();

    const message = {
      type: "request" as const,
      requestId,
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body,
    };

    const responseHandler = (data: Buffer) => {
      const response = parseClientSentMessage(data.toString());

      if (response.type === "response" && response.requestId === requestId) {
        console.log(
          `[Server] Received response for request ${requestId}: ${response.statusCode}`,
        );

        res.writeHead(response.statusCode, response.headers);
        res.end(Buffer.from(response.body, "base64"));

        client.ws.removeListener("message", responseHandler);
      }
    };

    client.ws.on("message", responseHandler);
    sendMessageFromServer(client.ws, message);
  } catch (err) {
    let errMsg = "unknown error";
    if (err instanceof Error) {
      errMsg = err.message;
    }

    console.log(`[browser] error while handling request: ${errMsg}`);
  }
}

const proxyServer = http.createServer((req, res) => {
  return handleIncomingProxyRequest(req, res);
});

proxyServer.listen(PROXY_SERVER_PORT, () => {
  console.log(`proxy server listening on port: ${PROXY_SERVER_PORT}`);
});
