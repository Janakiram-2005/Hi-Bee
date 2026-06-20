"""
Module 3: Decoupled DOM-Verified Execution Queue
================================================
Eliminates race conditions between high-speed streaming tool-call emissions
from the cloud model and the slow rendering / focus cycle of the Windows OS.

Architecture
------------
  Producer (VertexLiveClient)
      │  enqueue_action(action_dict)
      ▼
  asyncio.Queue  (FIFO, unbounded)
      │
  Consumer (background_dom_executor)
      │  Pops one action at a time
      ├─ launch_application
      │     → subprocess.Popen('start <app>')
      │     → _wait_for_dom_focus(app_name, timeout=3.0)  ← WIN32 polling
      └─ type_text_in_focused_window
            → DOMDriver.type_text(text)

DOM Focus Verification
----------------------
Uses win32gui.GetWindowText(win32gui.GetForegroundWindow()) polling every 100 ms.
Only releases the execution lock when the target window title is confirmed as the
foreground window — or on timeout (which logs a warning but continues).

Error handling
--------------
Each action is wrapped in try/except. Failures log to stderr and return a control
flag WITHOUT crashing the queue consumer loop. The ambient session stays alive.
"""

import asyncio
import logging
import os
import subprocess
import time
from typing import TYPE_CHECKING, Any, Dict, Optional
from utils.status_reporter import report_status

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional win32gui import
# ---------------------------------------------------------------------------
try:
    import win32gui
    _WIN32GUI_AVAILABLE = True
except ImportError:
    _WIN32GUI_AVAILABLE = False
    logger.warning(
        "[VerifiedQueue] pywin32 not installed — DOM focus verification disabled. "
        "pip install pywin32>=306"
    )

# Avoid circular import; DOMDriver is injected at construction time
if TYPE_CHECKING:
    from os_dom_engine.dom_driver import DOMDriver


# ---------------------------------------------------------------------------
# Action type constants
# ---------------------------------------------------------------------------
ACTION_LAUNCH_APP   = "launch_application"
ACTION_TYPE_TEXT    = "type_text_in_focused_window"

# DOM polling configuration
FOCUS_POLL_INTERVAL_S = 0.10   # poll every 100 ms
DEFAULT_FOCUS_TIMEOUT = 3.0    # seconds to wait for window focus


