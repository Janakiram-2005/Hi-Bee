import ctypes
import os
import sys
from ctypes import wintypes

# Win32 Constants
SW_RESTORE = 9
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

# Callback prototype for EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

def is_admin() -> bool:
    """Check if the active process has administrative privileges."""
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False

def run_as_admin():
    """Relaunches the current script with elevated administrator privileges."""
    script = sys.argv[0]
    # Re-quote arguments to handle spaces
    params = " ".join(f'"{arg}"' if " " in arg else arg for arg in sys.argv[1:])
    try:
        ret = ctypes.windll.shell32.ShellExecuteW(
            None, 
            "runas", 
            sys.executable, 
            f'"{script}" {params}', 
            None, 
            1
        )
        if int(ret) <= 32:
            raise RuntimeError("Elevation request was rejected or failed.")
        sys.exit(0)
    except Exception as e:
        print(f"Error self-elevating: {e}")
        raise

def set_dpi_awareness():
    """Force Process DPI Awareness to Per-Monitor (2) to ensure pixel coordinate parity."""
    try:
        # Try Per-Monitor V2 DPI awareness (PROCESS_PER_MONITOR_DPI_AWARE = 2)
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        print("DPI awareness successfully configured to Per-Monitor V2.")
    except Exception:
        try:
            # Fallback to system DPI aware
            ctypes.windll.user32.SetProcessDPIAware()
            print("DPI awareness configured to System DPI Aware (fallback).")
        except Exception as e:
            print(f"Warning: DPI awareness settings could not be set: {e}")

def get_window_process_name(hwnd: int) -> str:
    """Retrieve the process executable name associated with a window handle."""
    pid = ctypes.c_ulong(0)
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value == 0:
        return None
    
    h_process = ctypes.windll.kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, 
        False, 
        pid.value
    )
    if not h_process:
        return None
    
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = ctypes.c_ulong(1024)
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(h_process, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return None
    finally:
        # Prevent resource leak by closing opened kernel handles
        ctypes.windll.kernel32.CloseHandle(h_process)

def focus_window(hwnd: int) -> bool:
    """Bring the window to the foreground, restoring it first if it is minimized."""
    if not hwnd or not ctypes.windll.user32.IsWindow(hwnd):
        return False
        
    try:
        # Check if the window is minimized
        if ctypes.windll.user32.IsIconic(hwnd):
            ctypes.windll.user32.ShowWindow(hwnd, SW_RESTORE)
            
        # Attempt to set focus
        ctypes.windll.user32.SetForegroundWindow(hwnd)
        return True
    except Exception as e:
        print(f"Error focusing window {hwnd}: {e}")
        return False

def enumerate_windows() -> list:
    """Enumerate all top-level, visible windows and map them to their process name and title."""
    windows_list = []
    
    def enum_callback(hwnd, lParam):
        # Only inspect visible windows
        if ctypes.windll.user32.IsWindowVisible(hwnd):
            # Fetch window title length
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            title = ""
            if length > 0:
                title_buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, title_buf, length + 1)
                title = title_buf.value
            
            # Fetch process executable name
            proc_name = get_window_process_name(hwnd)
            if proc_name or title:
                windows_list.append({
                    "hwnd": hwnd,
                    "title": title,
                    "process_name": proc_name or "Unknown"
                })
        return True
        
    cb = EnumWindowsProc(enum_callback)
    ctypes.windll.user32.EnumWindows(cb, 0)
    return windows_list

def get_window_rect(hwnd: int) -> list:
    """Get the bounding rect [left, top, width, height] of the window handle."""
    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_int),
            ("top", ctypes.c_int),
            ("right", ctypes.c_int),
            ("bottom", ctypes.c_int)
        ]
        
    rect = RECT()
    if ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        return [rect.left, rect.top, w, h]
    return None
