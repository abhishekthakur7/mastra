# Subscription runtime reliability and release policy

This document defines the reliability contract for local Claude Code and Codex subscription execution in Mastra Studio. It applies to ordinary registered agents, configured Mastra tools, AgentController sessions, and workflow agent steps. It is a design policy and proposed state vocabulary; these state names are not existing Mastra APIs.

Revision: 2026-09-14, following fresh parallel Terra high and Luna xHigh adversarial reviews. Read this with the execution-path inventory in [SUBSCRIPTION-RUNTIME-CAPABILITIES.md](SUBSCRIPTION-RUNTIME-CAPABILITIES.md) and the tasks in [SUBSCRIPTION-RUNTIME-PLAN.md](SUBSCRIPTION-RUNTIME-PLAN.md). Network/resumeNetwork, standalone durable, and legacy execution require explicit coverage; they are not implicitly satisfied by the modern stream seam.

The target is behavior-preserving execution at the boundaries Mastra exposes to the product. A vendor loop cannot be represented as an identical Mastra model loop merely by naming similar hooks. Missing required behavior must never be silently skipped, routed to an API-key model, or recovered by starting an unrelated vendor session. This does not justify turning existing best-effort or asynchronous Mastra work into a new admission failure: the adapter must preserve the current lifecycle unless a caller explicitly makes that work critical.

## Reliability model

There are three separate operations:

1. **Configuration admission** resolves an agent/runtime selection, checks the installed executable and version contract, and records known capabilities.
2. **Boundary preflight** checks requirements that are knowable before the next vendor request or Mastra tool execution.
3. **Execution** starts a real vendor turn and may perform model, tool, memory, scorer, title, or workflow effects.

A runtime may be launched idle for status, version handshake, capability negotiation, diagnostics, or draft configuration. “No side effects before preflight” applies to the next vendor request or tool execution, not to every process launch, normal workflow snapshot, normal memory preparation, or status record. Live model probes are not required on every run: version-contract tests and sanitized protocol fixtures validate the adapter before release; each run performs executable/version/auth and known-configuration checks. Dynamic functions are evaluated where Mastra normally evaluates them and are checked at the next safe boundary.

Proposed runtime/operation states:

- `checking`: configuration or non-model preflight is in progress;
- `ready`: required checks passed for the selected operation;
- `degraded`: an explicitly allowed best-effort feature is absent;
- `blocked`: a required capability, version, authentication state, or declared requirement is missing;
- `running`: a real turn or workflow step is active;
- `waiting_approval`: Mastra or vendor approval is pending;
- `suspended`: a tool/workflow step is waiting for resume data;
- `unknown_recovery`: process loss or a commit gap leaves external side-effect state uncertain;
- `succeeded` / `failed`: the primary operation completed with the corresponding result;
- `succeeded_with_auxiliary_failure`: a proposed future-adapter state in which the primary result committed while an asynchronous/best-effort title, scorer, or telemetry task failed. Current M-C behavior does not persist this state or promise independent retry.

These states must be reported consistently by Studio status, ordinary agent handlers, AgentController, and workflow handlers. A status endpoint may report `ready` for baseline streaming while an individual operation is blocked by a *critical* active processor, memory mode, tool, or structured-output requirement. A separately invoked evaluator or dataset job has its own readiness; it does not make chat unavailable.

## T01 timing and side-effect baseline

