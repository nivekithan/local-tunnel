import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseClientSentMessage, type ServerSentMessage } from "common";

const CONTROL_SERVER_PORT = 9001;
const PROXY_SERVER_PORT = 9000;

const controlServer = http.createServer();
const websocketServer = new WebSocketServer({ server: controlServer });

const clients = new Map<string, { clientId: string; ws: WebSocket }>();

function sendMessageFromServer(ws: WebSocket, args: ServerSentMessage) {
  ws.send(JSON.stringify(args));
}

websocketServer.on("connection", (ws, req) => {
  const clientId = crypto.randomUUID();

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

  clients.set(domain, { clientId, ws });

  sendMessageFromServer(ws, {
    type: "registered",
    clientId,
    subdomain: domain,
  });

  ws.on("close", () => {
    console.log(`Client: ${clientId} closed`);
    clients.delete(domain);
  });

  ws.on("error", (err) => {
    console.error(`Websocket error for client ${clientId}: ${err}`);
    clients.delete(domain);
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
