import json
import logging
import threading
import urllib.request

logger = logging.getLogger(__name__)

STATUS_SERVER_URL = "http://127.0.0.1:8765/status"

def _post_status_worker(event: str, data: dict) -> None:
    try:
        req = urllib.request.Request(STATUS_SERVER_URL, method="POST")
        req.add_header("Content-Type", "application/json")
        payload = json.dumps({"event": event, "data": data}).encode("utf-8")
        # set timeout to 0.5s so we don't hang
        with urllib.request.urlopen(req, data=payload, timeout=0.5) as res:
            pass
    except Exception as e:
        # Silently ignore connection errors (e.g. if Electron is closed)
        logger.debug(f"[StatusReporter] Failed to send status event '{event}': {e}")

def report_status(event: str, data: dict = None) -> None:
    """
    Asynchronously post a status event to the local Electron status server.
    This is thread-safe and non-blocking.
    """
    if data is None:
        data = {}
    
    # Run the HTTP post in a background daemon thread
    t = threading.Thread(
        target=_post_status_worker,
        args=(event, data),
        daemon=True
    )
    t.start()