# ---------------------------------------------------------------------------
# VerifiedQueue
# ---------------------------------------------------------------------------
class VerifiedQueue:
    """
    Asynchronous, DOM-verified action queue.

    Parameters
    ----------
    dom_driver : DOMDriver
        The native text/execution driver used to perform type_text actions.
    """

    def __init__(self, dom_driver: "DOMDriver"):
        self._dom_driver    = dom_driver
        self._queue:        Optional[asyncio.Queue] = None
        self._worker_task:  Optional[asyncio.Task]  = None
        self._loop:         Optional[asyncio.AbstractEventLoop] = None
        self._running       = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start_worker(self, loop: asyncio.AbstractEventLoop) -> None:
        """
        Start the background consumer coroutine inside the provided event loop.
        Call this from within an already-running async context or from the
        VertexLiveClient's event loop thread.

        Parameters
        ----------
        loop : asyncio.AbstractEventLoop
            The running event loop to schedule the worker task on.
        """
        self._loop  = loop
        self._queue = asyncio.Queue()
        self._running = True
        self._worker_task = loop.create_task(self._background_dom_executor())
        logger.info("[VerifiedQueue] Background DOM executor task started.")

    def stop_worker(self) -> None:
        """Cancel the consumer task gracefully."""
        self._running = False
        if self._worker_task and not self._worker_task.done():
            self._worker_task.cancel()
        logger.info("[VerifiedQueue] Background DOM executor stopped.")

    # ------------------------------------------------------------------
    # Producer API
    # ------------------------------------------------------------------

    def enqueue_action(self, action_name: str, action_args: Dict[str, Any]) -> None:
        """
        Thread-safe action enqueue.
        Called by VertexLiveClient from any thread when a tool call arrives.

        Parameters
        ----------
        action_name : str
            The tool name, e.g. 'launch_application'.
        action_args : dict
            The parsed argument dict from the model's function call.
        """
        action = {"name": action_name, "args": action_args}
        if self._loop and self._loop.is_running() and self._queue is not None:
            asyncio.run_coroutine_threadsafe(
                self._queue.put(action), self._loop
            )
            logger.info(
                "[VerifiedQueue] Enqueued action: %s(%s)", action_name, action_args
            )
            report_status("queue:enqueue", {"name": action_name, "args": action_args})
        else:
            logger.warning(
                "[VerifiedQueue] Cannot enqueue — event loop not running. "
                "Action dropped: %s(%s)", action_name, action_args
            )

    # ------------------------------------------------------------------
    # Consumer coroutine
    # ------------------------------------------------------------------

    async def _background_dom_executor(self) -> None:
        """
        Sequential action consumer. Pops one action at a time.
        Applies DOM focus verification between dependent actions.
        """
        logger.info("[VerifiedQueue] Consumer loop active.")
        while self._running:
            try:
                action: Dict[str, Any] = await self._queue.get()
                await self._dispatch_action(action)
                self._queue.task_done()
                report_status("queue:done")
            except asyncio.CancelledError:
                logger.info("[VerifiedQueue] Consumer loop cancelled.")
                return
            except Exception as exc:
                logger.error("[VerifiedQueue] Unhandled consumer error: %s", exc)
                # Do NOT exit the loop — keep the queue alive
                await asyncio.sleep(0.1)

    async def _dispatch_action(self, action: Dict[str, Any]) -> None:
        """Route a single action dict to the correct handler."""
        name = action.get("name", "")
        args = action.get("args", {})

        logger.info("[VerifiedQueue] Dispatching: %s(%s)", name, args)
        report_status("queue:dispatch", {"name": name, "args": args})

        if name == ACTION_LAUNCH_APP:
            await self._handle_launch_application(args)
        elif name == ACTION_TYPE_TEXT:
            await self._handle_type_text(args)
        else:
            logger.warning("[VerifiedQueue] Unknown action '%s' — skipped.", name)

    # ------------------------------------------------------------------
    # Action handlers
    # ------------------------------------------------------------------

    async def _handle_launch_application(self, args: dict) -> None:
        """
        Execute a Windows application launch and block until the target
        window reaches foreground focus (DOM-verified).
        """
        app_name = args.get("app_name", "").strip()
        if not app_name:
            logger.error("[VerifiedQueue] launch_application called with empty app_name.")
            return

        logger.info("[VerifiedQueue] Launching application: '%s'", app_name)
        try:
            # Use 'start' shell command for proper Windows app resolution
            # (handles both .exe names and registered app names like 'notepad')
            subprocess.Popen(
                f"start {app_name}",
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            logger.info("[VerifiedQueue] OS start command issued for '%s'.", app_name)
        except Exception as exc:
            logger.error("[VerifiedQueue] Failed to launch '%s': %s", app_name, exc)
            return

        # Block execution until the target window is confirmed in foreground
        success = await self._wait_for_dom_focus(app_name, timeout=DEFAULT_FOCUS_TIMEOUT)
        if success:
            logger.info("[VerifiedQueue] '%s' confirmed in foreground. Proceeding.", app_name)
        else:
            logger.warning(
                "[VerifiedQueue] '%s' did not reach foreground within %.1fs. "
                "Continuing anyway — subsequent actions may target wrong window.",
                app_name, DEFAULT_FOCUS_TIMEOUT,
            )
        report_status("dom:launch-done", {"app_name": app_name})

    async def _handle_type_text(self, args: dict) -> None:
        """
        Inject text into the currently focused window via the DOMDriver.
        """
        text = args.get("text_to_type", "")
        if not text:
            logger.warning("[VerifiedQueue] type_text_in_focused_window called with empty text.")
            return

        logger.info("[VerifiedQueue] Typing %d characters into focused window.", len(text))
        try:
            # Run the blocking DOMDriver call in a thread-pool executor to
            # avoid blocking the asyncio event loop during UI interaction
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,  # default thread-pool executor
                self._dom_driver.type_text,
                text,
            )
            if result.get("success"):
                logger.info(
                    "[VerifiedQueue] Text injected successfully via tier %d.",
                    result.get("tier_used", -1),
                )
                report_status("dom:type-done", {"tier_used": result.get("tier_used"), "text": text})
            else:
                logger.error(
                    "[VerifiedQueue] Text injection failed: %s", result.get("error")
                )
        except Exception as exc:
            logger.error("[VerifiedQueue] type_text dispatch error: %s", exc)

    # ------------------------------------------------------------------
    # DOM Focus Verification
    # ------------------------------------------------------------------

    async def _wait_for_dom_focus(self, app_name: str, timeout: float = DEFAULT_FOCUS_TIMEOUT) -> bool:
        """
        Poll win32gui.GetForegroundWindow() every 100 ms until the active window
        title contains app_name (case-insensitive) or timeout elapses.

        This is an async-friendly wrapper — it yields control to the event loop
        between each polling iteration via asyncio.sleep().

        Parameters
        ----------
        app_name : str
            Substring to match against the foreground window title.
        timeout : float
            Maximum seconds to wait.

        Returns
        -------
        bool
            True if focus was confirmed; False on timeout.
        """
        if not _WIN32GUI_AVAILABLE:
            logger.warning(
                "[VerifiedQueue] win32gui unavailable — skipping focus verification. "
                "Sleeping %.1fs as fixed delay fallback.", timeout / 2
            )
            await asyncio.sleep(timeout / 2)
            return False

        target_lower = app_name.lower()
        deadline     = time.monotonic() + timeout
        poll_count   = 0

        while time.monotonic() < deadline:
            try:
                hwnd  = win32gui.GetForegroundWindow()
                title = win32gui.GetWindowText(hwnd).lower()
                if target_lower in title:
                    logger.debug(
                        "[VerifiedQueue] Focus verified: foreground='%s' matched '%s' after %d polls.",
                        title, app_name, poll_count,
                    )
                    return True
            except Exception as exc:
                logger.debug("[VerifiedQueue] win32gui poll error: %s", exc)

            poll_count += 1
            await asyncio.sleep(FOCUS_POLL_INTERVAL_S)

        logger.warning(
            "[VerifiedQueue] Focus timeout for '%s' after %d polls (%.1fs).",
            app_name, poll_count, timeout,
        )
        return False
