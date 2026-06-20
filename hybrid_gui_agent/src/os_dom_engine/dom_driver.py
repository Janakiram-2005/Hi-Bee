"""
Module 4: Native Interop DOM Driver Wrapper
===========================================
Provides robust, cursor-free programmatic text and application launch handling,
serving as the final execution target for actions emitted by the VerifiedQueue.

Text injection hierarchy (tried in order; first success wins)
-------------------------------------------------------------
  Tier 1  UIAutomation ValuePattern.SetValue()
            Uses comtypes to talk directly to the UIA COM interface of the focused
            window's active element. Works reliably for standard text boxes.

  Tier 2  pywinauto type_keys()
            Wraps Win32 SendInput at the Python level. Handles most standard
            controls and bypasses the physical mouse cursor entirely.

  Tier 3  ctypes SendInput (scan-code injection)
            Lowest-level fallback. Synthesises raw keyboard scan-code events
            via user32.SendInput(), effective even when UIA and pywinauto fail.

All tiers are wrapped in try/except blocks. Failures are logged to telemetry
and control is returned gracefully to the orchestrator. The ambient session
NEVER crashes due to a UI interaction error.

Application launch
------------------
  DOMDriver.launch_app(app_name) delegates to subprocess and returns the PID.
  Ownership of the "wait for focus" concern belongs to the VerifiedQueue, not here.
"""

import ctypes
import logging
import os
import subprocess
import time
from ctypes import wintypes
from typing import Dict, Optional, Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional tier imports
# ---------------------------------------------------------------------------
try:
    import comtypes
    import comtypes.client
    _COMTYPES_AVAILABLE = True
except ImportError:
    _COMTYPES_AVAILABLE = False
    logger.info("[DOMDriver] comtypes not installed — Tier 1 (UIA ValuePattern) disabled.")

try:
    import pywinauto
    from pywinauto.application import Application as _PWApp
    _PYWINAUTO_AVAILABLE = True
except ImportError:
    _PYWINAUTO_AVAILABLE = False
    logger.info("[DOMDriver] pywinauto not installed — Tier 2 (type_keys) disabled.")

# ---------------------------------------------------------------------------
# Win32 SendInput structures (Tier 3)
# ---------------------------------------------------------------------------

# INPUT type constants
INPUT_KEYBOARD = 1

# KEYEVENTF flags
KEYEVENTF_KEYDOWN   = 0x0000
KEYEVENTF_KEYUP     = 0x0002
KEYEVENTF_UNICODE   = 0x0004
KEYEVENTF_SCANCODE  = 0x0008

class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk",         wintypes.WORD),
        ("wScan",       wintypes.WORD),
        ("dwFlags",     wintypes.DWORD),
        ("time",        wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]

class _INPUT_UNION(ctypes.Union):
    _fields_ = [("ki", _KEYBDINPUT), ("padding", ctypes.c_byte * 28)]

class _INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("_input", _INPUT_UNION)]


# ---------------------------------------------------------------------------
# UIA COM helpers (Tier 1)
# ---------------------------------------------------------------------------

_UIA_IUIA_IID         = "{FF48DBA4-60EF-4201-AA87-54103EEF594E}"  # IUIAutomation
UIA_ValuePatternId    = 10002

def _uia_get_focused_element_value_pattern():
    """
    Return (element, value_pattern_ptr) for the currently focused UIA element,
    or (None, None) if unavailable.
    """
    if not _COMTYPES_AVAILABLE:
        return None, None
    try:
        uia = comtypes.client.CreateObject(
            "{FF48DBA4-60EF-4201-AA87-54103EEF594E}",
            interface=comtypes.gen.UIAutomationClient.IUIAutomation,
        )
        focused = uia.GetFocusedElement()
        if focused is None:
            return None, None
        try:
            pattern = focused.GetCurrentPattern(UIA_ValuePatternId)
            if pattern:
                value_pattern = pattern.QueryInterface(
                    comtypes.gen.UIAutomationClient.IUIAutomationValuePattern
                )
                return focused, value_pattern
        except Exception:
            pass
        return focused, None
    except Exception as exc:
        logger.debug("[DOMDriver] UIA COM error: %s", exc)
        return None, None


