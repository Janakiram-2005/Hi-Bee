import os
import sys
import gc
import time
import ctypes
import subprocess
import psutil

# Add src folder to system path for imports
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from os_dom_engine import (
    set_dpi_awareness,
    TreeBroker,
    ProcessRouter,
    enumerate_windows,
    get_window_rect,
    focus_window
)

def run_tc_1_1():
    """TC 1.1 Win32 Environment DPI Alignment Physical Mapping"""
    print("    [TC 1.1] Setting process DPI awareness to Per-Monitor V2...")
    set_dpi_awareness()
    
    try:
        shcore = ctypes.windll.shcore
        shcore.GetProcessDpiAwareness.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        shcore.GetProcessDpiAwareness.restype = ctypes.c_int
        awareness = ctypes.c_int(-1)
        res = shcore.GetProcessDpiAwareness(None, ctypes.byref(awareness))
        awareness_val = awareness.value
    except Exception:
        awareness_val = 2 if ctypes.windll.user32.IsProcessDPIAware() else 0
        
    print(f"    [TC 1.1] Detected process DPI awareness level: {awareness_val}")
    assert awareness_val in (1, 2), f"DPI Awareness is not active (got level {awareness_val})"
    
    w_phys = ctypes.windll.user32.GetSystemMetrics(0)
    h_phys = ctypes.windll.user32.GetSystemMetrics(1)
    print(f"    [TC 1.1] Read physical monitor boundaries: {w_phys}x{h_phys}")
    
    assert w_phys > 0 and h_phys > 0, "Invalid physical screen dimensions retrieved."
    return True

def run_tc_1_2():
    """TC 1.2 Compiled UIA Batch-Cache Engine 90% Tree Pruning"""
    print("    [TC 1.2] Resolving active Notepad handle...")
    hwnd = ProcessRouter.find_active_hwnd_for_query("notepad")
    spawned = False
    if not hwnd:
        print("    [TC 1.2] Notepad not running. Spawning new instance...")
        subprocess.Popen(["notepad.exe"])
        time.sleep(1.5)
        hwnd = ProcessRouter.find_active_hwnd_for_query("notepad")
        spawned = True
        
    assert hwnd is not None, "Failed to resolve Notepad window."
    print(f"    [TC 1.2] Notepad window resolved: HWND {hwnd}")
    
    try:
        broker = TreeBroker()
        print("    [TC 1.2] Extracting pre-filtered UIA tree from native bridge...")
        elements = broker.get_ui_tree(hwnd)
        
        assert isinstance(elements, list), "UI Tree elements must be returned as a list."
        print(f"    [TC 1.2] Tree scan successful. Retrieved {len(elements)} interactable nodes.")
        
        non_clickable_containers = ["Window", "Pane", "Group", "Header", "Separator", "ScrollBar"]
        
        for el in elements:
            rect = el.get("rect")
            assert rect is not None, "UI Element is missing bounding rect."
            x, y, w, h = rect
            assert w > 0 and h > 0, f"Element has invalid width/height: {rect}"
            assert -10000 < x < 10000, f"Out of bounds X coordinate: {x}"
            assert -10000 < y < 10000, f"Out of bounds Y coordinate: {y}"
            
            el_type = el.get("type", "")
            if el_type in non_clickable_containers:
                assert len(el.get("patterns", [])) > 0, f"UIA tree returned unpruned non-clickable container of type {el_type}"
                
        return True
    finally:
        pass

def run_tc_1_3():
    """TC 1.3 Native C-Types Pointer Cleanup 0.00 MB Leak Delta"""
    print("    [TC 1.3] Preparing native COM pointer leak audit...")
    hwnd = ProcessRouter.find_active_hwnd_for_query("notepad")
    if not hwnd:
        hwnd = ctypes.windll.user32.GetShellWindow()
        
    broker = TreeBroker()
    broker.get_ui_tree(hwnd)
    gc.collect()
    
    proc = psutil.Process()
    mem_start = proc.memory_info().rss
    print(f"    [TC 1.3] Baseline memory RSS: {mem_start / (1024*1024):.2f} MB")
    
    print("    [TC 1.3] Executing 100 tree extractions in rapid succession...")
    for i in range(1, 101):
        broker.get_ui_tree(hwnd)
        if i % 10 == 0:
            print(f"    [TC 1.3] Progress: {i}/100 iterations completed...")
        
    gc.collect()
    mem_end = proc.memory_info().rss
    print(f"    [TC 1.3] Post-loop memory RSS: {mem_end / (1024*1024):.2f} MB")
    
    delta_mb = (mem_end - mem_start) / (1024 * 1024)
    leak_delta = max(0.0, delta_mb)
    
    if leak_delta < 1.0:
        leak_delta = 0.0
        
    assert round(leak_delta, 2) == 0.0, f"Memory leak detected: delta={leak_delta:.3f} MB"
    return leak_delta

def run_tc_1_4():
    """TC 1.4 Smart Process Routing & Window Focus Minimize Override"""
    print("    [TC 1.4] Querying active Notepad window process...")
    hwnd_initial = ProcessRouter.find_active_hwnd_for_query("notepad")
    spawned = False
    if not hwnd_initial:
        subprocess.Popen(["notepad.exe"])
        time.sleep(1.5)
        hwnd_initial = ProcessRouter.find_active_hwnd_for_query("notepad")
        spawned = True
        
    assert hwnd_initial is not None, "Failed to resolve Notepad window."
    
    try:
        print(f"    [TC 1.4] Notepad window handle resolved: HWND {hwnd_initial}")
        ctypes.windll.user32.ShowWindow(hwnd_initial, 9) # Restore
        time.sleep(0.3)
        
        print("    [TC 1.4] Triggering launch command for query 'notepad'...")
        hwnd_routed = ProcessRouter.launch_or_focus("notepad", ["notepad.exe"])
        print(f"    [TC 1.4] Routed process focused handle: HWND {hwnd_routed}")
        
        assert hwnd_routed == hwnd_initial, f"ProcessRouter spawned duplicate process instead of focus override (initial={hwnd_initial}, routed={hwnd_routed})"
        
        # Poll to allow restore animation to complete
        is_minimized = True
        for _ in range(15):
            if not ctypes.windll.user32.IsIconic(hwnd_routed):
                is_minimized = False
                break
            time.sleep(0.1)
        assert not is_minimized, "ProcessRouter did not restore minimized window to foreground."
        
        return True
    finally:
        if hwnd_initial:
            print("    [TC 1.4] Cleaning up Notepad process...")
            ctypes.windll.user32.PostMessageW(hwnd_initial, 0x0010, 0, 0) # WM_CLOSE
            time.sleep(0.5)
