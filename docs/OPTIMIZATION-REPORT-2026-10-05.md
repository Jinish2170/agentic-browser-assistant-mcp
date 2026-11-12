# JEV Browser 0.3.0 optimization report

Release 0.3.0 improves native input, readiness checks, screenshot transport and provider preparation while retaining the existing 49-tool MCP inventory. Measured gains below come from disposable local browser fixtures. They do not establish live LLM latency, Claude parity or general task completion rates.

## What changed

- **Native typing:** main-frame input prepares focus and geometry in one browser injection. Replacing an empty field skips the unnecessary select-all keyboard command. Visibility, occlusion, focus redirection and frame ancestry checks remain in place; an uncertain write is never replayed.
- **Form filling:** matching native text/select values are independently verified and returned as `unchanged`, without emitting more input/change events. `skipUnchanged:false` explicitly repeats those events. All-field preflight and partial-outcome handling remain; checkboxes are always driven by their current state. Disabled options and disabled optgroups are rejected.
- **Readiness:** scoped waits now support visible, hidden, attached and detached selector conditions. When selector and text are supplied, both must match. Read-only polling sleeps 50 ms initially, then backs off to 200 ms after 500 ms, with each sleep bounded by the remaining deadline. Access and pending-document checks run on every probe. Invalid selectors fail immediately.
- **Observation:** `includeFrames:false` omits frame discovery when the agent only needs a known task region. The default still includes frames.
- **Images:** agents can request JPEG at quality 30–100, defaulting to 80 for JPEG. PNG remains the default. Both formats become actual MCP/provider image blocks, including inside batches; local helper scripts save the matching file extension.
- **Provider preparation:** immutable tool schemas are compiled once and cached by the selected tool set and advanced-access profile. Definition lengths are cached for context accounting. Credentials, grants, browser observations and conversation history are not cached by this mechanism.
- **Compatibility:** worker protocol 3 prevents an older authenticated worker from executing unsupported commands. Existing pairing remains valid; the worker needs a Chrome extension reload.

The browser wait implementation is worker polling, not an event-driven page observer. Faster early polling spends more DOM probes to reduce detection delay; long waits back off. Provider caching reduces local CPU work rather than network or model reasoning time.

## Matched browser measurements

Node 24.19.0, Chromium 153.0.8010.12, same local fixture with 1,000 sidebar links and a two-field form. Each operation has 10 samples. Field state is reset **outside** timed intervals so empty, existing and unchanged cases remain distinct. The before artifact uses 0.2.0; the after artifact uses the optimized implementation with the final focus checks.

| Operation                                           | 0.2 median / p95, ms | 0.3 median / p95, ms |      Median change |
| --------------------------------------------------- | -------------------: | -------------------: | -----------------: |
| Type into an empty field                            |        16.49 / 17.64 |        11.84 / 12.63 |         28% faster |
| Replace existing text                               |        15.14 / 16.78 |        13.75 / 14.69 |          9% faster |
| Fill two empty fields, verify and observe           |        51.33 / 54.53 |        42.75 / 44.89 |         17% faster |
| Fill two already-correct fields, verify and observe |        52.94 / 55.86 |        24.05 / 25.67 |         55% faster |
| Type and return a full snapshot                     |        41.88 / 50.51 |        36.83 / 47.80 |         12% faster |
| Compound type and scoped observation                |        26.77 / 29.13 |        22.51 / 24.69 |         16% faster |
| Full snapshot alone                                 |        25.10 / 37.32 |        25.46 / 36.48 | No meaningful gain |
| Cold stdio status call                              |      220.28 / 240.29 |      224.85 / 242.67 |            No gain |

Independent two-call field typing had a slightly better median but a worse p95 (42.76 → 58.38 ms). These small sample sets contain scheduling noise; use the larger corpus below to assess compound workflow behavior. Cold process startup remains expensive, so reuse an MCP session instead of starting a new helper process for every action.

On the scoped fixture, omitting frames reduced output from 835 to 741 bytes. Its latency difference, 8.48 → 8.33 ms, is within measurement noise. Full snapshot payload remained 33,696 bytes.

Sources: [matched 0.2 baseline](report-assets/benchmark-prepared-baseline-v02.json), [0.3 browser measurements](report-assets/benchmark-optimized-final-v03.json).

## Screenshot transport

Both formats were captured through the real extension/bridge/MCP path. Each measurement has 10 samples; JPEG uses quality 80. The image-heavy fixture is a synthetic grain/gradient canvas, containing no personal browser content.

| Fixture / format                 | Image bytes | Median capture and transport, ms | p95, ms |
| -------------------------------- | ----------: | -------------------------------: | ------: |
| Text page, PNG                   |      52,178 |                            33.72 |  358.86 |
| Text page, JPEG                  |      52,858 |                            33.63 |   34.19 |
| Synthetic image-heavy page, PNG  |   1,772,459 |                           334.39 |  373.25 |
| Synthetic image-heavy page, JPEG |     309,680 |                            49.30 |   56.85 |

JPEG reduced image-heavy fixture bytes by **82.5%** and median capture/transport time by **85.3%**. It was slightly larger on the text page. The text-page PNG tail is noisy; it is not evidence of a universal codec latency advantage. JPEG is lossy, and downstream model accuracy on compressed text was not evaluated. Use PNG for precise text/detail and choose JPEG when image transport is costly.

