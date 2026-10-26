Codex models into Claude Code native recovery
=============================================

Entry Point: src/server.js forwardRequest custom-upstream 5xx peek
Query: /sourceatlas:flow "how Claude Code native models recover from overflow and overload vs Codex gpt56"

┌──────┬──────────────────────────────────────────────┬─────────────────────────────────┐
│ Step │ Operation                                    │ Location                        │
├──────┼──────────────────────────────────────────────┼─────────────────────────────────┤
│  1   │ Classify native vs custom upstream           │ isNativeAnthropicUpstream       │
│  2   │ Peek 5xx/413 body (clone or .text)           │ src/server.js 5xx block         │
│  3   │ Map to native envelope                       │ toNativeAnthropicClientError    │
│  4   │ Overflow → 400 compact regex                 │ anthropicPromptTooLongBody      │
│  5   │ JSON 5xx → 529 Overloaded                    │ anthropicOverloadedBody         │
│  6   │ Empty/unavailable 5xx → circuit              │ isCustomAdapterDown             │
│  7   │ Client compact window                        │ modelSettings.autoCompactWindow │
│  8   │ Do not behavesAs Opus/Sonnet for Codex ids   │ CODEX_PICKER_IDS                │
└──────┴──────────────────────────────────────────────┴─────────────────────────────────┘

Flow Diagram:
Claude Code (custom model id)
  → TeamClaude createProxyServer
      → exclusive route gpt → codex-gpt56
          → CLIProxy / Codex
              → overflow     [API] → 400 prompt is too long: N > M
              → app 5xx      [API] → 529 overloaded_error
              → path down    [API] → circuit + hop (empty 5xx)
  → Claude Code P_r / kg
      → compact on 400 regex
      → Jet retry on 529
      → fallbackModel only after fL exhausts or non-529 5xx

Windows (must match both sides):
├── gpt-6-astra / claude-gpt-6-astra     258400
├── gpt-6.1-sol                          500000
├── gpt-6-sol / gpt-6-luna / terra       272000
└── claude-gpt-5.6-sol / terra           272000

───────────────────────────────────
📊 Mode: Error Path + Standard | Confidence: ~88% | Depth: 5
✅ Verified: src/anthropic-native-scaffold.js, src/context-overflow.js, src/server.js
💾 Saved to .sourceatlas/flows/codex-to-claude-code-scaffold.md
───────────────────────────────────
