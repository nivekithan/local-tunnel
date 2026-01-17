import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseClientSentMessage } from "common";

const CONTROL_SERVER_PORT = 9001;
const PROXY_SERVER_PORT = 9000;

const SUBDOMAIN = "static";

const controlServer = http.createServer();
const websocketServer = new WebSocketServer({ server: controlServer });

const clients = new Map<string, { clientId: string; ws: WebSocket }>();

websocketServer.on("connection", (ws) => {
  const clientId = crypto.randomUUID();

  clients.set(SUBDOMAIN, { clientId, ws });

  ws.send(
    JSON.stringify({ type: "registered", clientId, subdomain: SUBDOMAIN }),
  );

  ws.on("close", () => {
    console.log(`Client: ${clientId} closed`);
    clients.delete(clientId);
  });

  ws.on("error", (err) => {
    console.error(`Websocket error for client ${clientId}: ${err}`);
    clients.delete(clientId);
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

    const client = clients.get(SUBDOMAIN);

    if (!client) {
      console.log(
        `[browser] there no matching client for subdomain: ${SUBDOMAIN}`,
      );
      res.writeHead(503, "no client listening");
      res.end();
      return;
    }

    const wholeContent = await readWholeRequest(req);

    const body = Buffer.concat(wholeContent).toString("base64");
    const requestId = crypto.randomUUID();

    const message = {
      type: "request",
      requestId,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    };

    const responseHandler = (data: Buffer) => {
      const response = parseClientSentMessage(data);

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
    client.ws.send(JSON.stringify(message));
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
