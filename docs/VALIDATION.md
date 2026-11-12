# Validation

Current 0.4.1 validation completed on 6 October 2026 using Node 24 and Playwright's Chromium. The tested source and lockfile are part of the deliverable.

## Automated checks

The suite includes 82 unit/integration tests for schema validation, origin grants, read-only/advanced capability enforcement, upload-root and symlink boundaries, bridge authentication, hostile Host/Origin rejection, profile exclusivity, unknown-outcome timeouts, Jev wire format/confidence handling, provider conversation continuity, cancellation, evidence requirements, step budgets and private key persistence, multi-tab overlap and same-tab locks, batch preflight validation, concurrent memory writes, restart interruption markers, skill path confinement, long-context summaries/native canonical compaction, checkpoint image handling and mid-task user corrections.

The browser integration suite exercises the actual unpacked extension, local bridge and stdio MCP SDK client in a disposable Chromium profile. It covers:

- Compact/scoped DOM observations, role/name filtering, hidden-text filtering, password-value redaction, stale refs and open shadow roots.
- Preflighted native form fill, partial outcome preservation, checkbox state, scoped shadow observations and compound action/wait/verification.
- Explicit readiness predicates while unrelated image loading remains incomplete.
- Trusted mouse input, native typing, Enter submission, native selects, hover, scroll, drag and canvas clicks.
- Frame snapshots and target-occlusion rejection.
- Advanced-access gating, JavaScript evaluation, upload confinement and JavaScript dialogs.
- Direct managed download completion and ownership checks, tab pin/unpin/mute and window resizing.
- 100 freshly navigated nested cross-site frame clicks, with exactly one trusted click per sample and no action replay.
- Same-site iframe reference clicks; nested cross-site reference clicks and typing through scaled frames; unsupported-transform rejection; parent-overlay detection; all-site grants, explicit revocation and paused capability inspection.
- Download events, read-only interaction denial and unauthorized destination origins.
- The MCP handshake, 50-tool inventory, screenshot image results and task-status tool.
- Side-panel task submission, LLM/Jev fixture integration, form completion and cited final evidence.
- Accessibility names and password omission, DevTools console/network capture with query stripping, advanced same-origin response bodies, performance metrics and viewport emulation.
- Visible default JEV Browser groups, per-window reuse, rename/color, collapse/expand, explicit grouping, ungroup, ordinary-tab opt-out and recreation after the last member closes.
- Concurrent observations of multiple real tabs, local skill listing through MCP, conversation transcript and explicit reusable-fact saving through the UI.
- Bridge restart restoration of conversations, saved facts and task outcomes.
- Emergency pause/resume and tab creation/navigation/history/close.

Additional unit coverage includes structured ledger restart uncertainty, provider tool category loading/advanced gating, conditional bounded workspace views, endpoint-bound credentials, editable long-task budgets, legacy-worker version negotiation and persistent JSONL startup/input handling.

## Independent fixture corpus

Three seeded 100-workflow runs each passed 103/103 cases (two background runs and one release foreground-step run): 100 independently graded form submissions, structured native/shadow table extraction, six-tab concurrent observations and popup discovery/group adoption. These are three seeds of the same task families, not 309 distinct real-world tasks. The grader reads the fixture server's record, validates every field and requires exactly one trusted submission. Additional 20-workflow stage/foreground experiments passed 23/23 cases each.

The first pre-fix corpus run passed 3/43: all 40 form cases stopped before input because native select labels included option text. After correcting label extraction, the 100-workflow runs passed. The original failure artifact is preserved in the report assets.

All corpus policies are deterministic expert workflows with **zero model calls**. Passing these tests establishes browser contracts, not live agent intelligence or generalized task completion.

Syntax and formatting checks are also available through `npm run check` and `npm run format:check`. Build output is generated with esbuild.

## What these results establish

They establish integration correctness for the tested fixtures and boundary cases. The browser input is real, and the extension/bridge/MCP path is real. The main integration suite uses fixture model responses. Separate live Jev and Token Harbor tests are documented in the [live report](JEV-LIVE-REPORT-2026-10-06.md); neither fixture nor live development cases establish Claude parity or resistance to all prompt injections.

The production manifest requests required HTTP(S) website permissions. The disposable test profile loads this unchanged manifest and verifies all-site access before any per-site override. Persistence and explicit revocation are covered by a storage lifecycle test; user-facing Chrome installation/update permission prompts still require a separate manual check. The suite has not yet run on Windows/macOS or in enterprise-managed Chrome.

Artifacts from the browser run are `artifacts/side-panel.png`, `artifacts/browser-viewport.png` and `artifacts/e2e-task.json`. They contain fixture data. Real task traces and screenshots may contain private website content; they are ignored by source packaging.

## Performance and UI review

The [improvement report](IMPROVEMENT-REPORT-2026-10-05.md) includes baseline/final medians and p95 values with fixture conditions, failed iterations and tradeoffs. The 5 October reports contain no live model latency comparison. See the [6 October live report](JEV-LIVE-REPORT-2026-10-06.md) for Jev and Token Harbor measurements; no comparative Claude-extension benchmark was run. Light/dark Chat, Activity, Memory and a 320 px Settings layout were reviewed using disposable-profile screenshots; keyboard navigation and theme persistence are also covered in integration tests.

## 0.3.0 optimization regression

The full extension/bridge/stdio Chromium run additionally verifies combined scoped waits, visible/hidden/attached/detached selector states, immediate invalid-selector failures, unchanged text/select fields without input events, forced repeat events, disabled optgroup rejection, typing occlusion and focus-redirection rejection, optional frame metadata omission, and JPEG image MIME/signature through actual MCP transport. The final run again includes 100 fresh cross-site iframe clicks.

Provider tests use mixed PNG/JPEG batches across all three wire formats and ensure cached definitions cannot be mutated or contaminate an advanced-access profile. The worker wait unit tests verify deadline-bounded sleep, early polling/backoff, pending-document guards, access revocation and compound argument preflight.

The same seeded 100-workflow foreground corpus was repeated against 0.3.0 and passed 103/103 cases, with zero model calls. Its independent form grader again required exactly one trusted submission and checked every field. This is a matched release comparison, not an additional collection of distinct task families.

Current measurements and independently graded task results are in the [0.3 optimization report](OPTIMIZATION-REPORT-2026-10-05.md). Earlier release reports retain their historical results.

## 0.4.0 Jev engine regression

Additional tests validate Choice/Noul/Score contracts, question and probability coverage, argmax checks, usage on malformed replies, a total retry deadline, deterministic caller bindings, guarded submission fields, independent predicate verification, uncertainty hand-back, cancellation and controller ownership, incomplete candidate coverage, one bounded inference recovery, failed-task MCP polling and protocol 1–3 reload requirements. `node tests/guards.e2e.mjs` verifies changed-name/context/field rejection through real Chrome input paths. The final live Jev development run passed 13/13, and the Token Harbor free-model planner passed 3/3; earlier low-confidence and timeout failures remain in report assets.