The format and quality options use Chrome's named [`Page.captureScreenshot` API](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot). Observation/input preparation uses the extension's [`chrome.scripting` API](https://developer.chrome.com/docs/extensions/reference/api/scripting).

## Provider CPU work

The local benchmark uses 201 fixture conversation messages, approximately 350,000 characters, with 100 samples per measurement and no API calls. Each sample averages five invocations after warm-up.

| Operation             | Before median, ms | Cached median, ms |
| --------------------- | ----------------: | ----------------: |
| Core tool definitions |            0.3080 |            0.0035 |
| Full tool definitions |            0.2917 |            0.0002 |
| Context accounting    |            1.0370 |            0.6084 |

Core definition lookup is approximately 88 times faster; context accounting uses about 41% less local CPU time. The absolute saving is under a millisecond here. The new definitions are slightly larger because they describe the added options. History serialization is still linear in history size, and first-time schema compilation still occurs at startup. No live provider latency improvement is claimed.

Sources: [before](report-assets/provider-benchmark-before-v03.json), [cached](report-assets/provider-benchmark-cached-v03.json). Reproduce with `npm run benchmark:provider`.

## Repeated task corpus

The same seed, `20261007`, was run before and after against 100 generated form workflows plus table extraction, six-tab concurrent observation and popup/group adoption cases. Both releases passed **103/103**. The independent server grader checked every submitted field and required exactly one trusted form submission. Policies are deterministic expert workflows: **zero model calls**.

| Stage                                       | 0.2 median / p95, ms | 0.3 median / p95, ms |
| ------------------------------------------- | -------------------: | -------------------: |
| Native form fill                            |        75.04 / 98.00 |        65.27 / 93.01 |
| Compound readiness wait                     |      209.30 / 411.10 |      165.10 / 220.60 |
| Whole action–wait–observe step              |      255.64 / 451.31 |      204.50 / 291.13 |
| Complete independently graded form workflow |            438 / 624 |            374 / 477 |

The compound step median improved by **20%**, with a **35%** lower p95. Complete fixture form workflows improved by **15%** at the median and **24%** at p95. Extraction, tab creation and status remain broadly similar. These are repeated seeds of the existing task families, not 103 new real-world tasks.

Sources: [0.2 matched corpus](report-assets/evaluation-foreground-step-release-v02-20261007-100.json), [0.3 matched corpus](report-assets/evaluation-optimized-v03-20261007-100.json). Reproduce with `JEV_EVAL_FOREGROUND=1 JEV_EVAL_ROUNDS=100 JEV_EVAL_SEED=20261007 node scripts/evaluate.mjs label` after building.

## Regression checks and issues resolved

- **58 unit/integration tests passed.** Coverage includes immutable provider definitions and advanced-profile isolation, mixed PNG/JPEG provider wire formats, unchanged-value behavior and bounded wait deadlines/navigation/access revocation.
- **The full disposable-profile extension/bridge/stdio integration suite passed.** It checked scoped combined predicates, all four selector states, immediate invalid-selector failures, matching-value event suppression and forced events, disabled optgroups, occluded typing, focus redirection, optional frame metadata, and actual JPEG MIME/signature delivery.
- **100 fresh nested cross-site frame click samples passed**, with one trusted click per sample and no replay, alongside existing upload, download, diagnostics, groups, memory, persistence, UI and provider fixture checks.
- Syntax, formatting, extension build and deterministic packaging are release checks. Public packages exclude local credentials and raw task artifacts.

An early benchmark repeatedly filled already-correct fields without distinguishing that state from empty fields. The benchmark now prepares each state outside the timed interval, and the report separates the two behaviors. A browser test also assumed `[broken` was invalid CSS; Chromium accepts it as a selector with no matches. The test was corrected to `[` and now verifies immediate syntax failure. Neither assumption is used in the published results.

The deployed user profile is not used for benchmark activity. Integration tests run in disposable Chromium profiles and local fixture sites. Windows/macOS, enterprise Chrome policies, live Jev/provider costs, third-party bot challenges and comparative Claude task completion remain unmeasured.

## Using the improved tools

Arguments below are examples; obtain a real tab ID and fresh element references from the browser tools.

```json
{ "tabId": 123, "scopeSelector": "main", "includeFrames": false }
```

Use those arguments with `browser_snapshot` to observe a known task region without frame discovery.

```json
{
  "tabId": 123,
  "scopeSelector": "main",
  "selector": ".saving",
  "condition": "hidden",
  "timeoutMs": 8000
}
```

Use `browser_wait` to wait for a saving indicator to disappear. A selector plus text requires both conditions to match.

```json
{ "tabId": 123, "format": "jpeg", "quality": 80 }
```

Use `browser_screenshot` when a smaller photographic image is appropriate; omit format for lossless PNG. Use `browser_fill_form.skipUnchanged:false` only when a page specifically needs repeat input/change events.

## Installation

Load or reload the unpacked extension at `dist/extension` in Chrome's extension page. Pairing is retained. The bridge and extension versions must both be 0.3.0; legacy workers are blocked from dispatching commands until reloaded. Packaged source and unpacked-extension ZIPs are in `dist`, with SHA-256 checksums in `dist/release.json`.
