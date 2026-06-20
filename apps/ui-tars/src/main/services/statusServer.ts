import http from 'http';
import { logger } from '@main/logger';
import { windowManager } from './windowManager';

let server: http.Server | null = null;
const PORT = 8765;

export function startStatusServer() {
  if (server) return;

  server = http.createServer((req, res) => {
    // Allow CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/status') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (payload && typeof payload.event === 'string') {
            logger.debug(`[StatusServer] Received event: ${payload.event}`, payload.data);
            windowManager.broadcast('hibee:pipeline-status', {
              event: payload.event,
              data: payload.data || {},
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid payload structure' }));
          }
        } catch (err: any) {
          logger.warn('[StatusServer] Failed to parse status payload:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    logger.info(`[StatusServer] Local status server listening on http://127.0.0.1:${PORT}`);
  });

  server.on('error', (err) => {
    logger.error('[StatusServer] Server error:', err);
  });
}

export function stopStatusServer() {
  if (server) {
    server.close();
    server = null;
    logger.info('[StatusServer] Status server stopped.');
  }
}
