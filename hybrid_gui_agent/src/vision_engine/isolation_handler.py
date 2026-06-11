import cv2
import numpy as np
from os_dom_engine.win32_api import get_window_rect
from utils.screen_capture import ScreenCapture

class IsolationHandler:
    def __init__(self, target_size: int = 640):
        self.target_size = target_size
        self.screen_capture = ScreenCapture()
        
    def crop_window(self, hwnd: int) -> tuple:
        """
        Crop the virtual desktop image to the exact bounds of the target window handle (HWND).
        Returns the cropped image (BGR) and its absolute screen rect.
        """
        rect = get_window_rect(hwnd)
        if not rect:
            raise ValueError(f"Could not retrieve coordinates for HWND: {hwnd}")
            
        left, top, w, h = rect
        if w <= 0 or h <= 0:
            raise ValueError(f"Invalid window boundaries: {rect}. Is the window minimized?")
            
        # Capture the window region using DXGI
        # Note: ScreenCapture returns BGRA, we discard the alpha channel for CV2 standard BGR
        bgra_img = self.screen_capture.capture_window(hwnd)
        bgr_img = cv2.cvtColor(bgra_img, cv2.COLOR_BGRA2BGR)
        
        return bgr_img, rect

    def letterbox_normalize(self, img: np.ndarray) -> tuple:
        """
        Resizes the image to a uniform square shape (target_size x target_size) while
        preserving the original aspect ratio using letterbox padding (black bars).
        
        Returns:
            padded_img: Normalized image ready for model inference
            meta: Dict containing scale ratios and padding offsets for coordinate mapping
        """
        h, w = img.shape[:2]
        
        # Calculate scaling ratio (keeping aspect ratio intact)
        r = min(self.target_size / w, self.target_size / h)
        
        # Calculate new unpadded dimensions
        new_w = int(round(w * r))
        new_h = int(round(h * r))
        
        # Resize image using bilinear interpolation
        resized_img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        
        # Compute padding to center the image on the square canvas
        pad_x = (self.target_size - new_w) // 2
        pad_y = (self.target_size - new_h) // 2
        
        # Create solid black canvas
        padded_img = np.zeros((self.target_size, self.target_size, 3), dtype=np.uint8)
        
        # Paste the resized image onto the center of the canvas
        padded_img[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized_img
        
        # Metadata needed for reversing the scaling transformation later
        meta = {
            "original_w": w,
            "original_h": h,
            "new_w": new_w,
            "new_h": new_h,
            "pad_x": pad_x,
            "pad_y": pad_y,
            "scale_ratio": r,
            "target_size": self.target_size
        }
        
        return padded_img, meta
        
    def process_target(self, hwnd: int) -> tuple:
        """
        Isolates, crops, and letterboxes a target window.
        Returns:
            padded_img: Processed NumPy array
            window_rect: Left/top offsets of the window in absolute screen coords
            meta: Normalization metadata dictionary
        """
        bgr_img, rect = self.crop_window(hwnd)
        padded_img, meta = self.letterbox_normalize(bgr_img)
        
        # Include window absolute offsets in metadata for global coordinate restoration
        meta["window_left"] = rect[0]
        meta["window_top"] = rect[1]
        
        return padded_img, rect, meta
