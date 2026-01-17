import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const CONTROL_PORT = 9001; // Port for client to connect to
const PROXY_PORT = 9000; // Port for browser to connect to

// Store connected clients
const clients = new Map<string, WebSocket>();

// Create WebSocket server for control plane (client connections)
const controlServer = http.createServer();
const wss = new WebSocketServer({ server: controlServer });

wss.on('connection', (ws: WebSocket) => {
  const clientId = Math.random().toString(36).substring(7);
  clients.set(clientId, ws);
  
  console.log(`[Server] Client ${clientId} connected to control plane`);
  
  // Send clientId to the client
  ws.send(JSON.stringify({ type: 'registered', clientId }));
  
  ws.on('message', (data: Buffer) => {
    // Handle responses from client
    const message = JSON.parse(data.toString());
    
    if (message.type === 'response') {
      // This is handled by the proxy server below
      console.log(`[Server] Received response from client ${clientId}`);
    }
  });
  
  ws.on('close', () => {
    console.log(`[Server] Client ${clientId} disconnected`);
    clients.delete(clientId);
  });
  
  ws.on('error', (err: Error) => {
    console.error(`[Server] WebSocket error for client ${clientId}:`, err);
  });
});

controlServer.listen(CONTROL_PORT, () => {
  console.log(`[Server] Control plane listening on port ${CONTROL_PORT}`);
});

// Create HTTP server for browser requests
const proxyServer = http.createServer((req, res) => {
  console.log(`[Server] Browser request: ${req.method} ${req.url}`);
  
  // Get the first available client
  const clientEntries = Array.from(clients.entries());
  if (clientEntries.length === 0) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('No clients connected to tunnel');
    return;
  }
  
  const [clientId, ws] = clientEntries[0];
  console.log(`[Server] Proxying request to client ${clientId}`);
  
  // Collect request body
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => {
    chunks.push(chunk);
  });
  
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('base64');
    const requestId = Math.random().toString(36).substring(7);
    
    // Send request to client via WebSocket
    const message = {
      type: 'request',
      requestId,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body
    };
    
    // Set up one-time listener for response
    const responseHandler = (data: Buffer) => {
      const response = JSON.parse(data.toString());
      
      if (response.type === 'response' && response.requestId === requestId) {
        console.log(`[Server] Received response for request ${requestId}: ${response.statusCode}`);
        
        // Send response back to browser
        res.writeHead(response.statusCode, response.headers);
        res.end(Buffer.from(response.body, 'base64'));
        
        // Remove this listener
        ws.off('message', responseHandler);
      }
    };
    
    ws.on('message', responseHandler);
    ws.send(JSON.stringify(message));
  });
});

proxyServer.listen(PROXY_PORT, () => {
  console.log(`[Server] Proxy server listening on port ${PROXY_PORT}`);
  console.log(`[Server] Open http://localhost:${PROXY_PORT} in your browser`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  controlServer.close();
  proxyServer.close();
  process.exit(0);
});
