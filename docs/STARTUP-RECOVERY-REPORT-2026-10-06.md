# Startup, progress and occlusion fixes — 6 October 2026

Release: **0.4.1**.

The reported NVIDIA task spent **36,321ms in model planning** and **66ms in browser tools** before it stopped. Its initial Jev observation took **5,662ms**; a later decision took **612ms**. Opening the target directly through the real MCP took **117ms**. These are measurements from one task, not general latency guarantees. Private page content, account identifiers, verification links and keys are excluded from this report.

## Changes

- Explicit opening instructions now launch literal HTTP(S) URLs before requesting an LLM plan. The NVIDIA NIM dashboard has an audited alias. Compound instructions continue in that new tab; plain URL-only tasks need no planner if a fresh observation verifies the exact URL and a page title. Ambiguous instructions continue through the planner.
- Chat displays a progress card immediately on submission, disables duplicate submission, and shows actual stages, elapsed time and recent steps while inference is pending. Progress updates do not depend on the conversation transcript changing. Active polling starts promptly and runs at 800ms.
- General Jev observation routing is bounded to a 1500ms total request budget, falling back to current-page evidence on timeout. Known occlusion forces fresh DOM and a screenshot independently of router success.
- Geometry/focus failures before native input carry an explicit `not_dispatched` boundary. Compound steps return `action_blocked` and a fresh snapshot. The planner can dismiss the observed overlay and use fresh targets; bounded Jev hands back `needs_plan`.
- Unknown post-input failures still stop. Error wording alone cannot claim that input was not dispatched. Direct tool transport and the durable ledger preserve this distinction. Independent form fields retain earlier results if a later field is blocked.

## Validation

- **82 unit/integration tests passed**, covering pending-planner progress, startup ordering, provider-free URL opening, unknown startup outcomes, compound/direct error boundaries and transport metadata.
- The real extension/stdio MCP Chrome suite passed, including a deliberately delayed planner with visible chat progress, a real overlay blocking native input, dismissal using fresh observation, and a grouped URL-only startup completing in **94ms with zero model calls**.
- The existing guard suite passed: changed target name, row context and related-field values fail before input; supplied form values can be verified afterward.
- The first expanded browser test reached the new progress check but failed because its new overlay check referenced an incorrect fixture variable. The fixture reference was corrected, and the complete suite passed. This was a test defect, not a production browser failure.

The suite uses disposable local pages and fixture provider responses. It establishes the tested contracts, not general completion reliability. General inference on the selected free DeepSeek provider can still take tens of seconds; progress makes that wait visible but does not accelerate the provider itself. Startup shortcuts are deliberately narrow and do not infer navigation from website text or saved memory.

## NVIDIA task

The live task used the paired Darius Chrome profile and the actual JEV extension/MCP. The cookie banner was dismissed with Reject Optional. A subsequent stale reference was replaced with a fresh observation. Chrome's existing saved password authenticated the account; the matching NVIDIA verification email was opened and its verification link used. Foregrounding the waiting NVIDIA tab allowed its login flow to finish. The API-key creation dialog was completed with a descriptive name; the dashboard confirmed the new key active with a one-year expiration. The full value was captured into an owner-only file under `.local`, outside both release archives. A minimal live inference request to NVIDIA returned HTTP 200 and `OK.` in 473ms using `meta/llama-3.2-11b-vision-instruct`. This was a credential smoke test; the extension’s selected Token Harbor DeepSeek provider was retained. The first smoke test used the model in NVIDIA’s quickstart and received HTTP 410 because it was retired; a second listed model received HTTP 404 for an unavailable function. A currently working catalog model completed the test. Listing models alone was not treated as proof of inference access.

One modal-close wait used `detached`, while the site retained a hidden control; it timed out after the click had already succeeded. The returned fresh snapshot proved the overlay had closed, so no click was repeated. The model prompt already distinguishes an unmet wait from failed input.

The supported account/login and email-verification flow completed without circumventing authentication.

## Activate the update

Rebuild output is in `dist/extension`. The verified idle local bridge was restarted for the updated agent. Click Reload on JEV Browser in `chrome://extensions` and reopen its panel. Pairing and saved conversations remain local. No new per-site permission process is introduced.
