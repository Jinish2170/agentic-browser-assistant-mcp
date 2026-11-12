# Browser-agent framework comparison — 6 October 2026

Status: research complete; architecture decision proposed, not accepted. No framework was installed, prototyped or benchmarked for this comparison. Implementation source reviewed: v0.4.1. This document separates documented framework capabilities from our assessment of their fit.

Related: [master plan](AGENT-DEVELOPMENT-PLAN.md), [evaluation design](AUTONOMOUS-BROWSER-EVALUATION.md), [current audit](AGENT-AUDIT-2026-10-06.md).

## Recommendation

**Updated after the user's answers:** Python, personal use and all three execution modes are confirmed. Recommend **Python LangGraph**, with CrewAI Flows as the Python alternative and the existing custom Node runtime as the baseline/rollback path. The earlier JS-first recommendation is superseded for the next architecture; the JS comparison below remains useful for understanding existing-module compatibility. This is a suitability recommendation, not a demonstrated performance win or authorization to migrate.

Python LangGraph supports explicit stateful graphs mixing deterministic code and model decisions, persistent checkpoints and interruption/resume. Those mechanisms fit bounded Jev delegation and separately verified browser steps. [Python overview](https://docs.langchain.com/oss/python/langgraph/overview), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

For the first experiment, retain the working JavaScript extension and Node bridge/MCP/bounded engine. Python orchestrates workflow state through an internal lease-aware execution adapter. Both Python LangGraph and CrewAI would need this integration; Python preference does not remove the extra process boundary. Compare cancellation, receipt reconciliation, progress and transport overhead with the current Node baseline.

| Python choice    | Fit for the confirmed requirements                                                                               | Remaining work                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Python LangGraph | Recommended for explicit subgoals, bounded execution nodes, independent verification and resumable waits         | Browser bridge adapter, contracts, journal integration and recovery scheduler               |
| CrewAI Flows     | Credible Python alternative with structured event-driven flows; useful if role collaboration becomes a core need | Same browser adapter and verification/recovery obligations; evaluate Flow failure semantics |
| AutoGen          | Existing agent/team capabilities do not outweigh its maintenance status for a new migration                      | Additional integration and future support concern                                           |

SQLite is a proposed personal/local persistence candidate, not a finalized production storage choice. Evaluate durable writes, journal/checkpoint coordination and retention. Python interrupt resume also restarts the containing node, so non-idempotent browser actions still need reconciliation. [Python persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

CrewAI is a credible alternative when Python and role-based agent collaboration are priorities. Its Flows are relevant; it would be inaccurate to dismiss it as just conversational crews. AutoGen is a poor choice for a new migration because its official repository now declares maintenance mode and directs new users to Microsoft Agent Framework. If a Microsoft stack becomes a requirement, evaluate that successor separately. [CrewAI repository](https://github.com/crewAIInc/crewAI), [AutoGen repository](https://github.com/microsoft/autogen).

## Existing architecture

Our agent is custom JavaScript ESM on Node.js 22+, currently developed on Node 24. `server/agent.mjs` implements the general task loop; `server/provider.mjs` implements provider sessions and tool definitions; `server/fast-engine.mjs` implements bounded Jev execution. The MV3 extension controls the existing Chrome profile through Chrome APIs/CDP. Playwright is a test dependency, not the production executor. Dependencies include the MCP JavaScript SDK, ws and Zod; none of the compared orchestration frameworks is installed.

Current persistence stores conversation/provider state and a bounded dispatch ledger. A restart marks active tasks interrupted; it does not schedule automatic continuation. The general planner lacks the bounded runner in its tool definitions. Its final success gate checks an excerpt in a fresh page snapshot, rather than the actual requested outcome. These are application gaps; changing a package does not fix them by itself.

## Comparison for our requirements

The table is qualitative. “Custom” means work we would own, not an impossible capability. “Supported” describes a documented mechanism, not a guarantee of reliable browser tasks.

| Requirement                               | Current custom Node                        | LangGraph.js                                       | CrewAI                                             | AutoGen                                                           |
| ----------------------------------------- | ------------------------------------------ | -------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Fit with existing Node modules            | Direct                                     | Direct JS/TS integration                           | Python orchestration boundary                      | Documented Python/.NET stack; extra boundary                      |
| Direct browser action path                | Already implemented                        | Retain our executor                                | Retain via bridge/service or MCP                   | Retain via bridge/service or MCP                                  |
| Explicit state, branching, workflow graph | Custom work; current loop is mostly linear | Graph-based orchestration                          | Stateful event-driven Flows                        | Event-driven agents and team patterns                             |
| Persistent execution state                | JSON checkpoints; no automatic resume      | Checkpointers and thread identity                  | Persisted Flow state and resume mechanisms         | Agent/team save/load; durable execution needs additional design   |
| Waiting for user input across a restart   | Custom work                                | Persistent interrupts                              | Paused Flow feedback/resume                        | Human interaction and saved state; lifecycle integration required |
| Jev delegation                            | Missing chat integration                   | Can be a deterministic/custom node                 | Can be a Flow step                                 | Can be a custom tool/agent operation                              |
| Progress events                           | Existing stage events                      | Graph/custom streaming                             | Flow lifecycle integration                         | Streaming agent/team events                                       |
| Provider token streaming                  | Adapter work remains                       | Adapter/event integration remains                  | Provider integration remains                       | Provider integration remains                                      |
| Parallel independent work                 | Distinct-tab batches                       | Graph scheduling; browser locks still required     | Async Flows/crews; browser locks still required    | Agent runtime/teams; browser locks still required                 |
| Browser goal verification                 | Weak current gate                          | Application-specific verifier required             | Application-specific verifier required             | Application-specific verifier required                            |
| Unknown browser mutation recovery         | Preserves uncertainty; stops               | Application journal and reconciliation required    | Application journal and reconciliation required    | Application journal and reconciliation required                   |
| Deployment complexity for this project    | Existing single Node service               | Additional packages/storage, same runtime possible | Additional Python runtime/service                  | Additional runtime, plus maintenance concern                      |
| Main reason to choose it                  | Control and minimum migration              | Structured execution lifecycle                     | Python business workflows with collaborating roles | Existing investment in its ecosystem                              |

Evidence for framework rows: [LangGraph JS overview](https://docs.langchain.com/oss/javascript/langgraph/overview), [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming), [CrewAI Flows](https://docs.crewai.com/en/concepts/flows), [Flow feedback](https://docs.crewai.com/en/learn/human-feedback-in-flows), [AutoGen state management](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html), [AutoGen repository](https://github.com/microsoft/autogen).

LangGraph.js supports mixing deterministic and model-driven nodes. Its package uses LangChain core infrastructure, but we do not have to replace our provider adapter with a prebuilt LangChain agent or move the executor into a hosted service. Our proposed node wrappers are application design, not existing code. [JS repository](https://github.com/langchain-ai/langgraphjs).

CrewAI's documented Flows use structured state, routing and optional SQLite persistence; the feedback API includes loading pending flows and resuming asynchronously. Those mechanisms should be tested at actual failure boundaries before being described as safe browser recovery. [Flows](https://docs.crewai.com/en/concepts/flows), [feedback resume](https://docs.crewai.com/en/learn/human-feedback-in-flows).

AutoGen's agent/team state serialization is useful, but saved model context alone cannot determine whether a browser write happened. Its documented stack includes Python and .NET, and its current maintenance status is a material future-feature disadvantage. [State](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html), [project status](https://github.com/microsoft/autogen).

## Performance: what we know and what we do not

There is no matched framework benchmark in this project. We cannot rank JavaScript versus Python or publish a percentage speed improvement from documentation or framework marketing.

Our existing live development evidence shows a bounded Jev workflow median of 541.11 ms across 13 cases and a general configured planner median of 52,218.14 ms across three native-form cases. These are different modes and samples, **not a framework comparison or a measured delegation speedup**. See [live receipts and conditions](JEV-LIVE-REPORT-2026-10-06.md).

End-to-end time contains startup/queueing, model waits, observation and tool transport, browser/site waits, verification, retries, persistence and UI updates. A framework primarily changes orchestration; fewer unnecessary model turns and better subtask routing may matter more than runtime overhead. Additional agents may introduce model calls and coordination costs. Parallelism helps independent work; it does not make dependent login steps or shared foreground input independent.

Our custom runtime has the least migration work and leaves the action path under direct control. LangGraph may reduce the amount of custom lifecycle code we must maintain. Neither statement establishes which will be faster under our workload.

## Persistence is not exactly-once browser execution

LangGraph documents that interrupt resume re-runs the containing node and recommends idempotent side effects or separated action nodes. It also provides opt-in node retries/timeouts. Re-running a node after a browser click can duplicate a record even if the graph's internal state rolls back. [Interrupt rules](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance).

Our design must put native input behind an application-owned dispatch journal and a recovery reconciler. No framework transaction can atomically include a remote website's state change. An action with an unknown outcome must be inspected before any decision to try again. Automatic retries should be limited to operations whose replay is established as safe.

Use a disk-backed checkpointer for restart recovery; an in-memory saver is not restart persistence. Local SQLite versus PostgreSQL remains a deployment decision, and the exact JS package/version/schema compatibility needs a prototype check before selecting it. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence).

## Future decision experiment — not run yet

1. Python/personal/three execution modes are confirmed. Agree exact release workflows and budgets, then record the framework decision. Modes are not substitutes for website task definitions.
2. Establish shared task contracts and an independent outcome grader before comparing orchestrators.
3. Build an isolated Python LangGraph adapter around the same provider behavior and executor; preserve the current implementation as a control and rollback path. Include the Python–Node transport in the measurement. If CrewAI remains a finalist, test it against those same contracts. Do not run competing controllers against one profile.
4. Use a recorded deterministic planner trace to isolate orchestration/checkpoint overhead. Then use matched live tasks with identical model, tools, limits, starting state and reset procedure. Alternate run order and repeat cases; freeze provider/version settings.
5. Test interruption, restart, cancellation, stale browser references, user corrections and uncertain writes. Assess state migration and dependency compatibility, including our existing Zod schemas and provider tool-call IDs.
6. Measure independently verified completion, false success, duplicate/unintended writes, interventions, median/p95 latency, time to first visible progress/action, model turns, Jev usage, context size, storage overhead and CPU/memory. Report denominators and uncertainty.
7. Select LangGraph only if it preserves executor/MCP contracts, improves lifecycle behavior, avoids meaningful latency/cost regression on the agreed corpus and makes required features easier to maintain. Agree quantitative latency/cost tolerances before running the experiment.

If those gates fail, keep the existing Node product operational while reassessing the Python alternatives, including CrewAI Flows or a custom Python orchestrator. Do not silently reverse the user's Python preference. The workflow, verification and journal contracts remain portable, and framework choice alone cannot fix the current correctness gaps.

## Research limits

Official documentation and repositories were checked on 6 October 2026. Framework capabilities are not browser-agent benchmark results. No evidence here establishes universal task completion, authentication bypass, visual competence of our configured model, or parity with Claude's extension. Hosted observability/evaluation products are optional; exporting personal traces to them would be a separate product/data decision.
