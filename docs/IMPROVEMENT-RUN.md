# Extended improvement run

Started 5 October 2026, 18:13 IST. The user requested autonomous overnight research, implementation, testing and a next-morning report. This is an active engineering run, not a claim of superiority over every browser agent.

## Starting evidence

- 35 unit/integration tests pass; the full disposable Chromium integration suite passes.
- 46 MCP tools cover DOM, screenshots, accessibility, native input, nested frames, diagnostics, tabs/groups/windows, downloads, scoped uploads, memory and skills.
- Direct MCP actions were tested in the user's connected Chrome profile: a new Claude chat and response, visible JEV Browser group, screenshot retrieval, and TypeSafe Google signup/onboarding. TypeSafe's first verification attempt failed; clean-page retry succeeded. The user approved both sets of binding terms. No authentication security bypass was needed.
- The live demonstration launched a new stdio MCP process for each helper call, printed large snapshots, and separately requested action/wait/snapshot. Those are measurable candidates for latency and context overhead, not established root causes yet.
- No paid model benchmark will run without configured credentials. Fixture provider responses verify integration, not reasoning quality.

## Research directions

| Primary source                                                                                                                 | Engineering question                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) and [CLI](https://github.com/microsoft/playwright-cli) | Persistent context, compact observations and purpose-built commands           |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)                                                   | Slim tool surfaces, console/network/performance and compound action contracts |
| [Browser Use](https://github.com/browser-use/browser-use)                                                                      | Browser state, interruption, action sequencing and observation design         |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym), [paper](https://arxiv.org/abs/2412.05467)                              | Reproducible benchmark harnesses and independent state-based graders          |
| [WebArena](https://arxiv.org/abs/2307.13854), [BrowserArena](https://arxiv.org/abs/2510.02418)                                 | Long-horizon task evaluation and real-world failure categories                |
| [Anthropic evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)                                      | Verify actual outcomes rather than agent self-reports                         |
| [Anthropic browser injection research](https://www.anthropic.com/research/prompt-injection-defenses)                           | Untrusted page data, constrained capabilities and failure reporting           |

## Iteration backlog

1. Measure baseline: cold helper vs persistent MCP, snapshot bytes, action/observe latency and large-page behavior. Record median/p95 and repeatable conditions.
2. Persistent local MCP session client: avoid per-action process startup; keep image content outside JSON/text. Measure again.
3. Compact/scoped observations and a combined action/verify contract with explicit per-step outcomes; stop immediately after failed/unknown mutations.
4. Dynamic-page waiting, form workflows, tab/popup tracking, image/PDF/document extraction and selector/role grounding. Prioritize from research and tests, not tool-count inflation.
5. Conversation-first side-panel redesign: clear workspace, tabs/activity, restrained typography, progressive settings, light/dark themes, responsive and keyboard-accessible controls.
6. Long-session structured task ledger and restart boundaries; explicit facts remain user-controlled.
7. Broaden task corpus, adversarial fixtures, performance budgets, soak tests and packaging. Re-run checks after material changes.
8. Produce the report: measured deltas, changes, issues encountered and resolved, limitations, setup and reproducible validation commands. Do not equate fixture integration with Claude-level reasoning.

## Progress

- Baseline measured and retained: persistent MCP status 3.50 ms; cold helper 216.56 ms; 64,650-byte snapshot missed the main task behind 1,000 sidebar links.
- Shipped a persistent JSONL SDK client, viewport/main-task prioritization, compact/scoped observations, name/role filtering, implicit roles and per-invocation style caching.
- Added browser_step, browser_fill_form and browser_extract; specific readiness waits avoid unrelated resources. Managed downloads can wait for their terminal state in one call. Tab metadata includes opener IDs.
- Persisted task dispatch/return ledgers, restart uncertainty and user corrections. Added validated long-task budgets, endpoint-bound keys, progressive tool categories and definition-aware context accounting.
- Rebuilt the side panel around Chat/Activity/Memory/Settings, bundled Inter, light/dark themes, narrow layouts, keyboard navigation and conditional/adaptive polling.
- Expanded from 35 to 53 unit/integration tests and from 46 to 49 MCP tools. Full Chromium regression passed, including 100 fresh cross-site frame clicks with no replay.
- Initial independent corpus exposed a native select label bug: 3/43 cases passed before the fix; two seeded background 100-form runs then passed 103/103 each; a third foreground-step release run also passed 103/103. Instrumentation runs separate action/wait/observation costs.
- Added browser-stage timing telemetry. A global background screenshot experiment increased overhead without reducing click tail latency, so it was removed. Only the independently validated iframe synchronization remains. A matched foreground/background experiment found a supported alternative: foreground click p95 was 29 ms versus 1,028 ms in the background. Added explicit sequential foreground activation to browser_step.
- Release 0.2.0 protocol negotiation prevents a new bridge dispatching commands to a stale worker; pairing is preserved and one Chrome reload is required.
- Expanded primary-source research, workflow instructions and reproducible packaging. Detailed measurements, failures, limits and release steps are in [the final report](IMPROVEMENT-REPORT-2026-10-05.md).

## Operating boundaries

Keep the user's personal Chrome tabs and credentials out of benchmark fixtures, packages and logs. Use disposable profiles for regression and stress testing. Preserve user-approved broad HTTP(S) access, pause/revocation, and explicit agreement/authentication handoffs. Do not replay mutations after unknown outcomes. Do not send external messages or buy credits as part of research.
