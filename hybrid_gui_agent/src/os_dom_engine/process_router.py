import time
import subprocess
import re
import webbrowser
from .win32_api import enumerate_windows, focus_window, get_window_rect

class ProcessRouter:
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

    @staticmethod
    def try_deterministic_execution(query: str) -> bool:
        """
        Scan raw user command for deterministic intents.
        - Windows Settings deep-links
        - Common applications (notepad, calculator)
        - Web domains
        """
        try:
            q_lower = query.lower().strip()
            
            # 1. Web navigation deep-link extractor
            web_match = re.search(r'(?:go\s+to|open\s+website)\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\S*)', q_lower)
            if web_match:
                url = web_match.group(1).strip()
                if not url.startswith(('http://', 'https://')):
                    url = 'https://' + url
                print(f"[ProcessRouter] Web navigation match. Opening browser to: {url}")
                webbrowser.open(url)
                return True

            # 2. Check settings and tool shortcuts mapping
            settings_mappings = {
                "open settings": "ms-settings:",
                "launch settings": "ms-settings:",
                "wifi": "ms-settings:network-wifi",
                "network settings": "ms-settings:network-wifi",
                "windows update": "ms-settings:windowsupdate",
                "update settings": "ms-settings:windowsupdate",
                "open calculator": "calc.exe",
                "launch calculator": "calc.exe",
                "open notepad": "notepad.exe"
            }
            
            for keyword, target in settings_mappings.items():
                if keyword in q_lower:
                    print(f"[ProcessRouter] Intent match for '{keyword}' -> target: '{target}'. Executing...")
                    import os
                    os.startfile(target)
                    return True
                    
        except Exception as e:
            print(f"[ProcessRouter] Exception during deterministic check: {e}")
            
        return False
