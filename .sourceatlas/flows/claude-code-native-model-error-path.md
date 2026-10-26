Claude Code native model error / compact / fallback
====================================================

Entry Point: Claude Code 2.1.310 bun ELF `/home/admin/.local/share/claude/versions/2.1.310`
REA: gnu.objdump file_headers → elf64-x86-64, sha256 `b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56`
Carve: `.bun` section @ file 0x06e14000 / VMA 0x7016000 → `/tmp/cc-native-extract/`
Ghidra `search_strings` timed out on the 291MB ELF; rizin ENOENT.

┌──────┬──────────────────────────────────────────────┬─────────────────────────────────┐
│ Step │ Operation                                    │ Location                        │
├──────┼──────────────────────────────────────────────┼─────────────────────────────────┤
│  1   │ HTTP / stream error classified               │ bun P_r httpError               │
│  2   │ 529 overloaded → Jet retry same model        │ P_r: e===529 return Jet()       │
│  3   │ 400 prompt-too-long compact regex            │ kg[0] ANTHROPIC_TOO_LONG        │
│  4   │ other 5xx + fallbackModelCouldHelp           │ useFallbackModel                │
│  5   │ fallback copy                                │ Gf("overloaded"|"server_error") │
│  6   │ unknown-id window                            │ autoCompactWindow / behavesAs   │
└──────┴──────────────────────────────────────────────┴─────────────────────────────────┘

Flow Diagram:
httpError
  → P_r(status)
      → 529 .............. Jet() retry same model
      → 429 persistent ... retry
      → fallbackCouldHelp  useFallbackModel  ["due to high demand"]
      → 408|409|429|>=500  fL() retry then maybe fallback
      → 404 no-stream .... kRe()
      → else ............. fail
compact
  → kg = [/^prompt is too long: \d+ tokens > \d+ maximum$/, ...]
  → unknown model: assumed window unless modelSettings.autoCompactWindow
  → picker behavesAs: inherit that native model's catalog window (Opus 1M)

TeamClaude custom path (before scaffold):
createProxyServer
  → forwardRequest
      → upstreamFetch(custom adapter / CLIProxy)
          → overflow 5xx  → 400 prompt-too-long (context-overflow-relay)  [done]
          → JSON 5xx      → relay 500  → CC useFallbackModel  [gap]
          → empty 5xx     → circuit + hop

TeamClaude custom path (scaffold):
          → overflow      → 400 invalid_request_error compact regex
          → JSON 5xx      → 529 overloaded_error (native-overload-scaffold)
          → empty/down    → circuit + hop

Notable Patterns:
├── 🌐 API  native Anthropic vs custom adapter classified by isNativeAnthropicUpstream
├── ⚠️ RISK  behavesAs: claude-opus-5 on gpt-6-astra inherits 1M window
├── ⚠️ RISK  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 waits for API error
└── ⚠️ RISK  gateway 502 rewrite of overflow never matches kg → no compact

───────────────────────────────────
📊 Mode: Error Path | Confidence: ~90% | Depth: 5
✅ Verified: bun P_r string, kg regex, teamclaude src/server.js 5xx peek
💾 Saved to .sourceatlas/flows/claude-code-native-model-error-path.md
───────────────────────────────────
