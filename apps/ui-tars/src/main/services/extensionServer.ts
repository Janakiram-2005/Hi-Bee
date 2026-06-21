import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '@main/logger';
import { windowManager } from './windowManager';

let wss: WebSocketServer | null = null;
let activeExtensionConn: WebSocket | null = null;
const PORT = 5001;

// Callbacks waiting for execution results
const pendingExecutions = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void }>();

export function startExtensionServer() {
  if (wss) return;

  wss = new WebSocketServer({ port: PORT });
  
  wss.on('connection', (ws) => {
    logger.info('[ExtensionServer] New connection attempt.');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        if (data.type === 'handshake' && data.source === 'extension') {
          logger.info('[ExtensionServer] Chrome extension handshake successful.');
          activeExtensionConn = ws;
          // Notify the renderer that the extension is installed and active
          windowManager.broadcast('extension:status', { installed: true });
        } 
        else if (data.type === 'execute-result') {
          const { scriptId, result, error } = data;
          const promise = pendingExecutions.get(scriptId);
          if (promise) {
            if (error) {
              promise.reject(new Error(error));
            } else {
              promise.resolve(result);
            }
            pendingExecutions.delete(scriptId);
          }
        }
      } catch (err) {
        logger.warn('[ExtensionServer] Error processing message:', err);
      }
    });

    ws.on('close', () => {
      if (activeExtensionConn === ws) {
        logger.info('[ExtensionServer] Chrome extension disconnected.');
        activeExtensionConn = null;
        windowManager.broadcast('extension:status', { installed: false });
      }
    });
  });

  wss.on('listening', () => {
    logger.info(`[ExtensionServer] Listening on ws://localhost:${PORT}`);
  });
}

export function stopExtensionServer() {
  if (wss) {
    wss.close();
    wss = null;
    activeExtensionConn = null;
    logger.info('[ExtensionServer] Extension server stopped.');
  }
}

export function isExtensionInstalled(): boolean {
  return activeExtensionConn !== null && activeExtensionConn.readyState === WebSocket.OPEN;
}

export async function sendExtensionCommand(code: string): Promise<any> {
  if (!isExtensionInstalled() || !activeExtensionConn) {
    throw new Error('Extension is not connected.');
  }
  
  const scriptId = Math.random().toString(36).substring(2, 15);
  
  return new Promise((resolve, reject) => {
    // Timeout after 10 seconds
    const timeout = setTimeout(() => {
      pendingExecutions.delete(scriptId);
      reject(new Error('Extension command timed out'));
    }, 10000);
    
    pendingExecutions.set(scriptId, {
      resolve: (val) => {
        clearTimeout(timeout);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    });
    
    activeExtensionConn!.send(JSON.stringify({ type: 'execute-script', scriptId, code }));
  });
}
