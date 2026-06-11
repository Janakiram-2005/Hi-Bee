import os
import sys
import time
import ctypes
import threading
import cv2
import subprocess
import json
from os_dom_engine.win32_api import get_window_rect, focus_window
from os_dom_engine import ProcessRouter
from orchestrator.fallback_router import FallbackRouter
from vision_engine import CoordinateMapper
from utils import BenchmarkTool
from utils.screen_capture import ScreenCapture
from orchestrator.vlm_client import VLMClient, clean_id_token

class NativeBridge:
    def __init__(self, parser_exe_path: str, tree_broker):
        self.parser_exe_path = parser_exe_path
        self.tree_broker = tree_broker

    def try_headless_invoke(self, user_command: str) -> bool:
        try:
            # 1. Get the current active window handle
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            if not hwnd:
                return False

            # 2. Retrieve automation tree for this window
            automation_tree = self.tree_broker.get_live_tree(hwnd)
            if not automation_tree:
                return False

            # 3. Find matched element by Name or AutomationId substring in user_command
            cmd_lower = user_command.lower()
            best_element = None
            for el in automation_tree:
                el_name = el.get("name")
                el_id = el.get("id")
                
                # Check for name match
                if el_name and len(el_name) > 1:
                    if el_name.lower() in cmd_lower:
                        if not best_element or len(el_name) > len(best_element.get("name", "")):
                            best_element = el
                            
                # Check for ID match
                if el_id and len(el_id) > 1:
                    if el_id.lower() in cmd_lower:
                        if not best_element or len(el_id) > len(best_element.get("id", "")):
                            best_element = el

            if not best_element:
                print(f"[NativeBridge] No matching element found in tree for command: '{user_command}'")
                return False

            target_identifier = best_element.get("id") or best_element.get("name")
            if not target_identifier:
                return False

            print(f"[NativeBridge] Found matching element '{target_identifier}' inside application. Initiating headless invoke...")

            # 4. Invoke headless action on UIAParser
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0 # SW_HIDE

            cmd = [self.parser_exe_path, "headless_invoke", target_identifier]
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                startupinfo=startupinfo
            )
            stdout, stderr = proc.communicate(timeout=2.0)
            
            if proc.returncode == 0:
                print(f"[NativeBridge] Headless invoke succeeded: {stdout.strip()}")
                return True
            print(f"[NativeBridge] Headless invoke returned non-zero. Stdout: {stdout.strip()}. Stderr: {stderr.strip()}")
        except Exception as e:
            print(f"[NativeBridge] Exception in try_headless_invoke: {e}")
            
        return False

class AgentState:
    IDLE = "IDLE"
    CAPTURING = "CAPTURING"
    SCANNING = "SCANNING"
    DECIDING = "DECIDING"
    RESOLVING = "RESOLVING"
    EXECUTING = "EXECUTING"
    PAUSED_LOCKED = "PAUSED_LOCKED"

