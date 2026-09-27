"""
Unit tests for Synthetic OS Accessibility Overlay Bridge
=========================================================
"""

import time
import pytest
from os_dom_engine.accessibility_bridge import (
    AccessibilityBridge,
    SyntheticAccessibilityNode,
    get_accessibility_bridge,
)


class TestAccessibilityBridge:

    def setup_method(self):
        self.bridge = AccessibilityBridge(auto_cleanup_delay_s=0.150)

    def teardown_method(self):
        self.bridge.stop()

    def test_registration_latency_under_10ms(self):
        """Requirement: Synthetic nodes register within 10 milliseconds of model action plan output."""
        start = time.perf_counter()
        node = self.bridge.register_target(
            label="Submit Order",
            role="button",
            coordinates=(450, 320, 100, 40),
            action_type="click",
        )
        total_ms = (time.perf_counter() - start) * 1000.0

        assert total_ms < 10.0, f"Registration latency was {total_ms:.2f} ms (expected < 10 ms)"
        assert node.registered_at_ms < 10.0
        assert node.label == "Submit Order"
        assert node.role == "Button"
        assert node.x == 450
        assert node.y == 320
        assert node.width == 100
        assert node.height == 40

    def test_screen_reader_announcement_and_events(self):
        """Requirement: Screen readers announce element labels and roles during actions."""
        node = self.bridge.register_target(
            label="Search input",
            role="textbox",
            coordinates=(100, 50),
            action_type="type",
        )

        assert node.announcement == "Search input, edit"
        history = self.bridge.get_event_history()
        assert len(history) >= 1
        last_event = history[-1]
        assert last_event["announcement"] == "Search input, edit"
        assert last_event["event_type"] == "LiveRegionChanged"
        assert last_event["focus_event"] == "AutomationFocusChanged"

    def test_non_obstruction_click_through(self):
        """Constraint: Synthetic nodes must not obstruct native mouse click event propagation."""
        node = self.bridge.register_target(
            label="Interactive Card",
            role="button",
            coordinates=(200, 200, 50, 50),
        )
        assert node.is_click_through is True

    def test_manual_unregistration(self):
        """Requirement: Remove synthetic accessibility nodes once mouse/keyboard events complete."""
        node = self.bridge.register_target(
            label="Close Dialog",
            role="button",
            coordinates=(800, 100),
        )
        assert len(self.bridge.get_active_nodes()) == 1

        success = self.bridge.unregister_target(node.node_id)
        assert success is True
        assert len(self.bridge.get_active_nodes()) == 0

    def test_auto_cleanup_within_200ms(self):
        """Constraint: Synthetic nodes must unregister within 200ms of action completion."""
        node = self.bridge.register_target(
            label="Temporary Banner",
            role="link",
            coordinates=(300, 400),
        )
        assert len(self.bridge.get_active_nodes()) == 1

        # Wait for auto-cleanup delay (150 ms configured in setup)
        time.sleep(0.250)
        assert len(self.bridge.get_active_nodes()) == 0

    def test_context_manager_scoped_node(self):
        """Verify active_target context manager registers and cleans up automatically."""
        with self.bridge.active_target(
            label="Confirm Payment",
            role="button",
            coordinates=(500, 600),
            action_type="click",
        ) as node:
            assert node.label == "Confirm Payment"
            assert len(self.bridge.get_active_nodes()) == 1

        # Node must be unregistered upon exiting context block
        assert len(self.bridge.get_active_nodes()) == 0
