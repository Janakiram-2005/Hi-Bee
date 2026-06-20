"""
tests/test_verified_queue.py
============================
Unit tests for Module 3: VerifiedQueue.

Tests cover:
- Action ordering: FIFO guarantee
- launch_application: subprocess invocation + focus wait
- type_text_in_focused_window: DOMDriver.type_text() delegation
- DOM focus polling: timeout and success paths
- Error isolation: a failing action does NOT crash the queue loop
- Thread-safe enqueue from a non-async thread

Mocking strategy:
- win32gui is mocked to simulate foreground window title changes
- DOMDriver.type_text is replaced with a MagicMock
- subprocess.Popen is patched to avoid real process spawning
"""

import asyncio
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, call, patch

import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

# Patch win32gui before importing verified_queue
_WIN32GUI_MOCK = MagicMock()
sys.modules.setdefault('win32gui', _WIN32GUI_MOCK)

from orchestrator.verified_queue import (
    VerifiedQueue,
    ACTION_LAUNCH_APP,
    ACTION_TYPE_TEXT,
    FOCUS_POLL_INTERVAL_S,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    """Execute a coroutine synchronously using a fresh event loop."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)   # make get_event_loop() / get_running_loop() resolve correctly
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


def _make_queue(type_text_result=None) -> tuple:
    """Create a VerifiedQueue with a mock DOMDriver."""
    dom_driver = MagicMock()
    dom_driver.type_text.return_value = (
        type_text_result or {"success": True, "tier_used": 3, "error": None}
    )
    queue = VerifiedQueue(dom_driver=dom_driver)
    return queue, dom_driver


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class TestEnqueue(unittest.TestCase):
    """Basic enqueue mechanics."""

    def test_enqueue_before_worker_logs_warning(self):
        """Enqueueing when the loop is not running should log a warning, not raise."""
        queue, _ = _make_queue()
        # _loop is None — should not raise, just log
        queue.enqueue_action(ACTION_LAUNCH_APP, {"app_name": "notepad"})

    def test_enqueue_in_running_loop(self):
        """Actions enqueued via thread-safe call should appear in the queue."""
        async def _inner():
            queue, _ = _make_queue()
            loop = asyncio.get_event_loop()
            queue._loop  = loop
            queue._queue = asyncio.Queue()
            queue.enqueue_action(ACTION_LAUNCH_APP, {"app_name": "calc"})
            # Give the run_coroutine_threadsafe a moment to schedule
            await asyncio.sleep(0.05)
            self.assertFalse(queue._queue.empty())
            item = await queue._queue.get()
            self.assertEqual(item["name"], ACTION_LAUNCH_APP)
            self.assertEqual(item["args"]["app_name"], "calc")

        _run(_inner())


class TestFIFOOrdering(unittest.TestCase):
    """Verify that actions are consumed in strict insertion order."""

    def test_fifo_order_preserved(self):
        async def _inner():
            queue, _ = _make_queue()
            loop = asyncio.get_event_loop()
            queue._loop  = loop
            queue._queue = asyncio.Queue()

            actions = [
                (ACTION_LAUNCH_APP,  {"app_name": "notepad"}),
                (ACTION_TYPE_TEXT,   {"text_to_type": "hello"}),
                (ACTION_TYPE_TEXT,   {"text_to_type": "world"}),
            ]
            for name, args in actions:
                await queue._queue.put({"name": name, "args": args})

            results = []
            for _ in actions:
                item = await queue._queue.get()
                results.append((item["name"], item["args"]))

            self.assertEqual(results, actions)

        _run(_inner())


class TestHandleLaunchApplication(unittest.TestCase):
    """Tests for the launch_application action handler."""

    @patch("orchestrator.verified_queue.subprocess.Popen")
    def test_subprocess_called_with_start_command(self, mock_popen):
        mock_popen.return_value = MagicMock(pid=1234)

        async def _inner():
            queue, _ = _make_queue()
            loop = asyncio.get_event_loop()
            queue._loop  = loop
            queue._queue = asyncio.Queue()

            # Patch the focus verification to return True immediately
            queue._wait_for_dom_focus = AsyncMock(return_value=True)

            await queue._handle_launch_application({"app_name": "notepad"})

            mock_popen.assert_called_once()
            call_args = mock_popen.call_args
            self.assertIn("notepad", call_args[0][0])

        _run(_inner())

    @patch("orchestrator.verified_queue.subprocess.Popen")
    def test_empty_app_name_skips_subprocess(self, mock_popen):
        async def _inner():
            queue, _ = _make_queue()
            await queue._handle_launch_application({"app_name": ""})
            mock_popen.assert_not_called()

        _run(_inner())

    @patch("orchestrator.verified_queue.subprocess.Popen")
    def test_focus_timeout_does_not_raise(self, mock_popen):
        """Even if focus verification times out, handler returns normally."""
        mock_popen.return_value = MagicMock(pid=99)

        async def _inner():
            queue, _ = _make_queue()
            queue._wait_for_dom_focus = AsyncMock(return_value=False)  # timeout
            # Should complete without raising
            await queue._handle_launch_application({"app_name": "nonexistent_app"})

        _run(_inner())


class TestHandleTypeText(unittest.TestCase):
    """Tests for the type_text_in_focused_window action handler."""

    def test_type_text_delegates_to_dom_driver(self):
        async def _inner():
            queue, dom_driver = _make_queue(
                type_text_result={"success": True, "tier_used": 2, "error": None}
            )
            loop = asyncio.get_event_loop()
            queue._loop = loop

            await queue._handle_type_text({"text_to_type": "Hello, world!"})

            dom_driver.type_text.assert_called_once_with("Hello, world!")

        _run(_inner())

    def test_empty_text_skips_dom_driver(self):
        async def _inner():
            queue, dom_driver = _make_queue()
            await queue._handle_type_text({"text_to_type": ""})
            dom_driver.type_text.assert_not_called()

        _run(_inner())

    def test_dom_driver_failure_does_not_raise(self):
        """DOMDriver returning failure should not propagate as an exception."""
        async def _inner():
            queue, dom_driver = _make_queue(
                type_text_result={"success": False, "tier_used": 3, "error": "SendInput failed"}
            )
            loop = asyncio.get_event_loop()
            queue._loop = loop
            # Should not raise
            await queue._handle_type_text({"text_to_type": "text"})

        _run(_inner())

    def test_dom_driver_exception_does_not_crash(self):
        """An unhandled exception in DOMDriver must be caught."""
        async def _inner():
            queue, dom_driver = _make_queue()
            dom_driver.type_text.side_effect = RuntimeError("Unexpected COM crash")
            loop = asyncio.get_event_loop()
            queue._loop = loop
            # Must not propagate
            await queue._handle_type_text({"text_to_type": "text"})

        _run(_inner())


class TestDOMFocusVerification(unittest.TestCase):
    """Tests for the _wait_for_dom_focus polling coroutine.

    win32gui IS installed on this machine, so we must patch the name as it
    exists in the verified_queue module's namespace, not rely on sys.modules.
    We also patch _WIN32GUI_AVAILABLE to ensure the polling branch executes.
    """

    @patch('orchestrator.verified_queue._WIN32GUI_AVAILABLE', True)
    @patch('orchestrator.verified_queue.win32gui')
    def test_focus_detected_immediately(self, mock_w32):
        """win32gui immediately returns target window — should return True quickly."""
        mock_w32.GetForegroundWindow.return_value = 12345
        mock_w32.GetWindowText.side_effect        = lambda hwnd: 'Notepad - Untitled'

        async def _inner():
            queue, _ = _make_queue()
            queue._loop = asyncio.get_running_loop()
            result = await queue._wait_for_dom_focus('notepad', timeout=2.0)
            self.assertTrue(result)

        _run(_inner())

    @patch('orchestrator.verified_queue._WIN32GUI_AVAILABLE', True)
    @patch('orchestrator.verified_queue.win32gui')
    def test_focus_detected_after_delay(self, mock_w32):
        """win32gui returns wrong title at first, then correct one after two polls."""
        call_count = {'n': 0}

        def _fake(hwnd):
            call_count['n'] += 1
            return 'Notepad' if call_count['n'] >= 3 else 'Desktop'

        mock_w32.GetForegroundWindow.return_value = 99
        mock_w32.GetWindowText.side_effect        = _fake

        async def _inner():
            queue, _ = _make_queue()
            queue._loop = asyncio.get_running_loop()
            result = await queue._wait_for_dom_focus('notepad', timeout=2.0)
            self.assertTrue(result)
            self.assertGreaterEqual(call_count['n'], 3)

        _run(_inner())

    @patch('orchestrator.verified_queue._WIN32GUI_AVAILABLE', True)
    @patch('orchestrator.verified_queue.win32gui')
    def test_focus_timeout_returns_false(self, mock_w32):
        """win32gui never returns target — should time out and return False."""
        mock_w32.GetForegroundWindow.return_value = 1
        mock_w32.GetWindowText.side_effect        = lambda hwnd: 'Desktop'

        async def _inner():
            queue, _ = _make_queue()
            queue._loop = asyncio.get_running_loop()
            result = await queue._wait_for_dom_focus('phantomapp', timeout=0.3)
            self.assertFalse(result)

        _run(_inner())


class TestQueueErrorIsolation(unittest.TestCase):
    """Verify that a crashing action does NOT terminate the consumer loop."""

    def test_unknown_action_is_skipped_gracefully(self):
        async def _inner():
            queue, _ = _make_queue()
            loop = asyncio.get_event_loop()
            queue._loop  = loop
            queue._queue = asyncio.Queue()

            # Inject an unknown action followed by a valid one
            await queue._queue.put({"name": "totally_unknown_action", "args": {}})
            await queue._queue.put({"name": ACTION_TYPE_TEXT, "args": {"text_to_type": "ok"}})

            # Process each action individually (simulates consumer)
            for _ in range(2):
                action = await queue._queue.get()
                await queue._dispatch_action(action)   # should not raise

        _run(_inner())


if __name__ == "__main__":
    unittest.main(verbosity=2)
