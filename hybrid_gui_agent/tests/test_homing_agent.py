"""
tests/test_homing_agent.py
==========================
Unit tests for VisualHomingAgent closed-loop refinement and fallback.
Verifies:
1. Input validation for screenshot, coordinates, anchor points, and thresholds.
2. Immediate skip when initial coordinate drift is within threshold.
3. Closed-loop contour convergence when within max retries.
4. Fallback returns the closest refined position rather than reverting to initial coordinates.
5. Fallback selects the best-drift position when attempts diverge.
6. Early break (e.g. no contours) retains the best refined position.
7. Visual indicator rendering on frames.
8. Real-time 60 FPS performance constraints (< 16.6 ms budget).
"""

import math
import os
import sys
import time
import unittest
import numpy as np
import cv2

# Add src folder to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from vision_engine.homing_agent import VisualHomingAgent, HomingState, evaluate_coordinate_drift


class TestVisualHomingAgent(unittest.TestCase):
    def setUp(self):
        self.agent = VisualHomingAgent(drift_threshold=10)

    def test_drift_calculation(self):
        self.assertAlmostEqual(evaluate_coordinate_drift((0, 0), (3, 4)), 5.0)
        self.assertAlmostEqual(evaluate_coordinate_drift(None, (10, 10)), 0.0)
        self.assertAlmostEqual(evaluate_coordinate_drift((10, 10), None), 0.0)
        self.assertAlmostEqual(evaluate_coordinate_drift((100, 100), (100, 100)), 0.0)

    def test_invalid_inputs(self):
        # 1. None screenshot
        x, y = self.agent.resolve_precision_click(None, 50, 50)
        self.assertEqual((x, y), (50, 50))
        self.assertEqual(self.agent.last_state, HomingState.INVALID_INPUT)

        # 2. Non-array screenshot
        x, y = self.agent.resolve_precision_click("invalid_image", 50, 50)
        self.assertEqual((x, y), (50, 50))
        self.assertEqual(self.agent.last_state, HomingState.INVALID_INPUT)

        # 3. Empty array screenshot
        empty_img = np.array([])
        x, y = self.agent.resolve_precision_click(empty_img, 50, 50)
        self.assertEqual((x, y), (50, 50))
        self.assertEqual(self.agent.last_state, HomingState.INVALID_INPUT)

        # 4. Zero dimension screenshot
        zero_img = np.zeros((0, 0, 3), dtype=np.uint8)
        x, y = self.agent.resolve_precision_click(zero_img, 50, 50)
        self.assertEqual((x, y), (50, 50))
        self.assertEqual(self.agent.last_state, HomingState.INVALID_INPUT)

        # 5. Invalid initial coordinates (None / NaN)
        canvas = np.zeros((400, 400, 3), dtype=np.uint8)
        x, y = self.agent.resolve_precision_click(canvas, None, 50)
        self.assertEqual((x, y), (0, 0))
        self.assertEqual(self.agent.last_state, HomingState.INVALID_INPUT)

        x, y = self.agent.resolve_precision_click(canvas, float('nan'), 50)
        self.assertEqual((x, y), (0, 0))
        self.assertEqual(self.agent.last_state, HomingState.INVALID_INPUT)

        # 6. Invalid threshold in init falls back to default 10.0
        bad_agent = VisualHomingAgent(drift_threshold=-5)
        self.assertEqual(bad_agent.drift_threshold, 10.0)
        nan_agent = VisualHomingAgent(drift_threshold=float('nan'))
        self.assertEqual(nan_agent.drift_threshold, 10.0)

    def test_initial_drift_within_threshold(self):
        canvas = np.zeros((600, 800, 3), dtype=np.uint8)
        # Target anchor is (100, 100), initial coordinate is (105, 104) (drift ~6.4 px <= 10 px)
        final_x, final_y = self.agent.resolve_precision_click(
            master_screenshot=canvas,
            initial_x=105,
            initial_y=104,
            anchor_pt=(100, 100)
        )
        self.assertEqual((final_x, final_y), (105, 104))
        self.assertEqual(self.agent.last_state, HomingState.SKIPPED)
        self.assertAlmostEqual(self.agent.last_drift, math.sqrt(25 + 16), places=2)

    def test_full_convergence(self):
        # Create a 600x800 image with a white circular button at (200, 200)
        canvas = np.zeros((600, 800, 3), dtype=np.uint8)
        cv2.circle(canvas, (200, 200), 20, (255, 255, 255), -1)

        # Initial point is offset by 25px: (225, 200), drift = 25px > 10px threshold
        anchor_pt = (200, 200)
        final_x, final_y = self.agent.resolve_precision_click(
            master_screenshot=canvas,
            initial_x=225,
            initial_y=200,
            anchor_pt=anchor_pt
        )

        self.assertEqual(self.agent.last_state, HomingState.CONVERGED)
        self.assertLessEqual(self.agent.last_drift, self.agent.drift_threshold)
        # Should converge to the center of the button (200, 200)
        self.assertAlmostEqual(final_x, 200, delta=2)
        self.assertAlmostEqual(final_y, 200, delta=2)

    def test_fallback_returns_closest_refined_position(self):
        """
        Critical Bug Test:
        When contour convergence exceeds max retries, the algorithm MUST NOT
        revert to initial coordinates; it must return the closest refined position.
        """
        # Canvas with a small button at (180, 180)
        canvas = np.zeros((600, 800, 3), dtype=np.uint8)
        cv2.circle(canvas, (180, 180), 15, (255, 255, 255), -1)

        # Anchor is set to (175, 175)
        # Initial gesture click landed at (240, 240) -> drift = sqrt(65^2 + 65^2) = 91.92 px
        anchor_pt = (175, 175)
        initial_x, initial_y = 240, 240

        # Strict drift threshold = 4.0 px (distance between button center 180,180 and anchor 175,175 is 7.07 px)
        # Since 7.07 px > 4.0 px, tracer will not reach drift <= threshold within max retries.
        strict_agent = VisualHomingAgent(drift_threshold=4.0)

        final_x, final_y = strict_agent.resolve_precision_click(
            master_screenshot=canvas,
            initial_x=initial_x,
            initial_y=initial_y,
            anchor_pt=anchor_pt,
            max_retries=3
        )

        self.assertEqual(strict_agent.last_state, HomingState.PARTIAL_CONVERGENCE)
        # Crucial assertion: Must NOT be reverted to initial coordinates (240, 240)
        self.assertNotEqual((final_x, final_y), (initial_x, initial_y))
        # Must return the refined coordinate near the visual contour (180, 180)
        self.assertAlmostEqual(final_x, 180, delta=3)
        self.assertAlmostEqual(final_y, 180, delta=3)
        # Closest drift must be substantially smaller than initial drift
        initial_drift = evaluate_coordinate_drift((initial_x, initial_y), anchor_pt)
        self.assertLess(strict_agent.last_closest_drift, initial_drift)
        self.assertAlmostEqual(strict_agent.last_closest_drift, math.sqrt(5**2 + 5**2), delta=3.0)

    def test_fallback_monotonic_best_drift(self):
        """
        If later retries drift further away from the anchor than earlier retries,
        the agent must select the attempt with minimum drift to anchor_pt.
        """
        agent = VisualHomingAgent(drift_threshold=5.0)

        # Build synthetic history to verify best_drift selection logic
        canvas = np.zeros((400, 400, 3), dtype=np.uint8)
        # Put two contours: one near (110, 110), one further at (150, 150)
        cv2.circle(canvas, (110, 110), 10, (255, 255, 255), -1)
        cv2.circle(canvas, (150, 150), 10, (255, 255, 255), -1)

        anchor = (100, 100)
        # Starting point at (120, 120), drift = 28.28 px
        final_x, final_y = agent.resolve_precision_click(
            master_screenshot=canvas,
            initial_x=120,
            initial_y=120,
            anchor_pt=anchor,
            max_retries=2
        )

        # Refined position must be closer to anchor than initial
        initial_drift = evaluate_coordinate_drift((120, 120), anchor)
        final_drift = evaluate_coordinate_drift((final_x, final_y), anchor)
        self.assertLess(final_drift, initial_drift)
        self.assertAlmostEqual(final_drift, agent.last_closest_drift, delta=1.0)

    def test_early_break_with_partial_refinement(self):
        """
        If attempt 1 refines coordinate towards a contour, but attempt 2 finds no contours,
        the agent must retain attempt 1's refined coordinates rather than reverting to initial.
        """
        agent = VisualHomingAgent(drift_threshold=2.0)
        # Canvas with a single feature near (150, 150)
        canvas = np.zeros((500, 500, 3), dtype=np.uint8)
        cv2.circle(canvas, (150, 150), 8, (255, 255, 255), -1)

        anchor = (145, 145)
        # Initial point is (180, 180), initial drift = 49.5 px
        final_x, final_y = agent.resolve_precision_click(
            master_screenshot=canvas,
            initial_x=180,
            initial_y=180,
            anchor_pt=anchor,
            max_retries=3
        )

        self.assertNotEqual((final_x, final_y), (180, 180))
        self.assertAlmostEqual(final_x, 150, delta=2)
        self.assertAlmostEqual(final_y, 150, delta=2)

    def test_visual_indicators(self):
        canvas = np.zeros((400, 400, 3), dtype=np.uint8)
        cv2.circle(canvas, (200, 200), 20, (255, 255, 255), -1)

        final_x, final_y = self.agent.resolve_precision_click(
            master_screenshot=canvas,
            initial_x=230,
            initial_y=200,
            anchor_pt=(200, 200),
            visualize=True
        )

        self.assertIsNotNone(self.agent.last_visualization)
        self.assertEqual(self.agent.last_visualization.shape, canvas.shape)
        # Ensure indicator was drawn (some non-zero pixels added on visualization canvas)
        self.assertTrue(np.any(self.agent.last_visualization != canvas))

    def test_performance_60fps(self):
        """
        Real-time processing constraint: Solution must operate within 60 FPS
        (budget < 16.6 ms per frame).
        """
        canvas = np.zeros((1080, 1920, 3), dtype=np.uint8)
        cv2.circle(canvas, (960, 540), 25, (255, 255, 255), -1)

        # Warm-up
        self.agent.resolve_precision_click(canvas, 990, 540, anchor_pt=(960, 540))

        times = []
        for _ in range(50):
            t0 = time.perf_counter()
            self.agent.resolve_precision_click(canvas, 990, 540, anchor_pt=(960, 540))
            t1 = time.perf_counter()
            times.append((t1 - t0) * 1000.0)

        avg_latency_ms = sum(times) / len(times)
        max_latency_ms = max(times)

        # Average latency must be < 5ms (far under the 16.6ms 60 FPS threshold)
        self.assertLess(avg_latency_ms, 5.0, f"Average latency {avg_latency_ms:.2f} ms exceeded 5.0 ms target")
        self.assertLess(max_latency_ms, 16.6, f"Max latency {max_latency_ms:.2f} ms exceeded 60 FPS (16.6 ms) frame budget")


if __name__ == "__main__":
    unittest.main()
