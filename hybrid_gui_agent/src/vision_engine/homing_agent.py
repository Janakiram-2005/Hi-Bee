import cv2
import numpy as np
import math

class HomingState:
    IDLE = "IDLE"
    SKIPPED = "SKIPPED"
    TRACING = "TRACING"
    CONVERGED = "CONVERGED"
    PARTIAL_CONVERGENCE = "PARTIAL_CONVERGENCE"
    INVALID_INPUT = "INVALID_INPUT"

def evaluate_coordinate_drift(calculated_pt, anchor_pt):
    """
    Compute Euclidean distance between calculated point and anchor point.
    """
    if calculated_pt is None or anchor_pt is None:
        return 0.0
    return math.sqrt((calculated_pt[0] - anchor_pt[0]) ** 2 + (calculated_pt[1] - anchor_pt[1]) ** 2)

class VisualHomingAgent:
    def __init__(self, drift_threshold=10):
        if not isinstance(drift_threshold, (int, float)) or math.isnan(drift_threshold) or drift_threshold < 0:
            self.drift_threshold = 10.0
        else:
            self.drift_threshold = float(drift_threshold)
        self.last_state = HomingState.IDLE
        self.last_drift = 0.0
        self.last_closest_drift = 0.0
        self.last_coordinates = (0, 0)
        self.last_visualization = None
        self.history = []

    def draw_visual_indicator(self, master_screenshot, initial_pt, refined_pt, anchor_pt=None):
        """
        Draw visual indicators (crosshairs, tolerance circle, trajectory) on a copy of screenshot.
        """
        if master_screenshot is None or not isinstance(master_screenshot, np.ndarray):
            return None
        vis = master_screenshot.copy()
        if len(vis.shape) == 2:
            vis = cv2.cvtColor(vis, cv2.COLOR_GRAY2BGR)
        elif len(vis.shape) == 3 and vis.shape[2] == 4:
            vis = cv2.cvtColor(vis, cv2.COLOR_BGRA2BGR)

        # 1. Anchor point (Green marker + drift threshold tolerance circle)
        if anchor_pt is not None:
            ax, ay = int(round(anchor_pt[0])), int(round(anchor_pt[1]))
            cv2.circle(vis, (ax, ay), max(1, int(round(self.drift_threshold))), (0, 255, 0), 1)
            cv2.drawMarker(vis, (ax, ay), (0, 200, 0), cv2.MARKER_CROSS, 16, 2)
            cv2.putText(vis, "Anchor", (ax + 8, ay - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 200, 0), 1)

        # 2. Initial input point (Red tilted cross)
        ix, iy = int(round(initial_pt[0])), int(round(initial_pt[1]))
        cv2.drawMarker(vis, (ix, iy), (0, 0, 255), cv2.MARKER_TILTED_CROSS, 14, 2)
        cv2.putText(vis, "Initial", (ix + 8, iy - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)

        # 3. Refined point (Cyan diamond)
        rx, ry = int(round(refined_pt[0])), int(round(refined_pt[1]))
        cv2.drawMarker(vis, (rx, ry), (255, 255, 0), cv2.MARKER_DIAMOND, 14, 2)
        cv2.putText(vis, "Refined", (rx + 8, ry + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)

        # 4. Trajectory line connecting Initial -> Refined
        cv2.line(vis, (ix, iy), (rx, ry), (255, 200, 0), 2)
        return vis

    def resolve_precision_click(self, master_screenshot, initial_x, initial_y, semantic_label=None, anchor_pt=None, max_retries=3, visualize=False):
        """
        Closed-loop visual homing resolution.
        """
        self.history = []
        self.last_visualization = None

        # Validate master screenshot
        if master_screenshot is None or not isinstance(master_screenshot, np.ndarray) or master_screenshot.size == 0 or len(master_screenshot.shape) < 2:
            self.last_state = HomingState.INVALID_INPUT
            print("[VisualHoming] Warning: Invalid master screenshot. Falling back to initial coords.")
            safe_x = int(initial_x) if isinstance(initial_x, (int, float)) and not math.isnan(initial_x) else 0
            safe_y = int(initial_y) if isinstance(initial_y, (int, float)) and not math.isnan(initial_y) else 0
            self.last_coordinates = (safe_x, safe_y)
            return safe_x, safe_y

        # Validate initial coordinates
        if initial_x is None or initial_y is None or not isinstance(initial_x, (int, float)) or not isinstance(initial_y, (int, float)) or math.isnan(initial_x) or math.isnan(initial_y):
            self.last_state = HomingState.INVALID_INPUT
            print("[VisualHoming] Warning: Invalid initial coordinates. Falling back to (0, 0).")
            self.last_coordinates = (0, 0)
            return 0, 0

        h, w = master_screenshot.shape[:2]
        if h <= 0 or w <= 0:
            self.last_state = HomingState.INVALID_INPUT
            print("[VisualHoming] Warning: Screenshot has zero dimension. Falling back to initial coords.")
            self.last_coordinates = (int(initial_x), int(initial_y))
            return int(initial_x), int(initial_y)

        # Validate or default anchor point
        if anchor_pt is not None:
            if not (isinstance(anchor_pt, (tuple, list)) and len(anchor_pt) >= 2 and isinstance(anchor_pt[0], (int, float)) and isinstance(anchor_pt[1], (int, float)) and not (math.isnan(anchor_pt[0]) or math.isnan(anchor_pt[1]))):
                print(f"[VisualHoming] Warning: Invalid anchor_pt {anchor_pt}. Defaulting to initial coordinates.")
                anchor_pt = (initial_x, initial_y)
            else:
                anchor_pt = (float(anchor_pt[0]), float(anchor_pt[1]))
        else:
            anchor_pt = (float(initial_x), float(initial_y))

        # 1. Proximity check
        drift = evaluate_coordinate_drift((initial_x, initial_y), anchor_pt)
        self.last_drift = drift
        self.last_closest_drift = drift

        if drift <= self.drift_threshold:
            self.last_state = HomingState.SKIPPED
            print(f"[VisualHoming] Initial coordinate drift ({drift:.2f} px) is within threshold. Skipping loop.")
            final_x, final_y = int(round(initial_x)), int(round(initial_y))
            self.last_coordinates = (final_x, final_y)
            if visualize:
                self.last_visualization = self.draw_visual_indicator(master_screenshot, (initial_x, initial_y), (final_x, final_y), anchor_pt)
            return final_x, final_y

        self.last_state = HomingState.TRACING
        print(f"[VisualHoming] Initial drift is {drift:.2f} px (exceeds threshold {self.drift_threshold} px). Triggering Tracer loop.")

        curr_x, curr_y = float(initial_x), float(initial_y)
        best_x, best_y = curr_x, curr_y
        best_drift = drift
        retries = max(1, int(max_retries)) if isinstance(max_retries, int) else 3

        for attempt in range(retries):
            # 2. Dynamic safe radius calculation
            radius = int(max(drift * 1.5, 32))

            # Safe boundary bounds check
            x_min = max(0, int(curr_x - radius))
            x_max = min(w, int(curr_x + radius))
            y_min = max(0, int(curr_y - radius))
            y_max = min(h, int(curr_y + radius))

            if (x_max - x_min) <= 0 or (y_max - y_min) <= 0:
                break

            # Slicing patch ROI
            cropped_patch = master_screenshot[y_min:y_max, x_min:x_max]

            # 3. Local Feature detection
            # Convert to grayscale
            if len(cropped_patch.shape) == 3 and cropped_patch.shape[2] == 4:
                gray = cv2.cvtColor(cropped_patch, cv2.COLOR_BGRA2GRAY)
            elif len(cropped_patch.shape) == 3:
                gray = cv2.cvtColor(cropped_patch, cv2.COLOR_BGR2GRAY)
            else:
                gray = cropped_patch

            # High-speed Canny edge detection
            edges = cv2.Canny(gray, 50, 150)

            # Locate structural boundaries
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

            if not contours:
                print(f"[VisualHoming] Attempt {attempt+1}: No visual features/contours detected in cropped ROI.")
                break

            # Find contour whose center is closest to the patch center
            patch_center_x = (x_max - x_min) / 2.0
            patch_center_y = (y_max - y_min) / 2.0

            best_contour = None
            min_dist = float('inf')
            best_cx, best_cy = patch_center_x, patch_center_y

            for c in contours:
                M = cv2.moments(c)
                if M["m00"] != 0:
                    cx = M["m10"] / M["m00"]
                    cy = M["m01"] / M["m00"]
                else:
                    x_b, y_b, w_b, h_b = cv2.boundingRect(c)
                    cx = x_b + w_b / 2.0
                    cy = y_b + h_b / 2.0

                dist = math.sqrt((cx - patch_center_x) ** 2 + (cy - patch_center_y) ** 2)
                if dist < min_dist:
                    min_dist = dist
                    best_contour = c
                    best_cx, best_cy = cx, cy

            # Local delta offset inside patch
            local_x_delta = best_cx - patch_center_x
            local_y_delta = best_cy - patch_center_y

            # Map back to global metrics
            new_global_x = curr_x + local_x_delta
            new_global_y = curr_y + local_y_delta

            # Re-evaluate drift
            new_drift = evaluate_coordinate_drift((new_global_x, new_global_y), anchor_pt)
            print(f"[VisualHoming] Attempt {attempt+1}: Recalculated coordinates ({new_global_x:.2f}, {new_global_y:.2f}) - New drift: {new_drift:.2f} px")

            self.history.append({
                "attempt": attempt + 1,
                "coordinates": (new_global_x, new_global_y),
                "drift": new_drift
            })

            # Track closest refined position (lowest drift to anchor)
            if new_drift < best_drift:
                best_drift = new_drift
                best_x, best_y = new_global_x, new_global_y

            curr_x, curr_y = new_global_x, new_global_y
            drift = new_drift

            if drift <= self.drift_threshold:
                self.last_state = HomingState.CONVERGED
                self.last_drift = drift
                self.last_closest_drift = best_drift
                final_x, final_y = int(round(curr_x)), int(round(curr_y))
                self.last_coordinates = (final_x, final_y)
                print(f"[VisualHoming] Convergence achieved! Final coordinate: ({curr_x:.2f}, {curr_y:.2f})")
                if visualize:
                    self.last_visualization = self.draw_visual_indicator(master_screenshot, (initial_x, initial_y), (final_x, final_y), anchor_pt)
                return final_x, final_y

        self.last_state = HomingState.PARTIAL_CONVERGENCE
        self.last_drift = drift
        self.last_closest_drift = best_drift
        final_x, final_y = int(round(best_x)), int(round(best_y))
        self.last_coordinates = (final_x, final_y)

        print(f"[VisualHoming] Tracer did not fully converge (final drift: {drift:.2f} px, closest drift: {best_drift:.2f} px). Returning closest refined position: ({final_x}, {final_y})")
        if visualize:
            self.last_visualization = self.draw_visual_indicator(master_screenshot, (initial_x, initial_y), (final_x, final_y), anchor_pt)
        return final_x, final_y