class AgentStateMachine:
    def __init__(self, parser_exe_path: str = None, models_dir: str = None):
        self.state = AgentState.IDLE
        self.router = FallbackRouter(parser_exe_path, models_dir)
        self.vlm_client = VLMClient()
        self.benchmark = BenchmarkTool()
        self.current_hwnd = None
        self.cached_rect_at_capture = None
        self._lock = threading.Lock()
        self.process_router = ProcessRouter()
        self.tree_broker = self.router.broker
        self.native_bridge = NativeBridge(self.tree_broker.parser_exe_path, self.tree_broker)
        
    def _check_lock_screen(self) -> bool:
        """Check if the workstation is locked or showing a secure login screen (foreground window is 0)."""
        foreground = ctypes.windll.user32.GetForegroundWindow()
        if foreground == 0:
            with self._lock:
                self.state = AgentState.PAUSED_LOCKED
            print("[LockSafety] Workstation lock detected! Halting all automation paths.")
            
            # Broadcast monitor wake command: WM_SYSCOMMAND (0x0112), SC_MONITORPOWER (0xF170)
            print("[LockSafety] Broadcast monitor wake signal to illuminate screen...")
            ctypes.windll.user32.SendMessageW(0xFFFF, 0x0112, 0xF170, -1)
            return True
        return False

    def run_step_async(self, hwnd: int, command: str, timeout: float = 5.0) -> dict:
        """
        Spawns the execution pipeline inside a background worker thread.
        Main supervisor thread enforces a strict timeout to prevent hangs.
        """
        result = {"success": False, "error": None, "metrics": {}}
        
        def worker():
            try:
                res = self.execute_pipeline_step(hwnd, command)
                result.update(res)
            except Exception as e:
                result["error"] = str(e)
                result["success"] = False

        worker_thread = threading.Thread(target=worker)
        worker_thread.daemon = True
        worker_thread.start()

        # Monitor thread execution with timeout
        worker_thread.join(timeout=timeout)
        if worker_thread.is_alive():
            print(f"[Supervisor] Thread deadlock or timeout (>{timeout}s) detected. Killing worker thread context.")
            # Since Python cannot force-terminate threads, we flag the agent state to IDLE and return
            with self._lock:
                self.state = AgentState.IDLE
            return {"success": False, "error": f"Pipeline execution timed out after {timeout} seconds", "metrics": {}}

        return result

    def execute_pipeline_step(self, hwnd: int, command: str) -> dict:
        """
        Main execution pipeline loop optimized with a 3-Tier Cortana Short-Circuit Architecture.
        """
        self.benchmark = BenchmarkTool()
        self.current_hwnd = hwnd

        # Lock screen safety check
        if self._check_lock_screen():
            return {"success": False, "error": "Workstation is locked. Resuming halted.", "metrics": {}}

        # TIER 1: Check the Cortana Short-Circuit Registry
        self.benchmark.start_phase("Tier 1 OS Short-Circuit")
        try:
            if self.process_router.try_deterministic_execution(command):
                self.benchmark.end_phase("Tier 1 OS Short-Circuit")
                print("Tier 1 Success: Command executed instantly via OS Protocol.")
                return {
                    "success": True,
                    "target_coordinate": None,
                    "metrics": self.benchmark.get_metrics(),
                    "tier": 1
                }
        except Exception as e:
            print(f"[Tier 1 Error] {e}")
        self.benchmark.end_phase("Tier 1 OS Short-Circuit")

        # TIER 2: Extract the UI Automation Tree and attempt memory execution
        self.benchmark.start_phase("Tier 2 Memory Invocation")
        try:
            automation_tree = self.tree_broker.get_live_tree(hwnd)
            if automation_tree and self.native_bridge.try_headless_invoke(command):
                self.benchmark.end_phase("Tier 2 Memory Invocation")
                print("Tier 2 Success: Element clicked directly in memory without moving cursor.")
                return {
                    "success": True,
                    "target_coordinate": None,
                    "metrics": self.benchmark.get_metrics(),
                    "tier": 2
                }
        except Exception as e:
            print(f"[Tier 2 Error] {e}")
        self.benchmark.end_phase("Tier 2 Memory Invocation")

        # TIER 3: Fallback to full vision reasoning if programmatic avenues are blocked
        print("Programmatic tracks unhandled. Activating Tier 3 Vision Pipeline...")
        return self.activate_full_vision_agent_loop(hwnd, command)

    def execute_user_intent(self, user_command: str):
        # TIER 1: Check the Cortana Short-Circuit Registry
        if self.process_router.try_deterministic_execution(user_command):
            print("Tier 1 Success: Command executed instantly via OS Protocol.")
            return

        # TIER 2: Extract the UI Automation Tree and attempt memory execution
        automation_tree = self.tree_broker.get_live_tree(self.current_hwnd)
        if automation_tree and self.native_bridge.try_headless_invoke(user_command):
            print("Tier 2 Success: Element clicked directly in memory without moving cursor.")
            return

        # TIER 3: Fallback to full vision reasoning if programmatic avenues are blocked
        print("Programmatic tracks unhandled. Activating Tier 3 Vision Pipeline...")
        self.activate_full_vision_agent_loop(self.current_hwnd, user_command)

    def activate_full_vision_agent_loop(self, hwnd: int, command: str) -> dict:
        """
        Original visual fallback pipeline when short-circuit paths are not applicable.
        """
        # 2. Capture Phase
        with self._lock:
            self.state = AgentState.CAPTURING
            
        self.benchmark.start_phase("Screen Capture")
        # Cache coordinates the absolute millisecond capture is initiated
        self.cached_rect_at_capture = get_window_rect(hwnd)
        if not self.cached_rect_at_capture:
            return {"success": False, "error": "Failed to get target window bounds at capture.", "metrics": {}}
            
        try:
            capture = ScreenCapture()
            screenshot_img = capture.capture_window(hwnd)
            _, buf = cv2.imencode('.png', screenshot_img)
            screenshot_bytes = buf.tobytes()
        except Exception as e:
            self.benchmark.end_phase("Screen Capture")
            return {"success": False, "error": f"Screen capture failed: {e}", "metrics": {}}
            
        self.benchmark.end_phase("Screen Capture")

        # 3. DOM / Visual Layout Scan Phase
        with self._lock:
            self.state = AgentState.SCANNING
            
        self.benchmark.start_phase("OS DOM & Visual Scan")
        # Automatically toggles between DOM and visual fallback routes
        layout = self.router.get_ui_layout(hwnd)
        self.benchmark.end_phase("OS DOM & Visual Scan")

        if not layout or not layout.get("elements"):
            return {"success": False, "error": "Layout scan returned empty elements.", "metrics": {}}

        # Build active mapping dictionary from elements layout
        active_map = {}
        if layout["mode"] == "dom":
            for el in layout["elements"]:
                x, y, w, h = el["rect"]
                cx = x + w // 2
                cy = y + h // 2
                if el.get("id"):
                    active_map[clean_id_token(el["id"]).lower()] = (cx, cy)
                if el.get("name"):
                    active_map[clean_id_token(el["name"]).lower()] = (cx, cy)
        else:
            index_map = layout["index_map"]
            meta = layout["meta"]
            for idx_str, det in index_map.items():
                x, y, w, h = det["box"]
                cx_local = x + w // 2
                cy_local = y + h // 2
                x_global, y_global = CoordinateMapper.restore_coordinate(cx_local, cy_local, meta)
                active_map[idx_str] = (x_global, y_global)

        if not active_map:
            return {"success": False, "error": "No elements resolved to coordinate mapping.", "metrics": {}}

        # 4. VLM Decision Phase (Real-time Streaming)
        with self._lock:
            self.state = AgentState.DECIDING
            
        self.benchmark.start_phase("VLM Decision")
        
        ttft_ms = 0.0
        def on_ttft(duration_ms):
            nonlocal ttft_ms
            ttft_ms = duration_ms
            # Record Time-To-First-Token in telemetry metrics
            self.benchmark.phases["Time-to-First-Token"] = {
                "start": 0,
                "end": int(duration_ms * 1000000.0) # convert to ns
            }

        try:
            target_id = self.vlm_client.generate_target_id(
                hwnd=hwnd,
                command=command,
                layout=layout,
                screenshot_bytes=screenshot_bytes,
                active_map=active_map,
                on_ttft_callback=on_ttft
            )
        except Exception as e:
            self.benchmark.end_phase("VLM Decision")
            return {"success": False, "error": f"VLM streaming failed: {e}", "metrics": self.benchmark.get_metrics()}

        self.benchmark.end_phase("VLM Decision")

        # 5. Coordinate Mapping & Scale Restoration
        with self._lock:
            self.state = AgentState.RESOLVING
            
        self.benchmark.start_phase("Coordinate Restoration")
        
        if target_id not in active_map:
            self.benchmark.end_phase("Coordinate Restoration")
            return {"success": False, "error": f"VLM returned ID '{target_id}' which is not in active coordinate map.", "metrics": self.benchmark.get_metrics()}
            
        x_target, y_target = active_map[target_id]
            
        self.benchmark.end_phase("Coordinate Restoration")

        # 6. Pre-Click Moving-Target Race Condition Check
        with self._lock:
            self.state = AgentState.EXECUTING
            
        self.benchmark.start_phase("Win32 Mouse Injection")
        
        current_rect = get_window_rect(hwnd)
        if not current_rect:
            return {"success": False, "error": "Target window was closed during decision phase.", "metrics": {}}
            
        # Compare window boundaries drift
        c_left, c_top, c_w, c_h = self.cached_rect_at_capture
        n_left, n_top, n_w, n_h = current_rect
        
        dx = abs(n_left - c_left)
        dy = abs(n_top - c_top)
        dw = abs(n_w - c_w)
        dh = abs(n_h - c_h)
        
        # Abort if layout coordinates shifted beyond strict 3-pixel tolerance threshold
        if dx > 3 or dy > 3 or dw > 3 or dh > 3:
            print(f"[RaceCondition] Window drifted by ({dx}, {dy}) px during inference. ABORTING CLICK.")
            return {
                "success": False, 
                "error": f"Window coordinates mutated by {max(dx, dy)}px (exceeding 3px tolerance limit). Click aborted.",
                "metrics": self.benchmark.get_metrics()
            }
            
        # Focus window before clicking
        focus_window(hwnd)
        time.sleep(0.1)
        
        # Inject click coordinates using Win32 API
        ctypes.windll.user32.SetCursorPos(x_target, y_target)
        ctypes.windll.user32.mouse_event(0x0002, 0, 0, 0, 0) # LEFTDOWN
        time.sleep(0.05)
        ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0) # LEFTUP
        
        self.benchmark.end_phase("Win32 Mouse Injection")

        with self._lock:
            self.state = AgentState.IDLE

        # Print latency profiling dashboard to stdout
        self.benchmark.print_dashboard()
        
        return {
            "success": True,
            "target_coordinate": [x_target, y_target],
            "metrics": self.benchmark.get_metrics()
        }
