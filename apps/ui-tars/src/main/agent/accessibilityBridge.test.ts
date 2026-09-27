import assert from 'node:assert';
import { AccessibilityBridgeTS, SyntheticNodeData } from './accessibilityBridge';

async function runTests() {
  console.log('Running AccessibilityBridgeTS test suite...');
  const bridge = new AccessibilityBridgeTS(150);

  try {
    // Test 1: Latency < 10 ms
    const start = performance.now();
    const node: SyntheticNodeData = bridge.registerTarget(
      'Submit Order',
      'button',
      [100, 200, 80, 30],
      'click',
    );
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 10, `Registration took ${elapsed} ms (expected < 10 ms)`);
    assert.ok(node.registeredAtMs < 10);
    assert.strictEqual(node.label, 'Submit Order');
    assert.strictEqual(node.role, 'Button');
    assert.deepStrictEqual(node.boundingBox, [100, 200, 80, 30]);
    assert.strictEqual(node.isClickThrough, true);
    console.log('✔ Test 1: Latency < 10 ms passed');

    // Test 2: Screen reader announcement and event firing
    const node2 = bridge.registerTarget(
      'Search input',
      'textbox',
      [50, 50],
      'type',
    );
    assert.strictEqual(node2.announcement, 'Search input, edit');
    const history = bridge.getEventHistory();
    assert.ok(history.length >= 2);
    const lastEvent = history[history.length - 1];
    assert.strictEqual(lastEvent.announcement, 'Search input, edit');
    assert.strictEqual(lastEvent.eventType, 'LiveRegionChanged');
    assert.strictEqual(lastEvent.focusEvent, 'AutomationFocusChanged');
    console.log('✔ Test 2: Screen reader announcements passed');

    // Test 3: Manual unregistration
    const node3 = bridge.registerTarget('Close Button', 'button', [10, 10]);
    assert.strictEqual(bridge.getActiveNodes().length, 3);
    const success = bridge.unregisterTarget(node3.nodeId);
    assert.strictEqual(success, true);
    assert.strictEqual(bridge.getActiveNodes().length, 2);
    console.log('✔ Test 3: Manual unregistration passed');

    // Test 4: Auto-cleanup within 200 ms
    const node4 = bridge.registerTarget('Banner', 'link', [30, 30]);
    assert.ok(bridge.getActiveNodes().length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.strictEqual(bridge.getActiveNodes().length, 0);
    console.log('✔ Test 4: Auto-cleanup within 200 ms passed');

    console.log('All AccessibilityBridgeTS tests passed successfully!');
  } finally {
    bridge.destroy();
  }
}

runTests().catch((err) => {
  console.error('AccessibilityBridgeTS test failed:', err);
  process.exit(1);
});
