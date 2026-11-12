# Roadmap toward Claude-level browser reliability

The current source is v0.4.1; earlier release evidence remains in its dated reports. The next agent architecture discussion and task register are maintained in the [agent development plan](AGENT-DEVELOPMENT-PLAN.md), with a [framework comparison](FRAMEWORK-COMPARISON-2026-10-06.md) and [autonomous evaluation design](AUTONOMOUS-BROWSER-EVALUATION.md). That plan records the user's current priorities and deferred work; no framework change has been accepted yet.

No browser agent can guarantee every requested task. The aim is broad capability with measurable success, truthful failure reporting and recoverable handoffs. The targets below are proposed release gates, not results already achieved.

## 1. Establish the quality baseline

The current independent fixture corpus covers 100 generated form workflows plus extraction, six-tab and popup cases, repeated with two seeds. Expand it into a versioned corpus of at least 100 distinct tasks covering research, form workflows, dynamic lists, tab coordination, documents, uploads and canvas widgets. Use independent outcome assertions, repeated runs and held-out tasks. Record completion rate, mistaken-success rate, unintended writes, user interventions, latency, steps and provider cost.

Add a BrowserGym adapter for representative MiniWoB, WebArena, VisualWebArena and WorkArena subsets. Where Claude comparison is permitted and available, run identical tasks in disposable accounts with equal budgets and comparable starting state. Publish denominators and failure categories; avoid claiming parity from selected demos.

## 2. Complete observation and interaction coverage

The current build has accessibility trees, console/network diagnostics, performance metrics, viewport emulation and parallel tab batches. Nested frame coordinate translation and cross-site trusted input are implemented for ordinary/scaled layouts. Next expand CDP frame sessions, rotated-frame mapping, nested scrolling containers, richer editable widgets, multi-file/frame uploads and broader download failure/enterprise-policy tracking. Explicit state waits and DOM-content readiness now avoid unrelated resource loads. Scoped state predicates, fast worker polling and JPEG observations are implemented in 0.3.0. Next add lifecycle/mutation instrumentation for richer dynamic states. Add tests for zoom, high device-pixel ratios, responsive layouts, stale navigation, overlays and closed shadow DOM.

Proposed gate: all supported control primitives pass Chrome/Chromium platform tests, including suspension, detach and frame navigation; unsupported cases yield explicit errors before an action.

## 3. Strengthen planning and verification

Introduce explicit plans with task-specific success conditions, independent verifiers, recovery strategies and stronger compaction evaluation. Durable conversation/provider checkpoints, explicit reusable facts, mid-task updates and bounded context compaction are implemented; next evaluate their fidelity over long sessions and evaluate the new persisted dispatch/return ledger and source-evidence checkpoints over realistic long tasks. Resume only from a user-reviewed checkpoint after inspecting state. Provide a real handoff/resume UI for login, CAPTCHA and 2FA.

Compare LLM-only and LLM+Jev configurations under the same corpus. Calibrate confidence thresholds per routing/element-matching task. Measure Jev fallback frequency and savings in total task cost, not isolated API latency. Add semantic completion checks; the current excerpt check only proves that a cited string was observed.

## 4. Harden prompt-injection boundaries

Add adversarial pages, emails and documents to the corpus. Test hidden instructions, label injection, malicious links, cross-origin redirects and misleading success messages. Add task-specific destination/data policies, out-of-band transaction review and secret handling. Ensure neither page content nor a model can modify permissions or pairing settings.

Proposed gate: zero unintended sensitive writes in the held-out test corpus and an independently reviewed threat model. Zero observed failures is a release gate for that corpus, not a guarantee of universal security.

## 5. Package a reliable desktop connection

Ship an extension-ID-pinned native messaging host, OS-keychain secrets, signed installers, token rotation and a guided pairing flow. Add browser/profile identity, task ownership and deliberate handoff between MCP clients. Provide status diagnostics when enterprise policy or another debugger blocks access.

A hosted-chat connector requires a separately authenticated design or approved local-client integration. Do not expose the development loopback bridge through an unauthenticated tunnel. Review platform-specific plugin support before publishing a connector.

## 6. Release deliberately

Run the corpus repeatedly across Windows, macOS and Linux; add supported Chrome release channels and resource-leak/long-session tests. Complete a Chrome Web Store permissions, privacy and remote-code review. Publish supported cases, test results, data handling and known failures. Add opt-in telemetry only with clear disclosure and retention controls.

Proposed broader-beta gates: at least 90% independently verified completion on the declared supported corpus, fewer than 1% false success claims, no unreviewed unknown-outcome replay, and a documented handoff for every recurring blocker. These percentages should evolve with actual measurements and task risk.

The next implementation priorities are live-provider/held-out task evaluation, broader document and child-frame coverage, independent semantic verification, compaction-fidelity/long-duration stress tests and resumable handoffs. Store distribution and native-host packaging follow that evidence.
