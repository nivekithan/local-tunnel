import http2 from 'http2';
import http from 'http';

// Store active client sessions
const clients = new Map<string, http2.Http2Session>();

// Create HTTP/2 server (plaintext, no TLS needed for localhost)
const server = http2.createServer();

server.on('session', (session) => {
  console.log('New client session established');
  
  session.on('error', (err) => {
    console.error('Session error:', err);
  });
});

server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
  const path = headers[':path'];
  const method = headers[':method'];
  
  console.log(`[Server] Received: ${method} ${path}`);
  
  // Check if this is a client registration
  if (path === '/register' && method === 'POST') {
    // Generate a simple client ID
    const clientId = `client-${Date.now()}`;
    
    // Store the session for this client
    if (!stream.session) {
      stream.respond({ ':status': 500 });
      stream.end('No session available');
      return;
    }
    clients.set(clientId, stream.session);
    
    console.log(`[Server] Client registered: ${clientId}`);
    console.log(`[Server] Total clients: ${clients.size}`);
    
    // Send response
    stream.respond({
      ':status': 200,
      'content-type': 'application/json'
    });
    
    stream.end(JSON.stringify({ 
      clientId,
      message: 'Registered successfully'
    }));
    
    // Clean up when client disconnects
    if (stream.session) {
      stream.session.on('close', () => {
        clients.delete(clientId);
        console.log(`[Server] Client disconnected: ${clientId}`);
        console.log(`[Server] Total clients: ${clients.size}`);
      });
    }
    
    return;
  }
  
  // Handle public HTTP requests (to be proxied to client)
  // Extract client ID from subdomain or header
  const clientId = headers['x-client-id'] as string || 'client-default';
  const clientSession = clients.get(clientId);
  
  if (!clientSession) {
    console.log(`[Server] Client not found: ${clientId}`);
    stream.respond({ ':status': 404 });
    stream.end('Client not connected');
    return;
  }
  
  console.log(`[Server] Forwarding request to client: ${clientId}`);
  
  // Create a new stream to the client to forward the request
  const clientStream = (clientSession as http2.ClientHttp2Session).request({
    ':method': method,
    ':path': path,
    ...headers
  });
  
  // Forward request body to client
  stream.pipe(clientStream);
  
  // Forward response from client back to original requester
  clientStream.on('response', (responseHeaders: http2.IncomingHttpHeaders) => {
    console.log(`[Server] Got response from client, forwarding back`);
    stream.respond(responseHeaders);
  });
  
  clientStream.pipe(stream);
  
  clientStream.on('error', (err: Error) => {
    console.error('[Server] Client stream error:', err);
    if (!stream.headersSent) {
      stream.respond({ ':status': 502 });
      stream.end('Bad Gateway');
    }
  });
});

const PORT = 9001;

server.listen(PORT, () => {
  console.log(`[Server] HTTP/2 tunnel server listening on http://localhost:${PORT}`);
  console.log(`[Server] Clients can register at: http://localhost:${PORT}/register`);
});
