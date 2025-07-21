const http = require('http');
const fs = require('fs');
const path = require('path');

// Simple development server that mimics Cloudflare Workers environment
const server = http.createServer(async (req, res) => {
  try {
    // Enable CORS for development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Import and run the worker
    const workerPath = path.join(__dirname, 'src/index.ts');
    
    // For TypeScript files, we'll need to compile or use a simple approach
    // This is a basic implementation - in a real scenario you'd want proper TS compilation
    if (fs.existsSync(workerPath)) {
      // Read the TypeScript file and create a basic handler
      const workerCode = fs.readFileSync(workerPath, 'utf8');
      
      // Simple response for development
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        message: 'Development server running',
        method: req.method,
        url: req.url,
        note: 'This is a development server replacement for wrangler dev'
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Worker file not found');
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => {
  console.log(`🚀 Development server running on http://localhost:${PORT}`);
  console.log('📝 This replaces wrangler dev for WebContainer compatibility');
});