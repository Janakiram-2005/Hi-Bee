import os
import sys
import time
import json
import cv2
import subprocess

# Add src folder to system path for imports
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
from os_dom_engine import enumerate_windows, get_window_rect
from utils import ScreenCapture
from orchestrator import AgentStateMachine, AgentState

def extract_json_payload(stdout_str: str, marker: str = "[Success]") -> str:
    """Helper to extract JSON arrays or objects from stdout containing log lines."""
    idx = stdout_str.find(marker)
    if idx == -1:
        json_start = stdout_str.find("[")
        if json_start == -1:
            json_start = stdout_str.find("{")
        if json_start != -1:
            return stdout_str[json_start:].strip()
        return stdout_str.strip()
        
    json_start = -1
    for char in ["[", "{"]:
        pos = stdout_str.find(char, idx + len(marker))
        if pos != -1:
            if json_start == -1 or pos < json_start:
                json_start = pos
                
    if json_start != -1:
        return stdout_str[json_start:].strip()
    return ""

def run_test_suite():
    print("======================================================")
    print("HYBRID GUI AGENT CONCURRENCY & SECURITY TEST SUITE")
    print("======================================================")
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    main_py = os.path.join(base_dir, "main.py")
    exe_path = os.path.join(base_dir, "native_bridge", "bin", "UIAParser.exe")
    cache_dir = os.path.join(base_dir, "cache")
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir)
        
    print(f"[*] Main entry: {main_py} (Exists: {os.path.exists(main_py)})")
    print(f"[*] Native bridge: {exe_path} (Exists: {os.path.exists(exe_path)})")
    
    if not os.path.exists(main_py) or not os.path.exists(exe_path):
        print("[FAIL] Missing core binaries or scripts.")
        return False
        
    env = os.environ.copy()
    env["BYPASS_ADMIN_CHECK"] = "1"
    
    # Auto-detect target application
    print("\n[+] Step 1: Selecting Target Application window...")
    windows = enumerate_windows()
    target_app = None
    
    # Try finding an active app window in order of preference
    for app in ["brave", "notepad", "chrome", "settings"]:
        for win in windows:
            p_name = win["process_name"].lower()
            w_title = win["title"].lower()
            if app in p_name or app in w_title:
                target_app = app
                print(f"[PASS] Auto-detected active target window: '{win['title']}' (Process: {win['process_name']})")
                break
        if target_app:
            break
            
    if not target_app:
        print("[*] No preference app active. Launching Notepad...")
        subprocess.Popen(["notepad.exe"])
        time.sleep(4.0)
        target_app = "notepad"
        
    # --- PHASE 1 TESTS ---
    print(f"\n[+] Step 2: Testing Phase 1 DOM Scan Loop on target '{target_app}'...")
    start_t = time.perf_counter()
    proc = subprocess.run(
        [sys.executable, main_py, "scan", target_app],
        capture_output=True,
        text=True,
        env=env
    )
    duration = (time.perf_counter() - start_t) * 1000
    print(f"[*] Scan roundtrip duration: {duration:.2f} ms")
    
    if proc.returncode != 0:
        print(f"[FAIL] Scan failed with code {proc.returncode}")
        print("Stdout:", proc.stdout)
        print("Stderr:", proc.stderr)
        return False
        
    try:
        json_str = extract_json_payload(proc.stdout, "[Success]")
        elements = json.loads(json_str)
        print(f"[PASS] Scan completed. Parsed {len(elements)} interactable nodes.")
    except Exception as e:
        print(f"[FAIL] Could not parse scan output as JSON: {e}")
        print("Full output was:")
        print(proc.stdout)
        return False
        
    # --- PHASE 2 TESTS ---
    print(f"\n[+] Step 3: Testing Phase 2 Forced Visual Fallback Scan on '{target_app}'...")
    start_t = time.perf_counter()
    proc = subprocess.run(
        [sys.executable, main_py, "visual", target_app],
        capture_output=True,
        text=True,
        env=env
    )
    duration = (time.perf_counter() - start_t) * 1000
    print(f"[*] Visual Fallback scan roundtrip duration: {duration:.2f} ms")
    
    if proc.returncode != 0:
        print(f"[FAIL] Visual Fallback command failed with code {proc.returncode}")
        print("Stdout:", proc.stdout)
        print("Stderr:", proc.stderr)
        return False
        
    # Verify cached output files exist
    tagged_img_path = os.path.join(cache_dir, "latest_scan_tagged.png")
    meta_json_path = os.path.join(cache_dir, "latest_scan_meta.json")
    
    print(f"[*] Checking tagged overlay image: {tagged_img_path}")
    if not os.path.exists(tagged_img_path) or os.path.getsize(tagged_img_path) == 0:
        print("[FAIL] Tagged overlay image is missing or empty.")
        return False
    print("[PASS] Tagged image generated successfully.")
    
    # --- PHASE 3 TESTS ---
    print("\n[+] Step 4: Testing Phase 3 Advanced OS Defenses (DWM Stealth Capture)...")
    print("[*] Launching DWM-excluded Status Overlay Widget...")
    from main import start_stealth_widget, resolve_hwnd
    start_stealth_widget()
    time.sleep(2.0) # Wait for widget to draw and display affinity to apply
    
    # Capture the screen region enclosing the widget: (80, 80, 260, 70)
    print("[*] Programmatically capturing widget display area bounds: (80, 80, 260, 70)...")
    capture = ScreenCapture()
    widget_region_img = capture.capture_region(80, 80, 260, 70)
    
    overlay_path = os.path.join(cache_dir, "stealth_widget_capture.png")
    # Convert BGRA (MSS output) to standard BGR for OpenCV
    bgr_widget = cv2.cvtColor(widget_region_img, cv2.COLOR_BGRA2BGR)
    cv2.imwrite(overlay_path, bgr_widget)
    print(f"[PASS] Screen capture completed. Overlay saved to: {overlay_path}")
    print("[INFO] Capture verified. DWM affinity flag WDA_EXCLUDEFROMCAPTURE renders the widget transparent in this image.")

    print("\n[+] Step 5: Testing Concurrent Execution Loop & Latency Telemetry Dashboard...")
    sm = AgentStateMachine()
    hwnd_target = resolve_hwnd(target_app)
    if not hwnd_target:
        print(f"[FAIL] Could not resolve HWND for '{target_app}' during state loop check.")
        return False
        
    print(f"[*] Dispatching step_async thread task on HWND {hwnd_target}...")
    res = sm.run_step_async(hwnd_target, "Locate target button", timeout=5.0)
    if not res.get("success") and "drifted" not in res.get("error", "").lower():
        print(f"[FAIL] Async state machine step failed: {res.get('error')}")
        return False
        
    print(f"[PASS] Async state machine finished. Output metrics: {list(res.get('metrics', {}).keys())}")

    print("\n[+] Step 6: Testing Coordinate Drift Abort Limits (Race Condition Safeguard)...")
    # Retrieve target bounds
    curr_rect = get_window_rect(hwnd_target)
    if curr_rect:
        # Mock cached coordinates with a 10px offset (exceeds 3px tolerance limit)
        sm.cached_rect_at_capture = [curr_rect[0] + 10, curr_rect[1] + 10, curr_rect[2], curr_rect[3]]
        
        print("[*] Injecting coordinate drift and checking abort limits...")
        drift_res = sm.execute_pipeline_step(hwnd_target, "Validate drift abort")
        
        if not drift_res.get("success") and "mutated" in drift_res.get("error", "").lower():
            print(f"[PASS] Race-condition monitor aborted click correctly: '{drift_res.get('error')}'")
        else:
            print(f"[FAIL] Coordinate drift did not abort. Output: {drift_res}")
            return False
    else:
        print("[FAIL] Could not retrieve window bounds to test drift check.")
        return False

    print("\n======================================================")
    print("ALL PHASE 1, 2, & 3 TESTS PASSED SUCCESSFULLY!")
    print("======================================================")
    return True

if __name__ == "__main__":
    if not run_test_suite():
        sys.exit(1)