# ---------------------------------------------------------------------------
# DOMDriver
# ---------------------------------------------------------------------------
class DOMDriver:
    """
    Native OS text injection and application execution wrapper.
    All public methods return a structured result dict:
      {
        "success":   bool,
        "tier_used": int,   # 1 / 2 / 3 / -1 (not attempted / all failed)
        "error":     str | None,
      }
    """

    # ------------------------------------------------------------------
    # Text injection — public API
    # ------------------------------------------------------------------

    def type_text(self, text: str) -> Dict[str, Any]:
        """
        Inject `text` into the currently focused OS window.
        Attempts Tier 1 → 2 → 3 in sequence.

        Parameters
        ----------
        text : str
            The string to type. Unicode is supported for all tiers.

        Returns
        -------
        dict with keys: success, tier_used, error
        """
        if not text:
            return {"success": False, "tier_used": -1, "error": "Empty text provided."}

        # ---- Tier 1: UIA ValuePattern.SetValue() ----------------------
        result = self._tier1_uia_set_value(text)
        if result["success"]:
            return result

        # ---- Tier 2: pywinauto type_keys() ----------------------------
        result = self._tier2_pywinauto_type_keys(text)
        if result["success"]:
            return result

        # ---- Tier 3: ctypes SendInput (Unicode scan codes) ------------
        result = self._tier3_sendinput_unicode(text)
        return result

    # ------------------------------------------------------------------
    # Application launch — public API
    # ------------------------------------------------------------------

    def launch_app(self, app_name: str) -> Dict[str, Any]:
        """
        Launch a Windows application by name.
        Uses 'start' shell command for proper system app resolution.

        Returns
        -------
        dict with keys: success, pid, error
        """
        try:
            proc = subprocess.Popen(
                f"start {app_name}",
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            logger.info("[DOMDriver] Launched '%s' (shell PID: %d).", app_name, proc.pid)
            return {"success": True, "pid": proc.pid, "error": None}
        except Exception as exc:
            logger.error("[DOMDriver] launch_app failed for '%s': %s", app_name, exc)
            return {"success": False, "pid": -1, "error": str(exc)}

    # ------------------------------------------------------------------
    # Tier 1: UIA ValuePattern.SetValue()
    # ------------------------------------------------------------------

    def _tier1_uia_set_value(self, text: str) -> Dict[str, Any]:
        """
        Directly set the value of the focused UIA element via IValuePattern.
        Most reliable for standard text fields; bypasses physical keyboard entirely.
        """
        if not _COMTYPES_AVAILABLE:
            return {"success": False, "tier_used": 1, "error": "comtypes not installed."}

        try:
            # Lazily generate UIA COM type stubs on first call
            _ensure_uia_stubs()

            _, value_pattern = _uia_get_focused_element_value_pattern()
            if value_pattern is None:
                return {
                    "success": False,
                    "tier_used": 1,
                    "error": "Focused element does not support ValuePattern.",
                }

            value_pattern.SetValue(text)
            logger.info("[DOMDriver] Tier 1 (UIA ValuePattern) succeeded.")
            return {"success": True, "tier_used": 1, "error": None}

        except Exception as exc:
            logger.warning("[DOMDriver] Tier 1 (UIA ValuePattern) failed: %s", exc)
            return {"success": False, "tier_used": 1, "error": str(exc)}

    # ------------------------------------------------------------------
    # Tier 2: pywinauto type_keys()
    # ------------------------------------------------------------------

    def _tier2_pywinauto_type_keys(self, text: str) -> Dict[str, Any]:
        """
        Use pywinauto's type_keys() on the currently focused desktop element.
        Wraps Win32 SendInput with friendly key sequence handling.
        """
        if not _PYWINAUTO_AVAILABLE:
            return {"success": False, "tier_used": 2, "error": "pywinauto not installed."}

        try:
            import pywinauto.keyboard as pw_kb

            # type_keys sends text via SendInput; with_spaces=True preserves whitespace
            pw_kb.send_keys(text, with_spaces=True, with_newlines=True)
            logger.info("[DOMDriver] Tier 2 (pywinauto send_keys) succeeded.")
            return {"success": True, "tier_used": 2, "error": None}

        except Exception as exc:
            logger.warning("[DOMDriver] Tier 2 (pywinauto) failed: %s", exc)
            return {"success": False, "tier_used": 2, "error": str(exc)}

    # ------------------------------------------------------------------
    # Tier 3: ctypes SendInput (Unicode key events)
    # ------------------------------------------------------------------

    def _tier3_sendinput_unicode(self, text: str) -> Dict[str, Any]:
        """
        Synthesise Unicode key-down / key-up INPUT events via user32.SendInput().
        Works for virtually all Windows applications, including those that ignore
        WM_CHAR or block standard key simulation libraries.
        """
        try:
            inputs = []
            for char in text:
                code_point = ord(char)

                # Build key-down
                ki_down = _KEYBDINPUT(
                    wVk=0,
                    wScan=code_point,
                    dwFlags=KEYEVENTF_UNICODE,
                    time=0,
                    dwExtraInfo=None,
                )
                inp_down = _INPUT(
                    type=INPUT_KEYBOARD,
                    _input=_INPUT_UNION(ki=ki_down),
                )

                # Build key-up
                ki_up = _KEYBDINPUT(
                    wVk=0,
                    wScan=code_point,
                    dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time=0,
                    dwExtraInfo=None,
                )
                inp_up = _INPUT(
                    type=INPUT_KEYBOARD,
                    _input=_INPUT_UNION(ki=ki_up),
                )

                inputs.extend([inp_down, inp_up])

            # Send all inputs in a single batch call
            n_inputs = len(inputs)
            input_array = (_INPUT * n_inputs)(*inputs)
            sent = ctypes.windll.user32.SendInput(
                n_inputs,
                input_array,
                ctypes.sizeof(_INPUT),
            )

            if sent == n_inputs:
                logger.info(
                    "[DOMDriver] Tier 3 (SendInput Unicode) succeeded: %d events sent.", sent
                )
                return {"success": True, "tier_used": 3, "error": None}
            else:
                err_code = ctypes.GetLastError()
                raise OSError(
                    f"SendInput sent {sent}/{n_inputs} events. LastError={err_code}"
                )

        except Exception as exc:
            logger.error("[DOMDriver] Tier 3 (SendInput) failed: %s", exc)
            return {
                "success": False,
                "tier_used": 3,
                "error": str(exc),
            }


# ---------------------------------------------------------------------------
# UIA COM stub lazy initializer
# ---------------------------------------------------------------------------

_UIA_STUBS_GENERATED = False

def _ensure_uia_stubs() -> None:
    """
    Generate comtypes UIA type stubs once per process.
    This is deferred to first use to avoid slowing down module import.
    """
    global _UIA_STUBS_GENERATED
    if _UIA_STUBS_GENERATED:
        return
    if not _COMTYPES_AVAILABLE:
        return
    try:
        comtypes.client.GetModule("UIAutomationCore.dll")
        _UIA_STUBS_GENERATED = True
        logger.debug("[DOMDriver] UIAutomationCore COM stubs generated.")
    except Exception as exc:
        logger.warning("[DOMDriver] Could not generate UIA stubs: %s", exc)
