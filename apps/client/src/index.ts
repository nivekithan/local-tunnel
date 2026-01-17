import WebSocket from 'ws';
import http from 'http';

const SERVER_URL = 'ws://localhost:9001';
const LOCAL_PORT = 5173; // Port of your local application to proxy to

let clientId: string | null = null;

console.log('[Client] Connecting to tunnel server...');
const ws = new WebSocket(SERVER_URL);

ws.on('open', () => {
  console.log('[Client] Connected to tunnel server');
});

ws.on('message', (data: Buffer) => {
  const message = JSON.parse(data.toString());
  
  if (message.type === 'registered') {
    clientId = message.clientId;
    console.log(`[Client] Registered with ID: ${clientId}`);
    console.log(`[Client] Waiting for requests to proxy to localhost:${LOCAL_PORT}...`);
    return;
  }
  
  if (message.type === 'request') {
    const { requestId, method, url, headers, body } = message;
    console.log(`[Client] Received request to proxy: ${method} ${url}`);
    
    // Make request to local server
    const localReq = http.request({
      host: 'localhost',
      port: LOCAL_PORT,
      path: url,
      method: method,
      headers: {
        ...headers,
        host: `localhost:${LOCAL_PORT}` // Override host header
      }
    }, (localRes) => {
      console.log(`[Client] Got response from localhost:${LOCAL_PORT} - ${localRes.statusCode}`);
      
      // Collect response body
      const chunks: Buffer[] = [];
      localRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      localRes.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('base64');
        
        // Send response back to server
        const response = {
          type: 'response',
          requestId,
          statusCode: localRes.statusCode,
          headers: localRes.headers,
          body: responseBody
        };
        
        ws.send(JSON.stringify(response));
        console.log(`[Client] Sent response for request ${requestId}`);
      });
    });
    
    localReq.on('error', (err) => {
      console.error('[Client] Error connecting to local server:', err.message);
      
      // Send error response
      const response = {
        type: 'response',
        requestId,
        statusCode: 502,
        headers: { 'Content-Type': 'text/plain' },
        body: Buffer.from('Could not connect to local server').toString('base64')
      };
      
      ws.send(JSON.stringify(response));
    });
    
    // Write request body if present
    if (body) {
      localReq.write(Buffer.from(body, 'base64'));
    }
    localReq.end();
  }
});

ws.on('error', (err: Error) => {
  console.error('[Client] WebSocket error:', err);
  process.exit(1);
});

ws.on('close', () => {
  console.log('[Client] Connection closed');
  process.exit(0);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Client] Shutting down...');
  ws.close();
});
