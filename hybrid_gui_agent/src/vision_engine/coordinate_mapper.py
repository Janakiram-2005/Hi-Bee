import cv2
import numpy as np

class CoordinateMapper:
    @staticmethod
    def nms(detections: list, iou_threshold: float = 0.35) -> list:
        """
        Applies Non-Maximum Suppression (NMS) to clear overlapping duplicate bounding boxes.
        Detections structure: list of {"box": [x, y, w, h], "type": str, "confidence": float}
        """
        if not detections:
            return []
            
        # Convert format to [x1, y1, x2, y2]
        boxes = []
        scores = []
        for det in detections:
            x, y, w, h = det["box"]
            boxes.append([x, y, x + w, y + h])
            scores.append(det["confidence"])
            
        boxes = np.array(boxes, dtype=np.float32)
        scores = np.array(scores, dtype=np.float32)
        
        x1 = boxes[:, 0]
        y1 = boxes[:, 1]
        x2 = boxes[:, 2]
        y2 = boxes[:, 3]
        
        areas = (x2 - x1) * (y2 - y1)
        order = scores.argsort()[::-1]
        
        keep = []
        while order.size > 0:
            i = order[0]
            keep.append(i)
            
            if order.size == 1:
                break
                
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            
            w_overlap = np.maximum(0.0, xx2 - xx1)
            h_overlap = np.maximum(0.0, yy2 - yy1)
            intersection = w_overlap * h_overlap
            
            union = areas[i] + areas[order[1:]] - intersection
            # Guard against zero-area union division
            union = np.where(union <= 0, 1e-6, union)
            
            iou = intersection / union
            
            inds = np.where(iou <= iou_threshold)[0]
            order = order[inds + 1]
            
        return [detections[idx] for idx in keep]

    @staticmethod
    def draw_set_of_mark(img: np.ndarray, detections: list) -> tuple:
        """
        Draws semi-transparent colored outlines and numeric ID banners (Set-of-Mark tags)
        directly onto the image.
        Returns:
            marked_img: Annotated image
            index_map: Dictionary mapping index string "[i]" to its detection details
        """
        marked_img = img.copy()
        index_map = {}
        
        # Color mapping for different visual node types
        colors = {
            "button": (0, 0, 255),    # Red
            "input": (0, 255, 0),     # Green
            "text": (255, 0, 0),      # Blue
            "icon": (0, 255, 255),    # Yellow
            "grid": (128, 128, 128)   # Grey for fallback grid
        }
        
        # Semi-transparent overlay canvas
        overlay = marked_img.copy()
        
        for idx, det in enumerate(detections, 1):
            x, y, w, h = det["box"]
            label_id = f"[{idx}]"
            index_map[str(idx)] = det
            
            el_type = det["type"]
            color = colors.get(el_type, (255, 0, 255)) # Default Magenta
            
            # 1. Draw solid bounding container on overlay
            cv2.rectangle(overlay, (x, y), (x + w, y + h), color, 2)
            
            # 2. Blend original image with overlay (transparent visual container effect)
            cv2.addWeighted(overlay, 0.3, marked_img, 0.7, 0, marked_img)
            
            # 3. Draw solid outline frame
            cv2.rectangle(marked_img, (x, y), (x + w, y + h), color, 1)
            
            # 4. Stamp label banner background
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 0.35
            thickness = 1
            text_size = cv2.getTextSize(label_id, font, font_scale, thickness)[0]
            
            # Make sure label stays inside screen boundaries
            label_y = max(y, text_size[1] + 4)
            cv2.rectangle(
                marked_img, 
                (x, label_y - text_size[1] - 4), 
                (x + text_size[0] + 4, label_y + 2), 
                color, 
                -1
            )
            
            # Stamp label text (white for high contrast)
            cv2.putText(
                marked_img, 
                label_id, 
                (x + 2, label_y - 2), 
                font, 
                font_scale, 
                (255, 255, 255), 
                thickness, 
                cv2.LINE_AA
            )
            
        return marked_img, index_map

    @staticmethod
    def generate_fallback_grid(target_size: int = 640) -> list:
        """
        Generate an 8x8 uniform grid quadrant overlay for blank/unstructured application canvases.
        """
        grid_detections = []
        cols = 8
        rows = 8
        grid_w = target_size // cols
        grid_h = target_size // rows
        
        for r in range(rows):
            for c in range(cols):
                x = c * grid_w
                y = r * grid_h
                grid_detections.append({
                    "box": [x, y, grid_w, grid_h],
                    "type": "grid",
                    "confidence": 1.0,
                    "text": f"Grid {r*cols + c + 1}"
                })
        return grid_detections

    @staticmethod
    def restore_coordinate(x_local: float, y_local: float, meta: dict) -> tuple:
        """
        Applies inverse scaling matrix equations to translate letterboxed VLM coordinates 
        back to absolute monitor coordinates.
        
        Formula:
          X_global = X_window_left + ((X_local - pad_x) * (original_w / scaled_to_vlm))
        """
        # Subtract letterboxing padding offset to get coordinate relative to resized frame
        x_unpadded = x_local - meta["pad_x"]
        y_unpadded = y_local - meta["pad_y"]
        
        # Scale ratios: original image size divided by resized size inside letterbox
        width_scaled_to_vlm = meta["new_w"]
        height_scaled_to_vlm = meta["new_h"]
        
        x_ratio = meta["original_w"] / width_scaled_to_vlm
        y_ratio = meta["original_h"] / height_scaled_to_vlm
        
        # Restore coordinates relative to top-left of crop window
        x_crop = x_unpadded * x_ratio
        y_crop = y_unpadded * y_ratio
        
        # Map to absolute virtual desktop monitor coordinates
        x_global = meta["window_left"] + x_crop
        y_global = meta["window_top"] + y_crop
        
        return int(round(x_global)), int(round(y_global))
