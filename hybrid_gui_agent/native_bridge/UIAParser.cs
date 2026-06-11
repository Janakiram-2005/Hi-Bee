using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace UIAutomationBridge
{
    class UIAParser
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        static int Main(string[] args)
        {
            try
            {
                // Force DPI Awareness to prevent coordinate shifting between logical/physical coordinates during scanning
                try { SetProcessDPIAware(); } catch {}

                // Parse Command-line arguments
                bool invokeMode = false;
                IntPtr hwnd = IntPtr.Zero;
                string targetId = null;

                if (args.Length >= 2 && args[0].Equals("headless_invoke", StringComparison.OrdinalIgnoreCase))
                {
                    string target = args[1];
                    bool success = TryHeadlessInvoke(target);
                    return success ? 0 : 1;
                }

                if (args.Length >= 3 && args[0].Equals("invoke", StringComparison.OrdinalIgnoreCase))
                {
                    invokeMode = true;
                    hwnd = new IntPtr(long.Parse(args[1]));
                    targetId = args[2];
                }
                else if (args.Length >= 1)
                {
                    hwnd = new IntPtr(long.Parse(args[0]));
                }
                else
                {
                    hwnd = GetForegroundWindow();
                }

                if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                {
                    Console.WriteLine("{\"error\": \"Invalid or missing window handle\", \"code\": \"INVALID_HWND\"}");
                    return 1;
                }

                if (invokeMode)
                {
                    return ExecuteDirectInvoke(hwnd, targetId);
                }
                else
                {
                    return RunScanner(hwnd);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("{{\"error\": \"Internal parser error: {0}\", \"code\": \"ERROR\"}}", EscapeJsonString(ex.Message));
                return 1;
            }
        }

        private static int RunScanner(IntPtr hwnd)
        {
            // 1. Get window boundaries at the START of scanning
            RECT rectStart;
            if (!GetWindowRect(hwnd, out rectStart))
            {
                Console.WriteLine("{\"error\": \"Failed to get window rect before scanning\", \"code\": \"RECT_ERROR\"}");
                return 1;
            }

            // 2. Configure CacheRequest to avoid slow COM roundtrips
            CacheRequest cacheRequest = new CacheRequest();
            cacheRequest.Add(AutomationElement.NameProperty);
            cacheRequest.Add(AutomationElement.AutomationIdProperty);
            cacheRequest.Add(AutomationElement.ControlTypeProperty);
            cacheRequest.Add(AutomationElement.BoundingRectangleProperty);
            cacheRequest.Add(AutomationElement.IsEnabledProperty);
            cacheRequest.Add(AutomationElement.IsOffscreenProperty);

            // Add standard interaction patterns for pre-fetching
            cacheRequest.Add(InvokePattern.Pattern);
            cacheRequest.Add(ValuePattern.Pattern);
            cacheRequest.Add(SelectionItemPattern.Pattern);
            cacheRequest.Add(TogglePattern.Pattern);
            cacheRequest.Add(ExpandCollapsePattern.Pattern);

            // Include root element and descendants in search cache
            cacheRequest.TreeScope = TreeScope.Element | TreeScope.Descendants;

            AutomationElement rootElement = null;
            AutomationElementCollection elements = null;

            // Activate cache scope
            using (cacheRequest.Activate())
            {
                rootElement = AutomationElement.FromHandle(hwnd);
                if (rootElement == null)
                {
                    Console.WriteLine("{\"error\": \"Could not retrieve automation element for handle\", \"code\": \"ELEMENT_ERROR\"}");
                    return 1;
                }

                // Batch-retrieves all children under the cached scope
                elements = rootElement.FindAll(TreeScope.Subtree, Condition.TrueCondition);
            }

            // 3. Get window boundaries at the END of scanning to check for movement/layout shifts
            RECT rectEnd;
            if (GetWindowRect(hwnd, out rectEnd))
            {
                int deltaLeft = Math.Abs(rectStart.Left - rectEnd.Left);
                int deltaTop = Math.Abs(rectStart.Top - rectEnd.Top);
                int deltaRight = Math.Abs(rectStart.Right - rectEnd.Right);
                int deltaBottom = Math.Abs(rectStart.Bottom - rectEnd.Bottom);

                // If window moved/resized by > 5 pixels, reject to prevent coordinate mismatch
                if (deltaLeft > 5 || deltaTop > 5 || deltaRight > 5 || deltaBottom > 5)
                {
                    Console.WriteLine("{\"error\": \"Window boundaries mutated during parsing\", \"code\": \"MUTATION_DETECTED\"}");
                    return 2;
                }
            }

            // 4. Pruning and JSON formatting
            List<string> serializedElements = new List<string>();

            foreach (AutomationElement element in elements)
            {
                try
                {
                    // Basic filters: Element must be enabled and on-screen
                    if (!element.Cached.IsEnabled || element.Cached.IsOffscreen)
                        continue;

                    var rect = element.Cached.BoundingRectangle;
                    if (rect.Width <= 0 || rect.Height <= 0)
                        continue;

                    var controlType = element.Cached.ControlType;

                    // Prune obvious layout frames and structural containers
                    if (controlType == ControlType.Window || 
                        controlType == ControlType.Pane || 
                        controlType == ControlType.Group || 
                        controlType == ControlType.Header || 
                        controlType == ControlType.Separator || 
                        controlType == ControlType.ScrollBar)
                    {
                        // Check if it has any key control patterns. If not, drop it.
                        if (!HasAnyPatternCached(element))
                            continue;
                    }

                    // Extract properties
                    string name = element.Cached.Name ?? "";
                    string autoId = element.Cached.AutomationId ?? "";
                    string typeName = controlType.ProgrammaticName.Replace("ControlType.", "");

                    // Map supported patterns to strings
                    List<string> patterns = new List<string>();
                    if (SupportsPattern(element, InvokePattern.Pattern)) patterns.Add("invoke");
                    if (SupportsPattern(element, ValuePattern.Pattern)) patterns.Add("value");
                    if (SupportsPattern(element, SelectionItemPattern.Pattern)) patterns.Add("selection_item");
                    if (SupportsPattern(element, TogglePattern.Pattern)) patterns.Add("toggle");
                    if (SupportsPattern(element, ExpandCollapsePattern.Pattern)) patterns.Add("expand_collapse");

                    // Build manual JSON to avoid library overhead
                    string jsonElement = string.Format(
                        "{{\"name\":\"{0}\",\"id\":\"{1}\",\"type\":\"{2}\",\"rect\":[{3},{4},{5},{6}],\"patterns\":[{7}]}}",
                        EscapeJsonString(name),
                        EscapeJsonString(autoId),
                        EscapeJsonString(typeName),
                        (int)rect.X,
                        (int)rect.Y,
                        (int)rect.Width,
                        (int)rect.Height,
                        string.Join(",", patterns.Select(p => "\"" + p + "\"").ToArray())
                    );

                    serializedElements.Add(jsonElement);
                }
                catch
                {
                    // Skip element if COM property access throws (e.g. element destroyed)
                }
            }

            // Output JSON stream as a single continuous block
            Console.WriteLine("[{0}]", string.Join(",", serializedElements.ToArray()));
            return 0;
        }

        private static int ExecuteDirectInvoke(IntPtr hwnd, string targetId)
        {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            if (root == null)
            {
                Console.WriteLine("{\"error\": \"Could not retrieve window handle\", \"success\": false}");
                return 1;
            }

            // Find matching element by AutomationId or Name
            Condition cond = new OrCondition(
                new PropertyCondition(AutomationElement.AutomationIdProperty, targetId),
                new PropertyCondition(AutomationElement.NameProperty, targetId)
            );

            AutomationElement target = root.FindFirst(TreeScope.Subtree, cond);
            if (target == null)
            {
                Console.WriteLine("{{\"error\": \"Element with ID or Name '{0}' not found\", \"success\": false}}", EscapeJsonString(targetId));
                return 1;
            }

            // Perform invocation
            bool success = false;
            string patternUsed = "none";

            try
            {
                object pattern;
                if (target.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                {
                    ((InvokePattern)pattern).Invoke();
                    success = true;
                    patternUsed = "invoke";
                }
                else if (target.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                {
                    ((TogglePattern)pattern).Toggle();
                    success = true;
                    patternUsed = "toggle";
                }
                else if (target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                {
                    ((SelectionItemPattern)pattern).Select();
                    success = true;
                    patternUsed = "selection_item";
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("{{\"error\": \"Invocation failed: {0}\", \"success\": false}}", EscapeJsonString(ex.Message));
                return 1;
            }

            if (success)
            {
                Console.WriteLine("{{\"success\": true, \"pattern\": \"{0}\"}}", patternUsed);
                return 0;
            }
            else
            {
                Console.WriteLine("{\"error\": \"No compatible control pattern found for direct invocation\", \"success\": false}");
                return 1;
            }
        }

        public static bool TryHeadlessInvoke(string targetElementIdOrName)
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                {
                    Console.WriteLine("{\"error\": \"No active foreground window found\", \"success\": false}");
                    return false;
                }
                return TryHeadlessInvoke(hwnd, targetElementIdOrName);
            }
            catch (Exception ex)
            {
                Console.WriteLine("{{\"error\": \"Headless invoke exception: {0}\", \"success\": false}}", EscapeJsonString(ex.Message));
                return false;
            }
        }

        public static bool TryHeadlessInvoke(IntPtr hwnd, string targetElementIdOrName)
        {
            try
            {
                if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                {
                    Console.WriteLine("{\"error\": \"Invalid window handle\", \"success\": false}");
                    return false;
                }

                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null)
                {
                    Console.WriteLine("{\"error\": \"Could not retrieve automation element for handle\", \"success\": false}");
                    return false;
                }

                Condition cond = new OrCondition(
                    new PropertyCondition(AutomationElement.AutomationIdProperty, targetElementIdOrName),
                    new PropertyCondition(AutomationElement.NameProperty, targetElementIdOrName)
                );

                AutomationElement target = root.FindFirst(TreeScope.Subtree, cond);
                if (target == null)
                {
                    Console.WriteLine("{{\"error\": \"Element '{0}' not found\", \"success\": false}}", EscapeJsonString(targetElementIdOrName));
                    return false;
                }

                object pattern;
                // Check native InvokePattern or InvokePatternIdentifiers (mapped to InvokePattern.Pattern in UIAutomationClient)
                if (target.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                {
                    ((InvokePattern)pattern).Invoke();
                    Console.WriteLine("{\"success\": true, \"pattern\": \"invoke\"}");
                    return true;
                }
                else
                {
                    Console.WriteLine("{\"error\": \"No compatible invoke pattern found for headless execution\", \"success\": false}");
                    return false;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("{{\"error\": \"Headless invoke execution failed: {0}\", \"success\": false}}", EscapeJsonString(ex.Message));
                return false;
            }
        }

        private static bool HasAnyPatternCached(AutomationElement element)
        {
            return SupportsPattern(element, InvokePattern.Pattern) ||
                   SupportsPattern(element, ValuePattern.Pattern) ||
                   SupportsPattern(element, SelectionItemPattern.Pattern) ||
                   SupportsPattern(element, TogglePattern.Pattern) ||
                   SupportsPattern(element, ExpandCollapsePattern.Pattern);
        }

        private static bool SupportsPattern(AutomationElement element, AutomationPattern pattern)
        {
            try
            {
                object pat;
                return element.TryGetCachedPattern(pattern, out pat);
            }
            catch
            {
                return false;
            }
        }

        private static string EscapeJsonString(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            foreach (char c in value)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 32)
                        {
                            sb.AppendFormat("\\u{0:x4}", (int)c);
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