The detailed source/test coverage ledger is in [the T01 contract and coverage baseline](SUBSCRIPTION-RUNTIME-CAPABILITIES.md#t01-contract-and-coverage-baseline). This section fixes the reliability interpretation that every implementation slice must preserve. `M-C` in that ledger is current Mastra characterization evidence; `V-F` is future Claude/Codex compatibility evidence. A `M-C` passing test never upgrades an unrun vendor probe to supported behavior.

| Admission/lifecycle point | Exact host anchor | Required check and expected behavior | Allowed prior effects / boundary | Failure and recovery rule |
| --- | --- | --- | --- | --- |
| Configuration admission | `Agent.#execute` (`packages/core/src/agent/agent.ts:7234`), server `GENERATE_AGENT_ROUTE` (`packages/server/src/server/handlers/agents.ts:1432`), controller/workflow route setup | Detect executable/app-server version, authentication/status, negotiated protocol, static tool/hook/native requirements, and cache-key inputs. Report `ready`, `degraded`, or `blocked` with operation-specific requirements. | Idle launch, handshake, version/status diagnostics, draft saves, and normal status records are allowed. No real model turn or protected tool effect is allowed before the gate. | Missing/unknown critical capability blocks the selected operation; do not fall back to an API-key model, another runtime, or a fresh vendor session. |
| Normal preparation | `createPrepareStreamWorkflow` wiring (`packages/core/src/agent/agent.ts:7554`), `prepare-memory-step.ts:95-230`, `AgentCapabilities` (`packages/core/src/agent/workflows/prepare-stream/schema.ts:14`) | Resolve model/instructions/request context, effective tools, memory, processors, structured output, callbacks, and native opt-ins at their existing Mastra phase. Recompute requirements after dynamic callbacks return. | Normal memory/thread preparation and local request-context work may persist before a dynamic value is known; do not promise zero storage mutation. No vendor request/tool execution yet. | A critical dynamic incompatibility stops before the next vendor boundary and reports the exact dependency/path. Existing local writes remain auditable; they are not rolled back or hidden. |
| Workflow start gate | `Workflow.createRun` (`packages/core/src/workflows/workflow.ts:2688`), pending snapshot persistence (`workflow.ts:2778-2796`), and `ExecutionEngine.invokeStartCallback` (`packages/core/src/workflows/execution-engine.ts:129`) | Perform run-level compatibility admission before any workflow step and keep Mastra's normal pending snapshot semantics. | `createRun()` may write the pending snapshot and lease. The safety boundary is no vendor request/tool effect, not “no snapshot.” | Blocked run may remain pending/blocked and cancellable. A later agent/tool step repeats the dynamic check; prior completed steps stay intact. |
| Vendor/model boundary | `stream-step.ts:105` (`capabilities.llm.stream`) or the tested network/durable adapter boundary; `Agent.network` (`agent.ts:7935`) is separate | Admit only if the selected runtime can represent required stream/final/structured/error/abort and processor phases. Select transport before a tool/approval state exists. | This is the last no-vendor-side-effect point. Once the request is sent, provider usage and partial response are possible. | Protocol/auth/quota/version errors are classified; no hidden runtime/transport/API-key fallback. If dispatch certainty is unknown, retain partial state and enter `unknown_recovery` rather than replay. |
| Per-step / per-tool boundary | `ProcessorRunner` phase methods (`packages/core/src/processors/runner.ts:1471`, `:1774`, `:1898`, `:2027`, `:2246`, `:2445`); tool dispatch (`tool-call-step.ts:467-625`) | Re-resolve `prepareStep`, dynamic processors/tools, active tools, approval and structured-output requirements before the next model request or tool execution. Run output-step/pre-tool guardrails before any protected tool. | Earlier model steps and workflow prefix may already be persisted. A host-controlled Mastra tool may be gated before `Tool.execute`; native vendor tools require a separately verified enforcement path. | Missing request rewrite/cache, pre-tool guardrail, approval, tool-result barrier, or required schema blocks the affected boundary. Never replace a model-visible or pre-action guarantee with display filtering or a post-hook. |
| Tool result / suspension | `llm-execution-step.ts:996` (tool-result processing before persistence), `Tool.execute` (`packages/core/src/tools/tool.ts:425`), approval/suspend state in `tool-call-step.ts` | Preserve `MessageList`, step IDs, processor state, request context, actor, abort, approval, suspend/resume, and stable tool-call IDs. A result processor completes before persistence/next vendor request. | Approval must be durably recorded before invocation. A host tool's external side effect may commit before its local result acknowledgement. Suspended state and payload are persisted. | Denial/timeout/disconnect is not consent. Duplicate/late results are ignored or surfaced. A child-process exit after dispatch is `unknown_recovery`; automatic retry requires tool-provided idempotency/reconciliation. |
| Resume/recover/reconnect | `Agent.resumeStream` (`agent.ts:9133`), durable `recover(runId)` tests and server `RECOVER_ROUTE` (`agents.ts:2935`), workflow `resume`/`observe` routes (`workflows.ts:607`, `:754`, `:813`) | Reload capability/version/configuration ledger, Mastra run/thread/workflow state, vendor session/thread/turn/item IDs, pending approvals, suspend payload, and outcome certainty before continuing. | Reconnect may replay retained local stream chunks and normal snapshots; it must not assume live in-memory process/callback handles survived. | Resume only the explicit matching run/session. Missing session, changed capability set, or uncertain dispatched effect yields recoverable failure/`unknown_recovery`; never implicitly “continue latest” or start a fresh duplicate turn. |
| Completion/finalization | `map-results-step.ts:374-429`, `Agent.#executeOnFinish` (`agent.ts:7700`) | Preserve structured-result validation and each finalizer task's current sync/async contract. | Primary response may already be streamed/persisted. Title/live scorers are independent asynchronous work and may outlive the response. | Current M-C catches/logs an `executeOnFinish` error and continues to the ordinary `onFinish` callback; it does not persist a retryable auxiliary outcome. A future explicit strict-finalizer or auxiliary-outcome policy must be tested separately and must never rerun the main turn. |

The timing rules apply equally to ordinary agents, AgentController, workflow agent steps, `network()`/`resumeNetwork()`, standalone durable runs, legacy methods, thread subscriptions, and A2A child calls. The source/test anchors in the capabilities ledger identify where each path diverges; in particular, `networkLoop` is outside `#execute`, workflow `createRun()` precedes `onStart`, and resume intentionally skips initial input processors. These are current Mastra facts to preserve, not vendor compatibility evidence.

### T01 unresolved evidence and durable TODOs

At this baseline, no authenticated Claude Code `2.1.270` turn/control exchange and no Codex App Server `0.154.0` initialize/thread/turn exchange has been run. The following remain `V-F` release work, not silent scope reductions:

- Prove the bidirectional Claude permission/hook/control contract and Codex negotiated dynamic-tool/hook contract, including ordering, mutation, fail-open behavior, and coverage of native tools.
- Prove vendor session/thread resume, pending approval/client-result recovery, process-loss reconciliation, cross-process thread leases, and changed-version/tool/config invalidation.
- Prove request-cache substitution, per-step processor barriers, tool-result redaction before persistence/next request, stop/compaction semantics, structured output, and unavailable usage behavior.
- Admit titles, scorers, embeddings, rerankers, dataset/evaluation judges, and fallback models as independent dependencies; a ready subject chat does not make those jobs ready.

Until those probes and fixtures exist, a required affected operation is `blocked`; a dispatched operation with uncertain external outcome is `unknown_recovery`. Existing Mastra `M-C` tests establish the host behavior and timing only. They do not justify a release claim for Claude or Codex.

#### T01-discovered network ownership blockers

The following are current Mastra (`M-C`) characterization findings from the network route/core inspection, not Claude/Codex evidence and not solved T01 deliverables. They are release blockers assigned to later tasks. Each must fail closed before a memory read/write, continuation, vendor request, or protected tool effect when its required identity cannot be established.

| Blocker | Evidence and required reliability rule | Assigned |
| --- | --- | --- |
| Direct/core existing-thread ownership check | `Agent.network`/`networkLoop` can read an existing thread without the server route's resource check; route tests only prove the HTTP boundary. A wrong or missing core owner must produce no memory or vendor call. | T08, T15, T18 |
| Start context-only scope | `requestContext` supplies effective resource/thread at start but is not a persisted authorization record. Missing or ambiguous start scope must stop before thread/vendor effects. | T08, T11, T18 |
| Persisted run resource/thread/agent identity | Network snapshots/options expose thread IDs, while `createRun({ runId })` and `allowUnclaimedResumes: true` do not establish an authoritative owner envelope. Persist and validate agent/network, resource, thread, and authorization fingerprints. | T08, T11, T16, T18 |
| Continuation authorization / FGA | `AGENTS_EXECUTE` plus trusted context forwarding does not prove that the caller owns the suspended run. Approve/decline must check persisted run/agent/thread/resource ownership before resume. | T15, T18 |
| Missing/conflicting legacy-owner fail-closed policy | Legacy artifacts without owner metadata, or conflicting thread/request/run owners, need explicit migration/backfill and deterministic rejection; never infer an owner from the latest thread/run. | T08, T11, T15, T16, T18 |
| Concurrent unclaimed resume / CAS risk | `allowUnclaimedResumes: true` suppresses durable resume claims, so concurrent continuations can race the same suspended artifact. Require one atomic claim/lease/CAS winner, with no duplicate effect and auditable loser recovery. | T11, T15, T16, T18 |

These findings are host-side `M-C` evidence and must not be presented as vendor-runtime behavior. T01 records them; T08/T11/T15/T16/T18 implement and validate the fix.

## T02 protocol-fixture reliability evidence

T02 establishes only a credential-free, loopback protocol-fixture boundary. Its producer inputs and recorded payloads are strict parsed JSON-compatible values: primitives, arrays, and ordinary data objects. Objects with getters, executable accessors, Proxy traps, hostile prototypes, or other host-language behavior are explicitly outside the producer contract; the fixture cannot preempt an arbitrary in-process Proxy/getter trap. The recorder does, however, avoid inspecting payloads after its event cap or for unknown event types, and the hook validator rejects non-plain/cyclic/unbounded JSON values before response serialization.

The exact fixture guarantees are:

- Generated configuration is schema-version `1`, `mode: protocol-fixture`, strict, native-tools-disabled, and limited to exact `http://127.0.0.1:<port>/mcp` and `/hook` URLs with no credentials, query, or fragment. The MCP echo input is `value` length 1–128 and optional integer `delayMs` 0–250. Hook decisions are strict `allow`/`deny`/`modify`; decision strings are at most 4 KiB, decision input at most 64 KiB / depth 16 / 512 nodes / 128 object-or-array entries, request bodies at most 32 KiB, and response bodies at most 64 KiB.
- Hook timeouts are bounded to 1–5,000 ms, with default 16 and maximum 1,000 in-flight requests. HTTP MCP close timeouts are bounded to 1–5,000 ms with default 16 and maximum 128 active connections; stdio close timeouts are bounded to 1–5,000 ms. Event recording defaults to 100 events and accepts at most 10,000; default redaction caps are depth 8, 2,048-byte strings, 100 array items, and 100 object keys.
- Client disconnect, request-body deadline, handler deadline, relay shutdown, and overload paths abort or reject bounded work. HTTP shutdown closes owned sockets and MCP state; stdio shutdown attempts graceful close, then only the owned transport's force-close path, preserving both failures when needed.
- `BoundedResourceScope` owns only its created temporary directories, spawned child processes, and registered closers. Cleanup uses a 500 ms graceful process-group wait, a 1,000 ms force-kill wait, and a 2,000 ms closer timeout by default, with each configurable timeout constrained to 1–30,000 ms. It removes only scope-owned paths and has no raw-PID fallback; ordinary descendants in the owned process group are covered, while descendants that escape that group are outside the contract.

Negative coverage includes malformed/credentialed/non-loopback/path/query/fragment/extra-field configuration, invalid or oversized hook decisions, oversized or slow bodies, hanging/disconnected/shutting-down/overloaded relays, full/unknown event recording, secret-iterable and inherited-key bounds, child force-kill, closer/startup/workspace cleanup failures, held-open HTTP connections, active-connection caps, and graceful/forced stdio shutdown failures. These checks are static evidence only: fresh Terra High `01a09d5d-bd5e-7222-8e73-40b31575c73f` ACCEPT/static review, fresh Luna `01a09d5d-98f1-7353-b79b-a6dd3ae73680` PASS/static review, and `git diff --check` passed. Targeted runtime test/typecheck could not execute because local `tsc`/Vitest/dependencies are absent and pnpm registry resolution failed offline (`ENOTFOUND`), so this is an environment verification limitation, not runtime success. No authenticated vendor probes/loopback external side effects; T03 owns authenticated launch/profile evidence, while T04 owns the still-unproved vendor protocol exchange.

## T03 Claude launch-profile reliability evidence

T03 is complete for the Claude launch-profile reliability deliverable. Fresh Terra High acceptance and fresh Luna xHigh acceptance cover this strict execution slice. It has authenticated strict-metadata evidence, but not a model/protocol support claim. Claude Code `2.1.270` was run from its canonical executable in this historical probe; the probe recorded that observed version rather than establishing a release-wide exact-version gate. Future admission/release checks must dynamically obtain and record the selected installed executable's own `--version` output, reject missing, malformed, ambiguous, or nonzero output, and bind prepared, live, and recovery work to that exact executable/version; an owned `0600` generated MCP config was materialized; and the exact strict profile argv `--safe-mode --tools "" --strict-mcp-config --mcp-config <owned-generated-file> --setting-sources ""` was executed before both `--version` and `auth status --json`. Both exited `0`. The CLI consulted its own subscription state and the harness retained only bounded evidence `loggedIn=true`, `authMethod=subscription` (vendor reports `claude.ai`), and `apiProvider=firstParty`. The harness never reads, returns, or handles credential material. The profile preserved the signed-in macOS user's real `HOME`, left `CLAUDE_CONFIG_DIR` unset for vendor Keychain ownership, and set only an owned `cwd`/`TMPDIR` plus allowlisted identity/runtime values. No model streaming/MCP tools/hooks or other subscription-consuming turn were used.

The strict controls are: `--safe-mode --tools "" --strict-mcp-config --mcp-config <owned-generated-file> --setting-sources ""`; an opaque private workspace; bounded `0600 O_EXCL|O_NOFOLLOW` MCP materialization; pinned canonical executable identity and revalidation; required ownership UID evidence; fail-closed canonical profile/materialized-config environment validation; bounded redacted allowlisted metadata probes with owned process-group SIGTERM→SIGKILL cleanup; and fail-closed version/auth evidence. `--bare`, credentials/tokens/provider variables, inherited runtime seams, custom plugin inputs, and post-build runtime-env mutations are rejected. The opt-in real strict-metadata test passed with 142/142 tests; strict fixture typecheck and full package lint passed under Node `22.23.2`; and `git diff --check` passed. This is metadata/profile evidence only; T04 still requires a separate protocol exchange.

## T04 offline protocol-fixture reliability evidence

The T04 artifact is intentionally limited to sanitized offline data. `ClaudeJsonlProtocolParser` counts UTF-8 bytes before decoding, incrementally decodes chunks, handles LF/CRLF framing while preserving bare CR as content, and fails closed on invalid UTF-8, byte/line/compact-frame/frame-count/JSON-shape limits, malformed JSON, non-object values, unknown frame types, malformed control frames, explicit session mismatches, and partial EOF. Errors contain only bounded codes plus the accurate offending line/received-byte metadata and never echo a raw line. JSON validation rejects non-finite numbers and independently bounds object keys and strings; structured output accepts any bounded `JsonValue`, including arrays and scalars.

The normalized event union covers session init/status, text stream delta, final text, structured value, error, and bidirectional control request/response/cancel. Structured and control payloads are validated and redacted before they leave the parser; unknown wire fields are discarded. Command construction rejects inline or split duplicate session controls, validates the hidden/version-bound SDK-observed `--max-turns` switch, and bounds serialized `--json-schema`. The live adapter recognizes the fixed named scenarios start, exact resume, distinct fork, structured output, and cancellation; each scenario uses one `--max-turns 1` child as part of that workflow. With `--safe-mode`, MCP/tools/approvals are intentionally out of T04 and owned by T06/T07. Unsupported historical frame details are recorded only as the generic `protocol-invalid/unsupported-frame` diagnosis. `spawnClaudeProtocolProcess` uses `BoundedResourceScope.spawn` and inherits exact scope-owned process-group cleanup.

Dedicated validation under Node `22.23.2` covers the offline protocol suite, live-harness dry orchestration, separate recovery-campaign dry orchestration, fixture typecheck, package lint, and `git diff --check`; the focused protocol/live-harness/recovery run is 148/148 and the full subscription-runtime run is 238 passed with 6 expected sandbox skips. Source-visible opt-in markers are accidental-spawn gates only; injected runners are explicitly `dry-simulated` and cannot produce `live-tested` evidence. The operator-reported baseline records T1 start, T2 exact resume, and T3 distinct fork completed; T4 structured output was dispatched but ended `unknown_after_dispatch`/`unknown_recovery` with the generic `protocol-invalid/unsupported-frame` diagnosis, and T5 cancellation was unattempted. No tool, approval, hook, structured replacement, cancellation, or replay turn was run. Any nonzero child exit after user dispatch is likewise `unknown_recovery`/`unknown_after_dispatch`, never an ordinary failed provider turn. T04 remains unchecked: the live evidence is version-bound and the T4 external outcome is unresolved.

### T04 recovery reconciliation (2026-09-15)

The original campaign is preserved only as fixed operator-reported evidence: T1/T2 succeeded with the same opaque session hash, T3 forked to a distinct target hash, T4 was dispatched but remains `unknown_after_dispatch`/`unknown_recovery` with a generic `protocol-invalid/unsupported-frame` diagnosis, and T5 was unattempted. It is not treated as an authoritative binding to an original ledger. The separate offline recovery campaign stores that baseline under a distinct campaign ID and admits only the two named ordered scenarios (structured replacement followed by cancellation). Its recovery ledger models `reserved` → `running` → terminal transitions and refuses to start or complete cancellation until structured replacement is durably completed successfully. Its private 0700 fixture directory and 0600 evidence file require current-user ownership, canonical realpaths, stable device/inode identity, and exclusive no-follow creation; symlinked, non-private, non-owned, or tampered paths fail closed before any outside write. It never overwrites or reuses the original T4 reservation and no replacement/cancellation model turn was launched. Unknown timings, byte counts, exact wire payload, and raw content/PII are not reconstructed.

For the live probe, a nonzero child exit after the user frame is written is an uncertain external outcome and must be classified as `unknown_recovery`/`unknown_after_dispatch`, not as an ordinary failed provider turn. The current offline validation is 148/148 focused tests and 238 full subscription-runtime passes with 6 expected sandbox skips; T04 remains unchecked.

Isolated recovery recording (2026-09-15; append-only external evidence): campaign `3f5X3d` dynamically admitted Claude `2.1.270` and dispatched one structured-replacement turn. It ended `unknown_recovery`/`unknown_after_dispatch` with bounded `protocol-invalid` / `malformed-frame` evidence at line `8` and `20792` bytes; session hash `7499528543ce427b`, initialize-request hash `b766d0e324f1a790`, ledger SHA-256 `b0ba6ce66eaf790f0dbcf78479523841a561eca2886da2ce1822020c573d80f4`, and structured-fixture SHA-256 `467335e6b2cbea1e8d688d3459d8df6278f673272fcb22215d0aae2def44e114`. No final/structured result or marker was observed. Cancellation remains reserved, unstarted, and prohibited because structured replacement did not complete. A separate `7149RJ` setup failed `profile-not-ready` before dispatch with zero Claude model calls; its pre-start ledger SHA-256 is `df7de30a8564103c86d52f4f558d2ebeca34d69863a48bd652782eed5c652da4`, with no replacement fixture or cancellation dispatch. Temporary schema-incompatible ledgers remain external evidence only; no raw prompts/events/secrets were copied. The original T1–T3/original-T4/T5 campaign evidence remains unchanged and no ambiguous dispatch was replayed. This is a bounded recovery workflow, not an application-wide Claude-call cap. Post-validation is 148/148 focused tests and 238 passed with 6 expected skips in the full subscription-runtime suite; T04 remains unchecked until the ambiguous replacement outcome is reconciled.

## What is a hard gate, and what is reported after the fact

Use three explicit classes instead of a blanket block-by-default rule:

1. **Hard correctness/safety gates**: schema validation, configured-Mastra-tool authorization and approval, a required pre-tool guardrail, and structured output consumed by a workflow. These must be known before the relevant vendor request or tool execution. If no tested bridge exists, reject that operation before its protected effect.
2. **Mapped execution semantics**: initial input processing, selected memory modes, configured tool callbacks, cancellation, and stream/result translation. Admit them only after their actual runtime mapping is tested. A dynamic value is checked after Mastra resolves it and before the next controllable boundary; it is not guessed from a function name.
3. **Auxiliary/best-effort work**: title generation, score dispatch, optional traces, and optional usage display. Preserve Mastra's current completion semantics. A future adapter may record a separate outcome and retry only that safe auxiliary task; neither persisted/retryable outcome is current M-C behavior. A caller may opt into a future critical-finalization policy, but that must be explicit and cannot be inferred from the presence of a title or scorer.

This classification is a product decision. The repository facts supporting it are that title generation is fire-and-forget and catches its own errors (`agent.ts` `#executeOnFinish`), agent scorers are dispatched without awaiting `runScorer`, and `map-results-step.ts` catches `executeOnFinish` errors before invoking the ordinary finish callback. Current M-C therefore does not supply a persisted/retryable auxiliary outcome; treating all of these as hard prerequisites would change current Mastra behavior.

## Product-impact decision table

These missing contracts have observable product consequences; they are not only adapter implementation details:

| If we silently lose this behavior | Impact on the product |
|---|---|
| Request rewriting/cache or input processors | Wrong context reaches the model, expected cached output changes, and extra subscription requests occur |
| Per-step guardrails or tool-result redaction | An action may execute before policy checks, or unprocessed content may reach the model, UI, or stored conversation |
| Memory observers/recall/persistence | Conversations forget or duplicate information, resume with inconsistent context, or show history that differs from the runtime |
| Approval/client-tool/suspend correlation | Tools can run without the intended decision, waits can hang, or a late result can be applied to the wrong turn |
| Workflow retry/recovery semantics | A workflow may repeat external actions, lose its continuation, or misleadingly display a partially executed run as successful |
| Structured output | A later workflow step receives invalid data and fails far from the original cause |
| Titles/scorers/finalization | The answer appears successful while thread metadata, memory, evaluation results, or required completion actions are missing |
| Exact telemetry required by a policy | Limits, audit checks, and evaluations can make decisions from incomplete or fabricated information |

The decisions below prevent those outcomes. A known missing **critical** dependency blocks at the latest safe boundary. A future adapter may record an auxiliary dependency failure separately; current M-C behavior cannot retroactively invalidate or replay earlier work merely because `executeOnFinish` caught an error.

| Active behavior | Repository dependency | Required runtime behavior | Decision when missing or unknown |
|---|---|---|---|
| Ordinary generate/stream | `Agent.#execute` and prepare-stream in `packages/core/src/agent/agent.ts:7230` and `packages/core/src/agent/workflows/prepare-stream/stream-step.ts` | Ordered input, stream, error, abort, structured result, and finish events | Block real turn before vendor request |
| Initial input processors | `prepare-memory-step.ts` calls `runInputProcessors` | Preserve message/context/policy changes and TripWire | Run/check at the normal preparation point. If a critical TripWire mapping is unavailable, stop before the first vendor request; do not claim that an existing memory-thread write can be rolled back |
| Per-step input processors | `runProcessInputStep` in `llm-execution-step.ts` | Apply per-step message/model/tool/tool-choice/state changes | Block agent/workflow step unless host loop or equivalent callback exists |
| Request processor/cache | `runProcessLLMRequest` can rewrite prompt or replay `CachedLLMStepResponse` | Intercept before provider request; replay portable chunks; pair cache write correctly | Block cache-enabled operation; never silently make a live request |
| Response processor/cache | `runProcessLLMResponse` runs after a real response and is skipped for replay | Write/sink only completed non-cache responses with request/raw metadata as available | Block required cache/sink or mark explicit non-cache mode |
| Output stream processor | `runOutputProcessorsForStream` mutates/filter chunks | Process before exposing chunks to Studio | Block required redaction/guardrail; best-effort only by explicit policy |
| Output-step processor | `runProcessOutputStep` runs before tool execution | Inspect step and retry/abort before any tool call | Block if no event barrier; do not run tool first |
| Tool-result processor | `runProcessToolResult` runs before append/next model call | Process configured tool result inside host callback or equivalent bridge | Block affected tool/step before execution; native post-hook alone is partial |
| API-error processor | `runProcessAPIError` can rotate response ID and request bounded retry | Distinguish abort, protocol, provider, tool, and retryable errors | Block required error policy; never blindly retry a side effect |
| Final output/finalizer | `executeOnFinish` persists memory, dispatches title/scorer work, ends traces, and invokes `onFinish`; `map-results-step.ts` catches its error before the ordinary finish callback | Preserve the host ordering and each task's existing sync/async contract | Current M-C catches/logs the finalizer error and continues to `onFinish`; it does not persist a retryable auxiliary result. A future explicit strict-finalizer or auxiliary-outcome policy must be tested separately and must not replay the turn |
| Configured Mastra tool | `Tool.execute` and `CoreToolBuilder` context/schema wrapping | Preserve input/output schemas, request context, actor, workspace, abort, tracing | Block tool call before `execute`; capability error may be returned to active agent |
| Approval | `tool-call-step.ts` approval chunks and durable decision | Persist pending approval and resume with explicit decision | Missing bridge blocks the protected configured tool or native opt-in, not unrelated chat. A denial/timeout never executes the protected action |
| Suspend/resume | Tool suspend/resume schemas and workflow snapshot | Persist vendor/request/tool/run IDs and resume data | Enter `suspended`; if exact continuation unavailable, `unknown_recovery`/recoverable failure |
| Client/browser tool | Mastra two-request client result path | Keep turn open and correlate follow-up result | Block client tool before call if bidirectional bridge absent |
| History memory | `prepare-memory-step.ts`, message persistence | Load/save the selected thread/resource and preserve ownership | Reject a statically known unsupported mode before start; otherwise check at normal preparation and never claim a dynamic rejection rolled back an already-created thread |
| Working memory | Memory state processors/tools | Preserve state updates and context snapshots | Block working-memory mode or explicitly select history-only mode |
| Semantic recall/rerank | Embedding/vector/reranker dependencies | Resolve configured host models before recall | Reject when the dependency is known missing; no API-key fallback. Dynamic resolution follows normal preparation and reports any prior storage mutation honestly |
| Observational memory | Memory processor input-step/output-result persistence | Preserve observation turn/token state and message rotation | Block OM-enabled run if required phases unavailable |
| Title generation | `executeOnFinish` transitive model/storage call | Preserve existing asynchronous title dispatch and separate status | Do not block the main turn solely for title generation. If title is later declared critical, preflight that explicit policy; any persisted/retryable failure outcome is future adapter contract, not current M-C behavior |
| Scorers/judge agents | `executeOnFinish`, `packages/core/src/evals/base.ts`, eval run paths | Preserve agent scorer dispatch and evaluate standalone jobs independently | Agent scorer dispatch is asynchronous today; it cannot block or rewrite the chat result. A scorer/dataset job requiring a judge admits that judge before its own job starts |
| Dataset/eval generation | Independent model consumer, not subject-agent stream | Admit subject and judge/generator runtimes independently | Block its model execution; an auditable blocked job record is allowed; no API-key fallback |
| Traces/usage | model/tool spans, `onFinish`, usage metadata | Map emitted spans/events and record unavailable fields | Telemetry is best-effort by default. Block only an explicit hard limit/audit whose declared decision cannot be made without that field |
| Workflow agent step | `run-agent-entry.ts` consumes stream/result and TripWire | Return validated result while Mastra owns graph/run state | Block step before provider request |
| Workflow retry | workflow snapshots/retry paths | Preserve Mastra's existing retry model and add outcome certainty to external calls | Never automatically replay an uncertain external effect; expose recovery. Do not require every existing arbitrary tool to invent an idempotency mechanism |
| Workflow time travel | graph/snapshot divergence validation | Branch/fork external session and side-effect policy | Reject unchanged snapshot when no safe branch policy |

## Requirements and dependency declarations

The runtime contract needs a machine-readable requirement set, rather than a provider-connected boolean. It must be able to express:

- processor phases: `input`, `inputStep`, `llmRequest`, `llmResponse`, `outputStream`, `outputStep`, `toolResult`, `apiError`, and `outputResult`;
- request-cache replay/write, structured output, `maxSteps`, tool choice, and per-step callback needs;
- tool semantics: schema validation, request context, actor/workspace/browser, approval, suspend/resume, client execution, nested agent/workflow calls, and idempotency;
- memory modes: history, working memory, semantic recall, rerank, and observational memory;
- required telemetry level, usage fields, titles, scorers, judge/generator calls, and workflow recovery policy;
- selected native skills, commands, built-in tools, plugins, and subagents.

A processor or `prepareStep` function may be dynamic. Mastra already evaluates such functions as part of normal preparation, and arbitrary application code cannot be treated as side-effect-free merely because the adapter is inspecting it. Do not add mandatory declarations that make existing dynamic configurations unusable. Instead, capture statically visible requirements when available, resolve the function only at its normal Mastra lifecycle point, then validate the effective options before the next controllable vendor request or tool call. An optional declaration API may make early Studio diagnostics stronger; it is not a substitute for the runtime check.

If a dynamic function first requires an unmapped host-loop phase after a vendor step has already occurred, the adapter must stop at the next safe boundary, preserve the partial result, and report the precise semantic gap. It must not pretend that it prevented the prior step, replay the session, or claim whole-run atomicity. Configurations that require a whole-run guarantee should opt into a declared bounded profile; this is a product constraint, not a hidden requirement for every existing agent.

Optional metadata must not be used to infer that a security, moderation, authorization, or redaction processor is optional. Declare enforcement requirements separately from optional output metadata. A missing nonbreaking vendor telemetry event may be recorded as unknown; a malformed required approval/control frame is a blocking runtime error.

## Native-extension isolation

Configured Mastra tools are the default capability surface. The runtime launcher, rather than a prompt or Studio checkbox, must create that surface. For Claude, `--allowedTools` only auto-approves tools; it is not a whitelist. The tested baseline is a generated, scoped MCP configuration with `--safe-mode --tools "" --strict-mcp-config`, `--setting-sources ""`, and a live subscription-auth probe. Real macOS `HOME` and unset `CLAUDE_CONFIG_DIR` preserve vendor-owned Keychain auth; `cwd`/`TMPDIR` remain owned. `--bare` is rejected because it disables subscription credential lookup, and custom plugin/extension inputs are rejected by the baseline.

Claude hooks may run concurrently and competing argument rewrites are nondeterministic. Route Mastra's ordered processor chain through one generated relay per run; do not install one native hook per processor and then claim Mastra ordering. The documented CLI integration paths are generated HTTP/MCP/command hooks and the MCP `--permission-prompt-tool`; executable control symbols such as `hook_callback` remain an experiment until a versioned live fixture proves the wire.

Codex must likewise treat user/project configuration, hooks, MCP servers, skills, plugins, and their environment/MCP dependencies as part of the effective capability profile. Generated settings alone are not proof that inherited hooks are absent. Its direct dynamic-tool path is experimental; host authorization remains authoritative for configured Mastra tools. A selected native skill or built-in tool is admitted only after its required permissions and dependencies are enumerated and its requested capability is explicitly opted in.

Codex MCP hook errors, missing servers, and unavailable hook tools do not block execution according to the documented lifecycle. Hosted WebSearch and some specialized paths are outside normal pre/post-tool coverage. These hooks cannot be the sole mandatory enforcement gate; use host-controlled Mastra tool dispatch and separately verified native controls. See [Codex hooks](https://learn.chatgpt.com/docs/hooks). Configured hook presence alone is not proof of enforcement.

## Admission checks and timing

### Configuration admission

When Studio saves or selects a Claude runtime, dynamically invoke the selected installed executable's own `--version` command and record the executable identity and observed version. Reject missing, malformed, ambiguous, or nonzero version output before admission; do not use a hardcoded Claude version range. Bind the prepared profile, live process, and recovery campaign to that recorded executable/version and reject any drift. Then check the authentication/status command, baseline stream/control protocol, and declared native capability flags. An idle process and handshake are allowed. The status response must distinguish `ready`, `degraded`, and `blocked` and list the exact operation requirements that remain unresolved.

### Agent admission

Before starting a real vendor turn, resolve the effective tool catalog that Mastra preparation actually produces (assigned tools, toolsets, memory/workspace/browser tools, delegates, and processor-injected tools where applicable), critical processors, active memory modes, structured output, and native opt-ins. Do not treat independently invoked dataset/evaluation work or optional title/telemetry as a transitive chat prerequisite. A draft configuration may be saved with compatibility diagnostics.

The catalog includes configured client, workflow, skill, and controller-mode sources and must honor `activeTools` and existing hooks. `Tool.execute()` alone is insufficient for tool-result processor parity: normalize vendor calls into host `MessageList`, steps, IDs, and processor state, then process the result at the required boundary before returning it. This state mapping needs contract tests.

### Workflow admission

Server/UI entry points may inspect statically reachable workflow agent steps before start to provide early diagnostics. They cannot promise “no snapshot or lease” through the existing public API: `Workflow.createRun()` intentionally persists a normal `pending` snapshot before `Run.start()` invokes its start callback. Put the enforceable subscription check before each external agent/tool boundary, and use the existing start callback for run-level checks. A blocked run may therefore have a normal pending snapshot, but it must have no vendor request or tool effect.

### Dynamic admission

After request context, `prepareStep`, dynamic processors, or dynamic tool selection resolve, and immediately before the provider turn or tool call, recompute requirements. If a capability is missing, reject before that side effect. If earlier workflow steps already completed, preserve that partial workflow state and report the failing step; the guarantee does not roll back normal storage writes or earlier committed steps.

### Resume/restart admission

Reload the recorded executable identity/version, capability ledger, vendor session/thread IDs, pending approvals, suspend payloads, and outcome records before resume/restart/time travel. Re-observe the selected installed executable's version and fail closed on missing, malformed, ambiguous, nonzero, or changed output; do not silently resume an in-flight operation with a different executable/version or capability set. If a completed session is unavailable, create a deliberately labelled fresh/forked continuation from Mastra's authoritative history only when no pending or uncertain external effect exists. If an in-flight effect may have committed, enter `unknown_recovery` until reconciliation establishes its outcome.

### Completion and auxiliary work

Before marking an agent or workflow step successful, verify required structured-output validation, required output processing, and workflow commit. Preserve Mastra's existing title/scorer/optional-trace behavior: those tasks may start after the primary response and have independent status. A future caller may explicitly require a finalizer, but a failure must never rerun the main model turn because that could duplicate tools or subscription usage.

## Side effects, retries, and recovery

A tool-call ledger alone cannot guarantee exactly-once execution. A process can die after an external service commits but before Mastra records the result. Mastra's current tool context provides call/run identity, but no generic idempotency-key contract, and injecting a new input field would break strict tool schemas or be ignored by downstream services.

The adapter must therefore record an **outcome certainty** for every external call: `not_started`, `completed`, `failed_before_start`, or `unknown_after_dispatch`. Existing arbitrary tools remain usable with their current at-least-once/manual-recovery semantics. A tool author may opt in to stronger recovery by accepting an invocation identifier from context and documenting idempotent or reconciliation behavior. Only then may the adapter reuse that identifier after a failure; it must not claim exactly-once merely because a local ledger contains a stable key. Approval records must be durable before invocation; denial, timeout, cancellation, or process death must not be treated as successful execution.

For vendor-native tools, use the vendor request/item IDs and a separately tested reconciliation policy when one exists. Native MCP-hook errors, a missing MCP server, and unavailable tools must not be the sole enforcement path: the host gate remains authoritative for configured Mastra tools. An opted-in native tool is rejected only when its explicitly required approval/guardrail cannot be enforced. For configured Mastra tools, host execution can run `processToolResult` before returning the result to Claude MCP or Codex dynamic tools; vendor-native `PostToolUse` is not required to preserve the host result-processor contract in that path.

Workflow time travel creates a branch from a stored snapshot. If the target graph includes an external agent/tool step whose side effects are not replay-safe, require a provider/session fork and side-effect policy. Otherwise reject without altering the stored snapshot. A workflow process failure after previous steps must retain those steps and expose a recoverable state; it must not claim the whole run never happened.

## Studio and server consistency

The same admission result and capability error schema must be used by:

- Studio provider/runtime status, agent editor, and run controls;
- ordinary `agents` generate/stream handlers;
- AgentController session creation, send, approval, abort, and resume;
- workflow create/start/stream/resume/restart/time-travel/cancel and agent-step execution;
- scorer/eval/dataset job creation where a subscription runtime is selected.

A runtime may be baseline-ready for chat while a particular agent is blocked by semantic recall, request caching, a critical approval path, or client tools. Scorer and dataset jobs have their own readiness rather than blocking an unrelated chat. Studio must show the operation-level blocker before the user starts it. Server handlers must repeat the check because direct HTTP/workflow calls bypass Studio UI.

Compatibility failures must not disable cancellation, denial, inspection of prior results, draft editing, or recovery diagnostics. Those actions remain available to stop and understand an incompatible run. Compatibility checks on resume or approval acceptance prevent new execution; they must not trap an existing operation by blocking its cancellation path.

## Negative acceptance checks

The following are release checks, not suggestions:

- A request-cache processor hit causes no vendor turn; replay uses fresh run metadata and does not write the cache again.
- A cache-enabled operation is blocked before the relevant real turn when the adapter cannot intercept requests; an idle status/handshake process is allowed.
- Input-step changes to tools/model/settings are visible to the turn; otherwise admission blocks.
- An output-step TripWire prevents tool execution, and retry count cannot exceed the declared bound.
- Tool-result redaction happens before persistence and before the next provider request.
- API-error retry rotates the response ID and never blindly reruns an already executed side effect.
- Abort is stored as aborted, not provider failure or successful completion.
- A statically known missing semantic-recall/OM/working-memory dependency rejects before start; dynamically resolved failures report any existing thread mutation rather than claiming rollback.
- Title/scorer/optional-trace failure does not rerun or rewrite the main turn. A future adapter may persist an auxiliary outcome; current M-C behavior does not promise one. An explicitly critical finalizer is tested separately.
- Approval denial, reconnect, duplicate approval, and suspend resume do not double-invoke a tool when the outcome is known. An unknown dispatched external call is not retried automatically and is shown for reconciliation.
- A dynamic processor/tool requirement resolved before a provider/tool boundary blocks that boundary when unsupported. If it emerges after vendor work, the partial state and exact semantic gap are retained.
- Route-level workflow preflight may reject before `createRun`; public `createRun()` is allowed to retain its normal pending snapshot. In either case, a blocked agent step makes no vendor/tool call.
- Dynamic workflow failure preserves previously committed steps and marks the current step recoverable/failed.
- Time travel with unsafe external side effects leaves the stored snapshot unchanged.
- A child process exit between external dispatch and ledger write enters `unknown_recovery`; automatic retry waits for a tool-provided reconciliation/idempotency policy.
- Nonbreaking unknown telemetry events are recorded and tolerated; malformed required control/approval frames block the run.
- Subject chat readiness does not make scorer judges or dataset generation ready; those jobs are admitted separately.
- No path silently selects an API-key model when subscription runtime admission fails.
- Claude baseline isolation proves that `--allowedTools` was not mistaken for a whitelist, inherited MCP/hooks cannot reach the turn, and the one relay preserves ordered Mastra processor decisions.
- Codex baseline isolation proves the effective inherited config/hook/skill/plugin surface, and an opted-in native capability is rejected only when its required control cannot be enforced.
- Direct `Agent.network()` with an existing thread enforces the same ownership rule as the HTTP route, or fails closed before memory/vendor access.
- Network start/resume with missing or conflicting owner metadata fails closed; approval/decline requires `AGENTS_EXECUTE` plus persisted run owner/FGA, not only a caller-supplied `runId`.
- Concurrent unclaimed network resumes have one atomic CAS/lease winner and cannot duplicate a tool or other protected effect.

## Release gate

A Claude release is complete only for an explicit, tested capability profile that covers the requested registered-agent, configured-tool, and workflow-agent-step paths without silently changing critical semantics. The gate requires dynamic version-observation/admission tests against the installed executable, proof that prepared/live/recovery phases share the recorded version identity, sanitized control/event fixtures, boundary-preflight tests, Studio/server parity, and the negative checks above. It cannot be declared complete by presenting a working chat demo while required configured-tool or workflow behavior is unresolved.

Best-effort telemetry, titles, and asynchronous scorer dispatch retain their existing behavior and are reported as such; they do not make the baseline profile a silent subset. A profile that omits a critical requested behavior must be labelled as a scope gap, with its affected configuration path. Native skills, commands, built-in tools, plugins, and subagents remain explicit opt-ins and must not expand the configured Mastra tool set implicitly.

Codex inherits the same gate after its local app-server capability negotiation. The app-server's experimental status, generated-schema version, and active hook/dynamic-tool support must be visible in runtime status. Local stdio is a deployment choice, not evidence that version or semantics are stable.

Repository anchors: `packages/core/src/agent/agent.ts`, `packages/core/src/agent/workflows/prepare-stream`, `packages/core/src/processors/index.ts`, `packages/core/src/processors/runner.ts`, `packages/core/src/loop/workflows/agentic-execution/llm-execution-step.ts`, `packages/core/src/tools/tool.ts`, `packages/core/src/tools/tool-builder/builder.ts`, `packages/core/src/loop/workflows/agentic-execution/tool-call-step.ts`, `packages/core/src/workflows/entry-executors/run-agent-entry.ts`, `packages/core/src/workflows`, `packages/core/src/memory`, `packages/core/src/evals`, and `packages/server/src/server/handlers/{agents,agent-controller,workflows}.ts`.

## Transitive consumer notes

`MastraLLMVNext.stream()` in `packages/core/src/llm/model/model.loop.ts` composes `maxSteps` with `stopWhen`, creates model spans, tracks per-step inference context, and passes processors, approval, structured output, and callbacks into the loop. A vendor `max-turns` flag is only a candidate mapping; admission must compare stop behavior and bounded continuation.

`prepare-memory-step.ts` intentionally persists a new memory thread before output processors can save messages. A runtime check should run as early as the adapter can place it, but this existing storage ordering means it cannot honestly promise “no memory mutation” for every rejected dynamic configuration. Resume skips initial input processing because the workflow snapshot contains the conversation; an adapter cannot rerun input processing on an empty resume message list and call that equivalent.

`run-agent-entry.ts` forwards streamed chunks to workflow output and turns an agent TripWire into workflow behavior. When a step declares structured output but finishes without an object, it fails the step. The subscription adapter must preserve this failure instead of returning text as a successful structured result.

`executeOnFinish` is a transitive dependency boundary: a main answer may have streamed successfully while host work follows. Its details matter: message/history persistence is handled by processors, title generation is deliberately fire-and-forget with its own error handling, and `#runScorers` dispatches scorers without awaiting them. `map-results-step.ts` catches an `executeOnFinish` error before continuing the ordinary finish path. Current M-C therefore does not provide a persisted/retryable auxiliary outcome; a future adapter may add one, but must never re-enter the main model turn merely to repair it.

The eval code creates judge agents independently of the subject agent. A working subscription chat runtime therefore cannot be advertised as a working scorer/dataset runtime without a separate admission record for the judge or generator model.

Workflow snapshots and time-travel checks are Mastra-owned. A vendor session ID supplements a snapshot; it does not replace the graph, step results, resume labels, or divergence checks. Preserve normal pending/progress/suspension snapshot writes and record provider continuation metadata alongside them. Do not falsely commit a completed step result before execution finishes or overwrite the original branch during recovery.

## Proposed admission record

The implementation can represent each decision with a record such as:

- operation kind: agent turn, controller turn, workflow start, workflow step, resume, scorer, dataset job;
- agent/workflow/step IDs and Mastra run ID, when a run exists;
- provider name, executable/app-server version, protocol profile, and authentication/status result;
- required capabilities, observed capabilities, and unresolved/unknown capabilities;
- policy profile: tested baseline plus any explicit critical extension; a future adapter may record best-effort title/scorer/telemetry outcomes separately;
- side-effect boundary: no turn, tool allowed, workflow state committed, or `unknown_recovery`;
- remediation and the validation timestamp/fixture version.

An admission record is explanatory state, not a workflow result. A blocked draft may be saved for editing. A blocked real run must not be reported as a successful workflow or agent result. A `degraded` profile is valid only when its omissions were explicitly selected and are reflected in Studio and server responses.

## Error and retry boundaries

The adapter should keep four error boundaries distinguishable: preflight capability error, vendor transport/protocol error, model/provider error, and tool/external-side-effect error. Processor policy can act on the latter three only when the adapter supplies the required payload and retry/abort semantics.

A protocol error before a turn starts can leave the operation `blocked` or `failed` without a model side effect. A protocol error after a vendor request is sent is an execution failure; the adapter must preserve the partial stream and determine whether the provider turn or tool call committed. If the answer is unknown, use `unknown_recovery`, reconcile, and avoid automatic replay.

A failed workflow step can be retried only according to the step's retry policy and side-effect record. A later dynamic capability failure does not erase earlier successful workflow steps. Studio should show the completed prefix and the blocked/failed current step so the user can recover deliberately.
