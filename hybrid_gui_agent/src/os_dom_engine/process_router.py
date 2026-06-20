import time
import subprocess
import re
import webbrowser
import ctypes
from .win32_api import enumerate_windows, focus_window, get_window_rect

class CortanaShortCircuitRouter:
    @staticmethod
    def try_deterministic_execution(query: str) -> bool:
        """
        Scan raw user command for deterministic intents.
        - Window Management (close, minimize)
        - Windows Settings deep-links
        - Common applications (notepad, calculator)
        - Web domains
        """
        try:
            q_lower = query.lower().strip()
            
            # 1. Web navigation deep-link extractor
            web_match = re.search(r'\b(?:go\s+to|open\s+website)\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\S*)', q_lower)
            if web_match:
                domain = web_match.group(1).strip()
                if not domain.startswith(('http://', 'https://')):
                    url = 'https://' + domain
                else:
                    url = domain
                print(f"[CortanaShortCircuitRouter] Web navigation match. Opening browser to: {url}")
                webbrowser.open(url)
                return True

            # 2. Window Management (Minimize, Close)
            if re.search(r'\b(?:close|quit|exit)\b', q_lower):
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                if hwnd:
                    print(f"[CortanaShortCircuitRouter] Window management match: Close. Sending WM_CLOSE to HWND {hwnd}")
                    ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0) # WM_CLOSE
                    return True
                    
            if re.search(r'\b(?:minimize|minimise|hide)\b', q_lower):
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                if hwnd:
                    print(f"[CortanaShortCircuitRouter] Window management match: Minimize. Sending SW_MINIMIZE to HWND {hwnd}")
                    ctypes.windll.user32.ShowWindow(hwnd, 6) # SW_MINIMIZE = 6
                    return True

            # 3. Internal dictionary of common user intents mapped to Windows Shell commands or URI Deep-links
            mappings = {
                "open settings": "start ms-settings:",
                "launch settings": "start ms-settings:",
                "wifi settings": "start ms-settings:network-wifi",
                "network settings": "start ms-settings:network-wifi",
                "windows update": "start ms-settings:windowsupdate",
                "open calculator": "calc",
                "launch calculator": "calc",
                "open notepad": "notepad"
            }

            for key, cmd in mappings.items():
                pattern = rf"\b{re.escape(key)}\b"
                if re.search(pattern, q_lower):
                    print(f"[CortanaShortCircuitRouter] Intent match for '{key}' -> command: '{cmd}'. Executing via system shell...")
                    subprocess.Popen(cmd, shell=True)
                    return True

        except Exception as e:
            print(f"[CortanaShortCircuitRouter] Exception during deterministic check: {e}")
            
        return False


class ProcessRouter(CortanaShortCircuitRouter):
    @staticmethod
    def find_and_focus_app(query: str) -> int:
        """
        Scan active top-level windows for process names or titles matching the query.
        If found, restore if minimized, bring to focus, and return its HWND.
        """
        windows = enumerate_windows()
        q_lower = query.lower()
        
        for win in windows:
            title = win["title"].lower()
            proc = win["process_name"].lower()
            
            # Match query against process name (e.g. notepad.exe) or window title (e.g. *Untitled - Notepad)
            if q_lower in proc or q_lower in title:
                hwnd = win["hwnd"]
                rect = get_window_rect(hwnd)
                if not rect or rect[2] <= 50 or rect[3] <= 50:
                    continue
                
                print(f"[ProcessRouter] Found matching window: '{win['title']}' (Process: {win['process_name']}) [HWND: {hwnd}]")
                
                if focus_window(hwnd):
                    # Give the OS a short window of time to animate focus transition
                    time.sleep(0.3)
                    return hwnd
        return None

    @staticmethod
    def launch_or_focus(query: str, launch_command: list) -> int:
        """
        Locate and focus an existing window matching the query.
        If no matching window exists, spawn the application, wait for its initialization, 
        and return the newly created HWND.
        """
        hwnd = ProcessRouter.find_and_focus_app(query)
        if hwnd:
            print(f"[ProcessRouter] Intercepted launch. Application '{query}' is already running. Focused HWND {hwnd}.")
            return hwnd
            
        print(f"[ProcessRouter] Application '{query}' not found. Launching new process: {launch_command}")
        
        # Start the subprocess
        subprocess.Popen(launch_command)
        
        # Poll for the window to appear and return its window handle
        time.sleep(1.0) # Wait for window creation
        for attempt in range(10):
            hwnd = ProcessRouter.find_active_hwnd_for_query(query)
            if hwnd:
                print(f"[ProcessRouter] Successfully retrieved new window handle: [HWND: {hwnd}] after {1.0 + attempt*0.5:.1f}s.")
                return hwnd
            time.sleep(0.5)
            
        print(f"[ProcessRouter] WARNING: Launched process but could not capture a valid HWND matching '{query}'.")
        return None

    @staticmethod
    def find_active_hwnd_for_query(query: str) -> int:
        """Find a window handle matching a query without focusing it."""
        windows = enumerate_windows()
        q_lower = query.lower()
        for win in windows:
            title = win["title"].lower()
            proc = win["process_name"].lower()
            if q_lower in proc or q_lower in title:
                hwnd = win["hwnd"]
                rect = get_window_rect(hwnd)
                if rect and rect[2] > 50 and rect[3] > 50:
                    return hwnd
        return None
