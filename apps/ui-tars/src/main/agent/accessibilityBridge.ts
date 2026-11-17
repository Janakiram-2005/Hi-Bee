/*
 * Synthetic OS Accessibility Overlay Bridge for VLM outputs (TypeScript / Electron Agent)
 */

let logger: any = console;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mainLogger = require('@main/logger');
  if (mainLogger && mainLogger.logger) {
    logger = mainLogger.logger;
  }
} catch {
  // Fallback to console logger if module alias is not resolved
}

export interface SyntheticNodeData {
  nodeId: string;
  label: string;
  role: string;
  boundingBox: [number, number, number, number];
  actionType: string;
  announcement: string;
  isClickThrough: boolean;
  registeredAtMs: number;
  createdAt: number;
}

const ROLE_MAP: Record<string, string> = {
  button: 'Button',
  btn: 'Button',
  textbox: 'Edit',
  text: 'Edit',
  input: 'Edit',
  link: 'Hyperlink',
  checkbox: 'CheckBox',
  check: 'CheckBox',
  combobox: 'ComboBox',
  dropdown: 'ComboBox',
  menuitem: 'MenuItem',
  tab: 'TabItem',
  image: 'Image',
};

export class AccessibilityBridgeTS {
  private _nodes: Map<string, SyntheticNodeData> = new Map();
  private _eventHistory: Array<Record<string, any>> = [];
  private _counter = 0;
  private _cleanupInterval: NodeJS.Timeout | null = null;
  private _autoCleanupDelayMs: number;

  constructor(autoCleanupDelayMs: number = 200) {
    this._autoCleanupDelayMs = autoCleanupDelayMs;
    this._startWatchdogCleaner();
  }

  public registerTarget(
    label: string,
    role: string,
    coordinates: number[],
    actionType: string = 'click',
  ): SyntheticNodeData {
    const startT = performance.now();
    this._counter += 1;
    const nodeId = `synth_a11y_${Date.now()}_${this._counter}`;

    const normalizedRole =
      ROLE_MAP[(role || 'button').toLowerCase()] ||
      (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Button');

    let x = 0,
      y = 0,
      w = 20,
      h = 20;
    if (coordinates.length === 2) {
      x = Math.round(coordinates[0]);
      y = Math.round(coordinates[1]);
    } else if (coordinates.length >= 4) {
      x = Math.round(coordinates[0]);
      y = Math.round(coordinates[1]);
      w = Math.round(coordinates[2]);
      h = Math.round(coordinates[3]);
    }

    const elapsedMs = performance.now() - startT;
    const announcement = `${label || 'Unlabeled element'}, ${normalizedRole.toLowerCase()}`;

    const node: SyntheticNodeData = {
      nodeId,
      label: label || 'Unlabeled element',
      role: normalizedRole,
      boundingBox: [x, y, w, h],
      actionType,
      announcement,
      isClickThrough: true,
      registeredAtMs: elapsedMs,
      createdAt: performance.now(),
    };

    this._nodes.set(nodeId, node);
    this.fireAccessibilityEvents(node);

    logger.info(
      `[AccessibilityBridge] Registered synthetic node '${nodeId}' ("${node.label}", ${node.role}) at (${x}, ${y}) in ${elapsedMs.toFixed(2)} ms`,
    );

    return node;
  }

  public fireAccessibilityEvents(node: SyntheticNodeData): Record<string, any> {
    const eventData = {
      nodeId: node.nodeId,
      announcement: node.announcement,
      role: node.role,
      label: node.label,
      eventType: 'LiveRegionChanged',
      focusEvent: 'AutomationFocusChanged',
      timestamp: Date.now(),
    };

    this._eventHistory.push(eventData);

    logger.info(`[ScreenReader] Announcement: "${node.announcement}" (Focus Event Fired)`);
    return eventData;
  }

  public unregisterTarget(nodeId: string): boolean {
    const existed = this._nodes.has(nodeId);
    if (existed) {
      this._nodes.delete(nodeId);
      logger.info(`[AccessibilityBridge] Unregistered synthetic node '${nodeId}'`);
    }
    return existed;
  }

  public cleanupAll(): number {
    const count = this._nodes.size;
    this._nodes.clear();
    return count;
  }

  public getActiveNodes(): SyntheticNodeData[] {
    return Array.from(this._nodes.values());
  }

  public getEventHistory(): Array<Record<string, any>> {
    return [...this._eventHistory];
  }

  private _startWatchdogCleaner(): void {
    this._cleanupInterval = setInterval(() => {
      const now = performance.now();
      const expired: string[] = [];
      this._nodes.forEach((node, id) => {
        if (now - node.createdAt >= this._autoCleanupDelayMs) {
          expired.push(id);
        }
      });
      expired.forEach((id) => this.unregisterTarget(id));
    }, 50);
  }

  public destroy(): void {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.cleanupAll();
  }
}

let defaultBridgeInstance: AccessibilityBridgeTS | null = null;

export function getAccessibilityBridgeTS(): AccessibilityBridgeTS {
  if (!defaultBridgeInstance) {
    defaultBridgeInstance = new AccessibilityBridgeTS();
  }
  return defaultBridgeInstance;
}
