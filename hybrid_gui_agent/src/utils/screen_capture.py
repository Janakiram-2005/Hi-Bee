import mss
import numpy as np

class ScreenCapture:
    def __init__(self):
        # Initialize the mss context, which interfaces with native Windows DXGI Desktop Duplication
        self.sct = mss.mss()

    def get_virtual_screen_bounds(self) -> dict:
        """
        Get the boundaries of the entire virtual desktop (all displays combined).
        Will correctly output negative bounds (left/top) if secondary displays extend 
        above or to the left of the primary display.
        """
        # sct.monitors[0] holds the coordinates of the combined virtual screen
        return self.sct.monitors[0]

    def capture_full_screen(self) -> np.ndarray:
        """
        Capture the entire virtual monitor workspace.
        Returns a NumPy array in BGRA format.
        """
        monitor = self.sct.monitors[0]
        sct_img = self.sct.grab(monitor)
        return np.array(sct_img)

    def capture_region(self, left: int, top: int, width: int, height: int) -> np.ndarray:
        """
        Capture a specific region of the virtual screen grid.
        Handles negative X and Y coordinates seamlessly.
        Returns a NumPy array in BGRA format.
        """
        monitor = {
            "left": left,
            "top": top,
            "width": width,
            "height": height
        }
        sct_img = self.sct.grab(monitor)
        return np.array(sct_img)

    def capture_window(self, hwnd: int) -> np.ndarray:
        """
        Queries the coordinates of the specified window handle and returns a 
        cropped screenshot matching its exact workspace bounding box.
        """
        # Delay import to avoid circular dependency
        from os_dom_engine.win32_api import get_window_rect
        
        rect = get_window_rect(hwnd)
        if not rect:
            raise ValueError(f"Could not retrieve window coordinates for handle: {hwnd}")
        
        # rect structure: [left, top, width, height]
        left, top, width, height = rect
        
        # Safety boundary correction for offscreen or minimized window coordinates
        if width <= 0 or height <= 0:
            raise ValueError(f"Target window is minimized or has invalid boundaries: {rect}")
            
        return self.capture_region(left, top, width, height)

    def capture_centered_crop(self, center_x: int, center_y: int, crop_w: int, crop_h: int) -> np.ndarray:
        """
        Extracts a localized sub-region centered at (center_x, center_y).
        Optimizes downstream image processing or OCR by restricting visual evaluation 
        to localized action zones.
        """
        left = center_x - (crop_w // 2)
        top = center_y - (crop_h // 2)
        return self.capture_region(left, top, crop_w, crop_h)
