import os
import sys
import json
import time
import subprocess
import cv2
import threading
import ctypes
from PIL import Image

# Add src folder to system path for imports
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from os_dom_engine import (
    is_admin,
    run_as_admin,
    set_dpi_awareness,
    enumerate_windows,
    focus_window,
    get_window_rect,
    TreeBroker,
    ProcessRouter
)
from utils import ScreenCapture
from orchestrator import FallbackRouter, AgentStateMachine
from vision_engine import CoordinateMapper

def check_and_compile_bridge():
    """Verify that the UIAParser binary exists. If not, or if the source has changed, compile it."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    source_path = os.path.join(base_dir, "native_bridge", "UIAParser.cs")
    bin_dir = os.path.join(base_dir, "native_bridge", "bin")
    exe_path = os.path.join(bin_dir, "UIAParser.exe")

    needs_compile = False
    if not os.path.exists(exe_path):
        needs_compile = True
    elif os.path.exists(source_path) and os.path.getmtime(source_path) > os.path.getmtime(exe_path):
        needs_compile = True

    if needs_compile:
        print("[Bootstrapper] Compiling native C# bridge (UIAParser.cs) to binary...")
        if not os.path.exists(bin_dir):
            os.makedirs(bin_dir)
            
        csc_path = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
        if not os.path.exists(csc_path):
            raise RuntimeError(f"C# compiler (csc.exe) not found at {csc_path}. Ensure .NET Framework is installed.")
            
        cmd = [
            csc_path,
            "/target:exe",
            f"/out:{exe_path}",
            r"/r:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\WindowsBase.dll",
            r"/r:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\UIAutomationClient.dll",
            r"/r:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\UIAutomationTypes.dll",
            source_path
        ]
        
        # Hide the compilation console window
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0 # SW_HIDE
        
        proc = subprocess.Popen(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE, 
            text=True, 
            startupinfo=startupinfo
        )
        stdout, stderr = proc.communicate()
        
        if proc.returncode != 0:
            raise RuntimeError(f"C# compilation failed:\nStdout: {stdout}\nStderr: {stderr}")
            
        print(f"[Bootstrapper] Compilation successful. UIAParser binary located at: {exe_path}")

def resolve_hwnd(query: str) -> int:
    """Resolve a user query to a window handle (HWND). Checks digit string or performs process query lookup."""
    if query.isdigit():
        return int(query)
    
    # Try finding and bringing the target application to focus
    hwnd = ProcessRouter.find_and_focus_app(query)
    if hwnd:
        return hwnd
        
    return None

def start_stealth_widget():
    """Launch a floating GUI status widget and exclude it from screenshots using DWM display affinity."""
    try:
        import tkinter as tk
        def run_tk():
            root = tk.Tk()
            root.title("Stealth Status Widget")
            root.geometry("260x70+80+80")
            root.attributes("-topmost", True)
            root.resizable(False, False)
            root.configure(bg="#2d124d")
            
            # Make the window transparent (semi-transparent)
            root.attributes("-alpha", 0.7)
            
            lbl = tk.Label(
                root,
                text="STATUS WIDGET ACTIVE\n(Visible to Programmatic Capture)",
                fg="#00ffcc",
                bg="#2d124d",
                font=("Arial", 9, "bold")
            )
            lbl.pack(fill=tk.BOTH, expand=True)
            
            root.update()
            hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
            
            # WDA_NONE = 0x00000000 (allows the window to be captured in screenshots)
            WDA_NONE = 0x00000000
            res = ctypes.windll.user32.SetWindowDisplayAffinity(hwnd, WDA_NONE)
            print(f"[Stealth] SetWindowDisplayAffinity (WDA_NONE) applied to HWND {hwnd} (Status: {res == 1}).")
            
            root.mainloop()
            
        th = threading.Thread(target=run_tk, daemon=True)
        th.start()
        print("[Stealth] Status overlay widget spawned asynchronously.")
    except Exception as e:
        print(f"[Stealth] Could not spawn overlay widget: {e}")

def print_usage():
    print("""
======================================================
Hybrid GUI Agent CLI Interface
======================================================
Usage:
  python main.py list
      List all visible windows with titles and process names.
      
  python main.py scan <hwnd_or_name>
      Scan layout elements (automatically uses OpenVINO/OpenCV visual fallback if tree is empty).
      
  python main.py visual <hwnd_or_name>
      Force OpenVINO/OpenCV visual analysis, overlay index labels, and save tagged image.
      
  python main.py click_tag <index>
      Simulate mouse click at the global coordinate corresponding to the tag index.
      
  python main.py run_agent <hwnd_or_name> [command]
      Run non-blocking Async State Machine with DWM stealth widget, lock check, and latency profiling.
      
  python main.py capture <hwnd_or_name> <output_png>
      Focus the target window and take a DXGI screenshot, saving to output_png.
      
  python main.py invoke <hwnd_or_name> <automation_id_or_name>
      Directly invoke a programmatic control pattern on a UI element.
