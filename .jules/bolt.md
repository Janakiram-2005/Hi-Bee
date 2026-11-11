
## 2025-02-12 - Wrap complex components in React.memo for list item optimization
**Learning:** In highly complex and deeply nested list rendering contexts such as chat interfaces containing Markdown parsers (e.g. `RunMessages`), components like `HumanTextMessage`, `AssistantTextMessage`, `ScreenshotMessage`, and `ThoughtChain` do not get automatically memoized and will unnecessarily re-render on every state change unless wrapped with `React.memo()`. This leads to excessive CPU usage and UI blocking, especially for Markdown components.
**Action:** When working on complex repeating UI items, evaluate components rendered in arrays and explicitly wrap them in `React.memo` to prevent unnecessary performance bottlenecks.
