let ws = null;
const RECONNECT_DELAY = 3000;

function connectWebSocket() {
  console.log("Connecting to WebSocket on ws://localhost:5001...");
  ws = new WebSocket('ws://localhost:5001');

  ws.onopen = () => {
    console.log("WebSocket connected.");
    // Register the extension with the gateway
    ws.send(JSON.stringify({ type: 'handshake', source: 'extension' }));
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'execute-script') {
        const { scriptId, code } = data;
        
        // Find the active tab
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) {
          ws.send(JSON.stringify({ type: 'execute-result', scriptId, error: 'No active tab found' }));
          return;
        }
        
        const activeTabId = tabs[0].id;
        
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            func: new Function(code),
          });
          
          ws.send(JSON.stringify({ 
            type: 'execute-result', 
            scriptId, 
            result: results[0]?.result 
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'execute-result', scriptId, error: err.message }));
        }
      }
    } catch (err) {
      console.error("Failed to parse message", err);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket connection closed. Retrying in " + RECONNECT_DELAY + "ms");
    ws = null;
    setTimeout(connectWebSocket, RECONNECT_DELAY);
  };

  ws.onerror = (error) => {
    console.error("WebSocket Error:", error);
    if (ws) {
      ws.close();
    }
  };
}

// Start connection immediately
connectWebSocket();

// Also attempt reconnection if service worker wakes up from sleep
chrome.runtime.onStartup.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }
});