======================================================
""")

def main():
    # 1. Enforce Administrative privileges for low-level automation access
    if not is_admin() and os.environ.get("BYPASS_ADMIN_CHECK") != "1":
        print("[Bootstrapper] Process is not running as Administrator. Triggering self-elevation...")
        try:
            run_as_admin()
        except Exception as e:
            print(f"[ERROR] Could not self-elevate process: {e}")
            sys.exit(1)
        return

    # 2. Inject kernel DPI awareness configurations
    set_dpi_awareness()

    # 3. Auto-compile the C# UI Automation bridge if source changed
    try:
        check_and_compile_bridge()
    except Exception as e:
        print(f"[ERROR] Bridge initialization failed: {e}")
        sys.exit(1)

    # 4. Handle CLI commands
    if len(sys.argv) < 2:
        print_usage()
        sys.exit(0)

    cmd = sys.argv[1].lower()
    broker = TreeBroker()

    if cmd == "list":
        windows = enumerate_windows()
        print("\n--- Current Running Windows ---")
        for win in windows:
            print(f"HWND: {win['hwnd']:<8} | Process: {win['process_name']:<22} | Title: {win['title']}")
        print(f"Total active windows: {len(windows)}\n")

    elif cmd == "scan" or cmd == "visual":
        if len(sys.argv) < 3:
            print(f"Error: Missing target parameter.")
            print(f"Usage: python main.py {cmd} <hwnd_or_name>")
            sys.exit(1)
            
        query = sys.argv[2]
        hwnd = resolve_hwnd(query)
        if not hwnd:
            print(f"[ERROR] Could not resolve any active window matching query: '{query}'")
            sys.exit(1)

        router = FallbackRouter()
        force_visual = (cmd == "visual")
        
        print(f"[Router] Running layout query on HWND: {hwnd}...")
        start_t = time.perf_counter()
        layout = router.get_ui_layout(hwnd, force_visual=force_visual)
        end_t = time.perf_counter()
        
        duration = (end_t - start_t) * 1000
        
        if layout["mode"] == "dom":
            elements = layout["elements"]
            print(f"[Success] DOM Scan completed in {duration:.2f} milliseconds. Found {len(elements)} interactable nodes.")
            print(json.dumps(elements, indent=2))
        else:
            # Visual mode
            elements = layout["elements"]
            marked_img = layout["marked_image"]
            meta = layout["meta"]
            index_map = layout["index_map"]
            
            # Save visual tagged image and metadata to cache
            cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
            if not os.path.exists(cache_dir):
                os.makedirs(cache_dir)
                
            img_path = os.path.join(cache_dir, "latest_scan_tagged.png")
            cv2.imwrite(img_path, marked_img)
            
            # Save meta along with hwnd and index_map
            meta["hwnd"] = hwnd
            cache_data = {
                "meta": meta,
                "index_map": index_map
            }
            meta_path = os.path.join(cache_dir, "latest_scan_meta.json")
            with open(meta_path, "w") as f:
                json.dump(cache_data, f, indent=2)
                
            print(f"[Success] Visual Fallback completed in {duration:.2f} milliseconds. Found {len(elements)} visual nodes.")
            print(f"[*] Tagged image saved to: {img_path}")
            print(f"[*] Scaling metadata saved to: {meta_path}")
            print(json.dumps(elements, indent=2))

    elif cmd == "click_tag":
        if len(sys.argv) < 3:
            print("Error: Missing arguments.")
            print("Usage: python main.py click_tag <index>")
            sys.exit(1)
            
        index = sys.argv[2]
        
        # Load from cache
        cache_meta_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "cache",
            "latest_scan_meta.json"
        )
        if not os.path.exists(cache_meta_path):
            print(f"[ERROR] Cache metadata file not found at {cache_meta_path}. Run a visual scan first.")
            sys.exit(1)
            
        with open(cache_meta_path, "r") as f:
            cache_data = json.load(f)
            
        index_map = cache_data.get("index_map", {})
        meta = cache_data.get("meta", {})
        
        if index not in index_map:
            print(f"[ERROR] Tag index '{index}' not found in latest scan.")
            sys.exit(1)
            
        det = index_map[index]
        x, y, w, h = det["box"]
        # local scaled center
        cx_local = x + w // 2
        cy_local = y + h // 2
        
        # Restore absolute coordinates
        x_global, y_global = CoordinateMapper.restore_coordinate(cx_local, cy_local, meta)
        
        # Resolve current window position to check for movement since visual scan
        hwnd = meta.get("hwnd")
        if hwnd:
            current_rect = get_window_rect(hwnd)
            if current_rect:
                curr_left, curr_top, curr_w, curr_h = current_rect
                dx = curr_left - meta["window_left"]
                dy = curr_top - meta["window_top"]
                if dx != 0 or dy != 0:
                    print(f"[Mapper] Target window moved by ({dx}, {dy}) pixels since visual scan. Adjusting click coordinates...")
                    x_global += dx
                    y_global += dy

        print(f"[Mapper] Restoring coordinate for tag [{index}]...")
        print(f"[*] Local scaled center: ({cx_local}, {cy_local})")
        print(f"[*] Restored global coordinate: ({x_global}, {y_global})")
        
        # Activate target window to accept click
        if hwnd:
            focus_window(hwnd)
            time.sleep(0.3)
            
        # Simulate click
        print(f"[System] Simulating physical mouse click at absolute pixels: ({x_global}, {y_global})")
        import ctypes
        ctypes.windll.user32.SetCursorPos(x_global, y_global)
        ctypes.windll.user32.mouse_event(0x0002, 0, 0, 0, 0) # LEFTDOWN
        time.sleep(0.05)
        ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0) # LEFTUP
        print("[Success] Mouse click executed.")

    elif cmd == "run_agent" or cmd == "run_agent_streaming":
        if len(sys.argv) < 3:
            print("Error: Missing target parameter.")
            print(f"Usage: python main.py {cmd} <hwnd_or_name> [command]")
            sys.exit(1)
            
        query = sys.argv[2]
        command_str = sys.argv[3] if len(sys.argv) > 3 else "Perform standard action"
        
        hwnd = resolve_hwnd(query)
        if not hwnd:
            print(f"[ERROR] Could not resolve any active window matching query: '{query}'")
            sys.exit(1)
            
        # Verify Google Vertex AI credentials
        project_id = os.environ.get("VERTEX_VLM_PROJECT_ID") or os.environ.get("VERTEX_PROJECT_ID")
        location = os.environ.get("VERTEX_VLM_LOCATION") or os.environ.get("VERTEX_LOCATION") or "us-central1"
        sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        
        print("\n======================================================")
        print("GOOGLE VERTEX AI AUTHENTICATION DIAGNOSTICS")
        print("======================================================")
        print(f"Project ID:   {project_id if project_id else 'Not configured (will use ADC/gcloud default)'}")
        print(f"Location:     {location}")
        print(f"SA JSON Path: {sa_path if sa_path else 'Not set (using Application Default Credentials)'}")
        print("======================================================\n")

        # Spawn the DWM excluded status widget
        start_stealth_widget()
        time.sleep(1.0) # wait for widget initialization
        
        print(f"[Orchestrator] Starting non-blocking Async State Machine on HWND: {hwnd}...")
        sm = AgentStateMachine()
        
        # Execute the async loop step (enforces lock checks, drift verification, and latency dashboards)
        res = sm.run_step_async(hwnd, command_str, timeout=5.0)
        print("\n--- Concurrency Execution Result Summary ---")
        print(json.dumps(res, indent=2))
        
        # Short sleep to display active widget before program exits
        time.sleep(2.0)

    elif cmd == "capture":
        if len(sys.argv) < 4:
            print("Error: Missing arguments.")
            print("Usage: python main.py capture <hwnd_or_name> <output_png>")
            sys.exit(1)

        query = sys.argv[2]
        output_path = sys.argv[3]
        
        hwnd = resolve_hwnd(query)
        if not hwnd:
            print(f"[ERROR] Could not resolve any active window matching query: '{query}'")
            sys.exit(1)

        # Elevate window focus before screenshotting
        focus_window(hwnd)
        time.sleep(0.3)

        print(f"[Capture] Capturing coordinates for window HWND: {hwnd}...")
        try:
            capture = ScreenCapture()
            img = capture.capture_window(hwnd)
            
            # Convert BGRA (MSS output) to RGBA (Pillow standard format) by swapping channels
            rgba_img = img[..., [2, 1, 0, 3]]
            
            pil_img = Image.fromarray(rgba_img)
            
            # Ensure target output folder exists
            dir_name = os.path.dirname(output_path)
            if dir_name and not os.path.exists(dir_name):
                os.makedirs(dir_name)
                
            pil_img.save(output_path)
            print(f"[Success] Screen capture saved to: {output_path}")
        except Exception as e:
            print(f"[ERROR] Screenshot capture failed: {e}")
            sys.exit(1)

    elif cmd == "invoke":
        if len(sys.argv) < 4:
            print("Error: Missing arguments.")
            print("Usage: python main.py invoke <hwnd_or_name> <automation_id_or_name>")
            sys.exit(1)

        query = sys.argv[2]
        identifier = sys.argv[3]

        hwnd = resolve_hwnd(query)
        if not hwnd:
            print(f"[ERROR] Could not resolve any active window matching query: '{query}'")
            sys.exit(1)

        print(f"[Broker] Resolving element '{identifier}' and invoking native DOM action...")
        result = broker.invoke_element(hwnd, identifier)
        print(json.dumps(result, indent=2))

    else:
        print(f"[ERROR] Unknown instruction: {cmd}")
        print_usage()
        sys.exit(1)

if __name__ == "__main__":
    main()
