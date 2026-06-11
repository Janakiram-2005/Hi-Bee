import os
import cv2
from vision_engine import IsolationHandler, OpenVINOTagger, CoordinateMapper
from os_dom_engine import TreeBroker

class FallbackRouter:
    def __init__(self, parser_exe_path: str = None, models_dir: str = None):
        self.broker = TreeBroker(parser_exe_path)
        self.isolation_handler = IsolationHandler(target_size=640)
        self.tagger = OpenVINOTagger(models_dir)
        
    def get_ui_layout(self, hwnd: int, force_visual: bool = False) -> dict:
        """
        Query the layout details of the target window HWND.
        Attempts native OS DOM scanning first. If it returns empty, encounters a layout mutation, 
        or force_visual is True, automatically shifts execution to the OpenVINO/OpenCV visual track.
        """
        dom_elements = None
        if not force_visual:
            print("[FallbackRouter] Attempting native OS DOM tree scan...")
            dom_elements = self.broker.get_ui_tree(hwnd)
            
        # Evaluate if visual fallback route is needed
        use_visual_fallback = False
        if force_visual:
            use_visual_fallback = True
            print("[FallbackRouter] Force visual mode flag active. Routing to visual pipeline.")
        elif dom_elements is None or (isinstance(dom_elements, list) and len(dom_elements) == 0):
            use_visual_fallback = True
            print("[FallbackRouter] Native DOM tree returned 0 nodes. Shifting to visual fallback track...")
        elif isinstance(dom_elements, dict) and dom_elements.get("code") == "MUTATION_DETECTED":
            use_visual_fallback = True
            print("[FallbackRouter] Window layout mutation detected. Falling back to visual track...")
            
        if not use_visual_fallback:
            return {
                "mode": "dom",
                "elements": dom_elements,
                "marked_image": None,
                "meta": None,
                "index_map": None
            }
            
        # --- Visual Fallback Pipeline ---
        print("[FallbackRouter] Launching Visual Fallback Pipeline...")
        
        # 1. Crop window viewport and scale with letterboxing (black margins)
        padded_img, rect, meta = self.isolation_handler.process_target(hwnd)
        
        # 2. Run object detection and OCR text block parsing (OpenVINO with OpenCV fallback)
        detections = self.tagger.detect_elements(padded_img)
        
        # 3. Apply Non-Maximum Suppression (NMS) to eliminate duplicate overlapping boxes
        filtered_detections = CoordinateMapper.nms(detections, iou_threshold=0.35)
        print(f"[FallbackRouter] Detected {len(filtered_detections)} GUI nodes after NMS filtering.")
        
        # 4. Opaque Canvas Abstract Fallback Grid: generate an 8x8 layout if no visual elements exist
        if not filtered_detections:
            print("[FallbackRouter] Warning: 0 visual elements detected. Building 8x8 abstract fallback grid...")
            filtered_detections = CoordinateMapper.generate_fallback_grid(target_size=640)
            
        # 5. Draw contrasting bounding boxes and unique index labels ([1], [2], etc.)
        marked_img, index_map = CoordinateMapper.draw_set_of_mark(padded_img, filtered_detections)
        
        # Format elements for VLM/downstream orchestrator parsing
        formatted_elements = []
        for idx_str, det in index_map.items():
            x, y, w, h = det["box"]
            cx = x + w // 2
            cy = y + h // 2
            formatted_elements.append({
                "index": int(idx_str),
                "type": det["type"],
                "box": det["box"],
                "center": [cx, cy],
                "text": det.get("text", "")
            })
            
        return {
            "mode": "visual",
            "elements": formatted_elements,
            "marked_image": marked_img,
            "meta": meta,
            "index_map": index_map
        }
