import http2 from 'http2';
import http from 'http';

const SERVER_URL = 'http://localhost:9001';
const LOCAL_PORT = 5173; // Port of your local application to proxy to

let clientId: string | null = null;

// Connect to the tunnel server using HTTP/2
console.log('[Client] Connecting to tunnel server...');
const session = http2.connect(SERVER_URL);

session.on('error', (err) => {
  console.error('[Client] Session error:', err);
  process.exit(1);
});

session.on('connect', () => {
  console.log('[Client] Connected to tunnel server');
  
  // Register with the server
  const registerStream = session.request({
    ':method': 'POST',
    ':path': '/register'
  });
  
  registerStream.setEncoding('utf8');
  
  let data = '';
  registerStream.on('data', (chunk) => {
    data += chunk;
  });
  
  registerStream.on('end', () => {
    const response = JSON.parse(data);
    clientId = response.clientId;
    console.log(`[Client] Registered with ID: ${clientId}`);
    console.log(`[Client] Waiting for requests to proxy to localhost:${LOCAL_PORT}...`);
  });
  
  registerStream.end();
});

// Listen for incoming streams (requests from server to proxy)
session.on('stream', (stream, headers) => {
  const method = headers[':method'];
  const path = headers[':path'];
  
  console.log(`[Client] Received request to proxy: ${method} ${path}`);
  
  // Make request to local server
  // Filter out HTTP/2 pseudo-headers and convert to proper header format
  const filteredHeaders: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.startsWith(':') && (typeof value === 'string' || typeof value === 'number' || Array.isArray(value))) {
      filteredHeaders[key] = value as string | number | string[];
    }
  }
  
  const localReq = http.request({
    host: 'localhost',
    port: LOCAL_PORT,
    path: path as string,
    method: method as string,
    headers: filteredHeaders
  }, (localRes) => {
    console.log(`[Client] Got response from localhost:${LOCAL_PORT} - ${localRes.statusCode}`);
    
    // Send response headers back through the tunnel
    stream.respond({
      ':status': localRes.statusCode,
      ...localRes.headers
    });
    
    // Pipe response body back through the tunnel
    localRes.pipe(stream);
  });
  
  localReq.on('error', (err) => {
    console.error('[Client] Error connecting to local server:', err.message);
    if (!stream.headersSent) {
      stream.respond({ ':status': 502 });
      stream.end('Could not connect to local server');
    }
  });
  
  // Pipe request body to local server
  stream.pipe(localReq);
});

session.on('close', () => {
  console.log('[Client] Session closed');
  process.exit(0);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Client] Shutting down...');
  session.close();
});
