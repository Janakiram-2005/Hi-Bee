import json
import subprocess
import os
import ctypes
import winreg
from .win32_api import get_window_rect

class TreeBroker:
    def __init__(self, parser_exe_path: str = None):
        if parser_exe_path is None:
            # Default location relative to workspace
            base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            self.parser_exe_path = os.path.join(base_dir, "native_bridge", "bin", "UIAParser.exe")
        else:
            self.parser_exe_path = parser_exe_path

    def are_desktop_icons_hidden(self) -> bool:
        """Check if Windows desktop icons are hidden in the registry."""
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER, 
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
            ) as key:
                value, _ = winreg.QueryValueEx(key, "HideIcons")
                return value == 1
        except Exception:
            # Default to False if registry query fails
            return False

    def is_desktop_window(self, hwnd: int) -> bool:
        """Check if the provided HWND belongs to the Windows Desktop shell."""
        if not hwnd:
            return False
        shell_window = ctypes.windll.user32.GetShellWindow()
        if hwnd == shell_window:
            return True
            
        buf = ctypes.create_unicode_buffer(256)
        ctypes.windll.user32.GetClassNameW(hwnd, buf, 256)
        class_name = buf.value
        
        # Progman and WorkerW are standard Windows shell containers for the desktop
        return class_name in ["Progman", "WorkerW"]

    def get_ui_tree(self, hwnd: int) -> list:
        """
        Scan the target window and return a list of parsed interactable UI elements.
        Handles window mutation and desktop visibility states.
        """
        if not os.path.exists(self.parser_exe_path):
            raise FileNotFoundError(f"UIAParser binary not found at {self.parser_exe_path}. Build it first.")

        # Configure startupinfo to hide console window spawn
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0 # SW_HIDE

        cmd = [self.parser_exe_path, str(hwnd)]

        try:
            # Run the parser with a strict 2-second timeout to prevent blocking
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                startupinfo=startupinfo
            )
            
            stdout, stderr = proc.communicate(timeout=10.0)
            
            if proc.returncode != 0:
                # Check if it was a window mutation detection reject
                if "MUTATION_DETECTED" in stdout:
                    print("[WARNING] TreeBroker: Window mutated during scan. Resetting sync loop.")
                    return {"error": "Window mutated during scan", "code": "MUTATION_DETECTED"}
                print(f"[ERROR] UIAParser exited with code {proc.returncode}. Stderr: {stderr}")
                return None

            data = stdout.strip()
            if not data:
                return []

            try:
                elements = json.loads(data)
            except json.JSONDecodeError as jde:
                print(f"[ERROR] json.loads failed at pos {jde.pos}. Context: {repr(data[max(0, jde.pos-50):jde.pos+50])}")
                return None
            
            # Post-process desktop icons hidden state check
            is_desktop = self.is_desktop_window(hwnd)
            icons_hidden = self.are_desktop_icons_hidden()

            for el in elements:
                # If desktop icons are hidden, mark desktop child elements as visually hidden
                if is_desktop and icons_hidden:
                    el["visually_hidden"] = True
                else:
                    el["visually_hidden"] = False

            return elements

        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            print("[ERROR] UIAParser timed out during scan. The DOM tree might be too large.")
            return None
        except Exception as e:
            print(f"[ERROR] TreeBroker failed: {e}")
            return None

    def invoke_element(self, hwnd: int, identifier: str) -> dict:
        """
        Bypass standard mouse action and programmatically trigger direct native execution 
        of a UI element (e.g. for hidden desktop icons or offscreen controls).
        """
        if not os.path.exists(self.parser_exe_path):
            raise FileNotFoundError(f"UIAParser binary not found at {self.parser_exe_path}.")

        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0 # SW_HIDE

        cmd = [self.parser_exe_path, "invoke", str(hwnd), identifier]

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                startupinfo=startupinfo
            )
            stdout, stderr = proc.communicate(timeout=5.0)
            
            if proc.returncode != 0:
                print(f"[ERROR] UIAParser invoke failed. Stderr: {stderr}")
                return {"success": False, "error": stderr.strip() or "Process exited with error"}

            return json.loads(stdout.strip())
        except subprocess.TimeoutExpired:
            proc.kill()
            return {"success": False, "error": "Invoke timed out."}
        except Exception as e:
            print(f"[ERROR] TreeBroker invoke failed: {e}")
            return {"success": False, "error": str(e)}

    def get_live_tree(self, hwnd: int = None) -> list:
        """
        Get the live UI tree of the specified window (or the active foreground window).
        """
        try:
            if hwnd is None:
                hwnd = ctypes.windll.user32.GetForegroundWindow()
            return self.get_ui_tree(hwnd)
        except Exception as e:
            print(f"[TreeBroker] get_live_tree failed: {e}")
            return None
