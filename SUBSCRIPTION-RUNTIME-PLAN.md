# Studio subscription runtime implementation plan

Status: capability reassessment completed; implementation and live model/protocol compatibility testing not started.

Revision: 2026-09-14, following independent parallel Terra high and Luna xHigh reviews of source contracts, vendor interfaces, and failure/recovery policy. The revisions preserve Mastra's existing dynamic resolution and asynchronous auxiliary work; they do not introduce a universal strict-completion policy as a side effect of adding runtimes.

Product compatibility is a release requirement, not a best-effort property. The intended scope is not fulfilled merely by disabling incompatible features. Every unresolved requirement for the requested agent/tool/workflow scope remains a release blocker until implemented or explicitly removed from scope by the user.

This records the repository research and agreed decisions from the planning conversation. The initial assessment was too narrow: existing adapter gaps are not proof that native runtime features cannot preserve Mastra behavior. The revised design considers hooks, host callbacks, dynamic tools, skills, commands, subagents, compaction, session branching, and native extension mechanisms.

See [SUBSCRIPTION-RUNTIME-CAPABILITIES.md](SUBSCRIPTION-RUNTIME-CAPABILITIES.md) for the detailed capability inventory, Mastra contract mappings, evidence levels, and validation cases. Read-only local inspection found Claude Code `2.1.270` and Codex CLI `0.154.0`. Help output, generated schemas, documentation, and observed protocol symbols establish available interfaces; no live model/tool/hook round-trips were performed during research.

Classify research evidence as documented native capability, host-bridge design, version-dependent interface, verified semantic difference, or untested mapping. Do not label a whole feature impossible because the current SDK wrapper does not implement it. Experimental interfaces remain candidates with explicit version negotiation and tests. However, a candidate or unknown mapping does not qualify as supported when a real run requires that capability.

See [SUBSCRIPTION-RUNTIME-RELIABILITY.md](SUBSCRIPTION-RUNTIME-RELIABILITY.md) for the mandatory product-impact decisions, compatibility checks, failure/recovery behavior, and release gates. It governs how the capability inventory is used during implementation.

## Confirmed scope

- Target: Mastra Studio web UI.
- Deployment: local, single user; Studio's server and the vendor CLI run on the same machine and under the signed-in user's account.
- Authentication: the user's Claude and ChatGPT subscriptions, without requiring an API key for supported agent execution.
- Delivery order: Claude Code first, Codex second.
- Coverage: ordinary registered agents, custom Mastra tools, AgentController sessions, and workflow agent steps. A separate coding-chat page alone does not meet the requirement.
- Tool default: the effective Mastra-resolved tool catalog for the agent/run, honoring `activeTools`, permissions, and hooks. This includes configured toolsets, memory, workspace, skills, browser, client, delegation, workflow, and dynamically loaded tools where Mastra already resolves them. Vendor-native shell, file-editing, browsing, and other tools require explicit per-agent opt-in and applicable approvals.
- Existing API-key execution remains available.

## Repository findings

Studio includes agent configuration/chat, tools, MCP integrations, workflows and runs, memory/resources, workspaces/skills, datasets, experiments, scorers, review queues, traces, logs, metrics, and provider settings. Route inventory: `packages/playground/src/App.tsx`.

The main Studio execution paths are:

1. Ordinary agent HTTP routes resolve the registered agent and call `generate()` or `stream()`: `packages/server/src/server/handlers/agents.ts`.
2. AgentController routes provide session-oriented streaming, approvals, cancellation, and steering: `packages/server/src/server/handlers/agent-controller.ts`.
3. Workflow execution owns its run lifecycle and invokes agent steps through the agent contract: `packages/server/src/server/handlers/workflows.ts` and `packages/core/src/workflows/entry-executors/run-agent-entry.ts`.

These are not an exhaustive agent execution inventory. `network()`/`resumeNetwork()` use `networkLoop` outside `Agent.#execute`; standalone durable execution and legacy entry points also need explicit coverage. Inventory and test each route before claiming all-agent support. They remain coverage tasks, not silently excluded APIs. Keep AgentController on its normal Agent stream/options path so mode instructions, active tools, and controller delegation continue to apply.

Existing integrations provide useful precedents but do not complete the requested Studio support:

| Component | Existing functionality | Gap |
| --- | --- | --- |
| `agent-sdks/claude` | Claude Agent SDK wrapper, streaming, sessions, structured output | API-key-oriented documentation; no Studio subscription setup; Mastra memory/tool parity is not automatic |
| `agent-sdks/openai` | OpenAI Agents SDK wrapper | This is not Codex or its ChatGPT-authenticated App Server |
| `agent-sdks/acp` | Generic ACP subprocess/session/permission handling | Current Claude CLI has no official documented ACP mode; third-party adapters require separate compatibility/authentication review |
| `mastracode/sdk/src/auth` | Existing subscription OAuth implementations | Not wired into Studio; direct provider transports have compatibility and authentication-policy concerns |
| `mastracode/sdk/src/agents/mastracode-gateway.ts` | Model gateway used by Mastra Code | Reusing its private/provider-specific transport is not the selected approach |

Core agent preparation, tools, processors, memory, and execution options live in `packages/core/src/agent/`. Overriding `stream()` in a thin wrapper would not automatically preserve these behaviors. The concrete seam to investigate is `Agent.#execute` -> `createPrepareStreamWorkflow` -> prepared `loopOptions` -> `packages/core/src/agent/workflows/prepare-stream/stream-step.ts`. Generalize that runtime boundary while retaining host preparation and finalization instead of duplicating private processor internals.

## Selected architecture

Introduce an explicit local runtime selection at the agent execution boundary, shared by ordinary agent calls, controller mode agents, and workflow agent steps. Exact public API and package names remain implementation decisions.

- Claude backend: launch the locally installed, unmodified Claude Code CLI and use its existing authentication.
- Codex backend: launch local Codex App Server over stdio and use its managed ChatGPT authentication.
- Shared host bridge: execute the current agent's resolved Mastra tools and callbacks in Mastra. Claude can reach it through MCP, HTTP/command hooks, and version-tested control callbacks. Codex can use negotiated dynamic tool callbacks as well as MCP.
- Hook bridge: dispatch synchronous host functions through supported runtime callbacks or local hook relays; preserve allow/deny, argument mutation, context/feedback, and continuation decisions where the event contract supports them.
- Enforcement belongs at a verified execution gate, not any event named a hook. Codex MCP hook failures do not necessarily block execution; some native tools bypass the relevant hooks. Keep mandatory approval/result policy in the host tool bridge or a separately verified native enforcement path.
- Native extensions: support selected skills, commands, subagents, and procedural workflows alongside Mastra workflows. Enforce configured tool permissions across these extensions; enabling a skill must not implicitly enable shell/file/browser tools.
- Mastra owns workflow scheduling/execution, durable state, tool execution records, request context, authorization, and Studio-facing persistence.
- Vendor runtimes own their internal model/tool loops. Use their hooks and control surfaces to preserve required host behavior, with exact per-phase mapping rather than assuming turn-boundary callbacks are the only option.
- Studio receives status and execution events, never vendor access tokens.
- Shared compatibility checks resolve known requirements before vendor/tool execution and check dynamic values at their normal Mastra phase. Existing thread creation and pending workflow snapshots remain valid; promise no unsupported external execution, not zero local storage writes. Studio uses the same decisions as core/controllers/workflows; hiding a control is not enforcement.
- Every active dependency is inventoried, including memory, titles, scorers, model fallbacks, nested agents, and tool/workflow needs. Preserve current blocking versus asynchronous/best-effort semantics. Auxiliary title/live-score readiness is distinct from primary response readiness and may produce diagnostics without blocking ordinary chat.
- Runtime/configuration changes invalidate prior compatibility decisions. Unknown required behavior blocks the affected operation rather than being silently dropped or discovered after a side effect.

Do not implement subscription access by copying OAuth credentials, calling private ChatGPT/Claude endpoints, or silently routing through the existing API-key SDK wrappers. ACP is deferred until there is a concrete requirement and a verified subscription-compatible adapter.

Anthropic's current legal page expressly contemplates users authenticating to an unmodified hosted Claude Code binary with their own subscription, subject to its stated terms. Preserve that binary and its own authentication flow; do not turn this into a Studio credential intermediary, resold usage, or an assumed entitlement for a separate SDK route. See [Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance).

## Sequenced implementation to-dos

This is the authoritative execution checklist. The phase sections below retain detailed requirements and test cases; they do not imply that everything within a phase can start together. Task IDs define dependencies. Tasks marked complete below record only their delivered evidence; all remaining implementation and live model/protocol compatibility tasks are open.

Mark a task complete only when its deliverable exists and its associated checks pass. Record changed files, test commands/results, runtime versions where relevant, and remaining gaps beside the task. Technical gates are evidence-based engineering decisions, not recurring requests for user permission. A failed gate sends work back to its prerequisite tasks; it does not authorize dropping features.

### Milestone A — Resolve Claude feasibility before production integration

- [x] **T01 — Establish the contract and coverage baseline.** Depends on: none. Inventory modern agents, controller modes, workflow agent steps, networks/resumeNetwork, durable and legacy paths, effective tools, processors, memory, and auxiliary model calls. Deliver a case-by-case expected behavior and failure matrix, preserving current dynamic resolution and async title/scorer semantics. Use existing tests as the baseline and add focused characterization cases only where needed.
  Evidence (2026-09-14, T01 complete): Changed files: [SUBSCRIPTION-RUNTIME-CAPABILITIES.md](SUBSCRIPTION-RUNTIME-CAPABILITIES.md), [SUBSCRIPTION-RUNTIME-RELIABILITY.md](SUBSCRIPTION-RUNTIME-RELIABILITY.md), and this plan. Validation: `PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" pnpm --filter @mastra/core exec vitest run src/agent/agent-network.test.ts src/workflows/entry-executors/run-agent-entry.test.ts` — PASS (2 files, 91 tests; no type errors); `PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" pnpm --filter @mastra/server exec vitest run src/server/handlers/agents.test.ts` — PASS (1 file, 138 tests); `PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" pnpm --filter @mastra/hono exec vitest run src/__tests__/hono-adapter.test.ts` — PASS (1 file, 2,584 tests). Markdown relative-link/path inspection and whitespace checks also pass. Environment: Node `22.23.2` explicitly selected for T01; pnpm `11.21.0`; Claude Code `2.1.270`; Codex CLI `0.154.0`; local single-user macOS workspace. T01 itself included no authenticated/live vendor probe; the later T03 result is authenticated metadata/profile evidence only and is recorded below. No model, protocol, or subscription-consuming turn was run. Remaining release blockers: the newly evidenced network ownership gaps (direct/core existing-thread ownership, context-only start scope, persisted run identity, continuation FGA, legacy-owner fail-closed policy, and concurrent unclaimed-resume/CAS risk) are assigned to T08/T11/T15/T16/T18; V-F vendor model/protocol-turn/hook/dynamic-tool/resume gaps remain open. T01 is documentation/characterization complete, not runtime support.
- [x] **T02 — Build an isolated compatibility harness.** Depends on: T01. Create a disposable workspace, harmless test tools/MCP server, hook relay, event recorder/redactor, and bounded process cleanup. Separate protocol fixtures from authenticated probes; do not use real project tools or external side effects to discover protocol behavior.
  Evidence (2026-09-14, T02 complete): Changed files: `packages/mcp/package.json`, `packages/mcp/tsconfig.subscription-runtime.fixture.json`, and `packages/mcp/src/__fixtures__/subscription-runtime/{README.md,event-recorder.ts,harness.test.ts,harness.ts,hook-relay.ts,mcp-fixture.ts,process-cleanup.ts,redactor.ts,stdio-server.ts,types.ts,workspace.ts}`. The credential-free `protocol-fixture` harness provides strict loopback HTTP MCP/hook endpoints, a harmless schema-backed tool, bounded/redacted event recording, bounded hook/MCP/stdio shutdown, owned process/workspace cleanup, and negative coverage for malformed, oversized, overloaded, disconnected, and cleanup-failure cases. Validation: `git diff --check` passed; fresh Terra High `01a09d5d-bd5e-7222-8e73-40b31575c73f` ACCEPT/static review; fresh Luna `01a09d5d-98f1-7353-b79b-a6dd3ae73680` PASS/static review. Targeted runtime test/typecheck (`pnpm --filter @mastra/mcp test:subscription-runtime`; `pnpm --filter @mastra/mcp typecheck:subscription-runtime`) could not execute because local `tsc`/Vitest/dependencies are absent and pnpm registry resolution failed offline (`ENOTFOUND`), so this is an environment verification limitation, not runtime success. T02 itself ran no authenticated vendor probes or loopback external side effects.
- [x] **T03 — Prove Claude authentication and isolation.** Depends on: T02. Verify installed version, vendor-owned subscription status, controlled settings, disabled native built-ins, strict generated MCP configuration, and explicit rejection of ambient/custom extensions. Deliver the tested launch profile plus negative cases for inherited tools/hooks and accidental API-key selection.
  Evidence (2026-09-14, T03 complete; fresh Terra High acceptance and fresh Luna xHigh acceptance): Claude Code `2.1.270` was run from its canonical executable in this historical probe; the probe recorded that observed version rather than establishing a release-wide exact-version gate. Future admission/release checks must dynamically obtain and record the selected installed executable's own `--version` output, reject missing, malformed, ambiguous, or nonzero output, and bind prepared, live, and recovery work to that exact executable/version. An owned `0600` generated MCP config was materialized, then the exact profile argv `--safe-mode --tools "" --strict-mcp-config --mcp-config <owned-generated-file> --setting-sources ""` was passed to both metadata-only commands (`--version` and `auth status --json`); both exited `0`. The CLI consulted its own subscription state and the harness retained only bounded evidence `loggedIn=true`, `authMethod=subscription` (vendor reports `claude.ai`), and `apiProvider=firstParty`; it never reads, returns, or handles credential material. The probe used the signed-in user's real `HOME`, left `CLAUDE_CONFIG_DIR` unset for vendor Keychain ownership, and set only an owned `cwd`/`TMPDIR` plus allowlisted identity/runtime values. `--bare`, credentials/tokens/provider variables, inherited runtime seams, custom plugin inputs, and post-build env mutations are rejected. A real stubborn descendant is terminated through the owned process group with bounded SIGTERM→SIGKILL cleanup. No model session, protocol exchange, MCP tool, hook, or other subscription-consuming turn was run. Validation: `RUN_CLAUDE_STRICT_METADATA_PROBE=1 CLAUDE_EXECUTABLE=/opt/homebrew/Caskroom/claude-code@latest/2.1.270/claude pnpm --filter @mastra/mcp test:subscription-runtime` PASS (3 files, 142/142); strict fixture typecheck PASS; full `@mastra/mcp` lint PASS under Node `22.23.2`; `git diff --check` PASS. T04 still requires a separate protocol exchange.
- [ ] **T04 — Prove the basic Claude protocol.** Depends on: T03. Test streaming, final/structured output, cancellation, explicit session IDs, resume/fork, errors, and malformed control frames. Deliver sanitized fixtures and the parser/control contract; distinguish public interfaces from version-bound experiments.
-  Offline fixture evidence (2026-09-14; not T04 completion): `packages/mcp/src/__fixtures__/subscription-runtime/claude-protocol.ts` and its focused suite provide a bounded sanitized JSONL parser/control contract. Coverage includes UTF-8 chunk boundaries, CRLF and bare-CR framing regressions, partial EOF, invalid UTF-8, bounded line/received-byte metadata, total-byte/line/compact-frame/frame-count/JSON-shape limits, finite-number and key/string bounds, bounded structured `JsonValue`, malformed JSON/non-object/unknown frames, streaming/final/structured/error normalization, explicit session matching, resume/fork/cancel command construction, serialized `--json-schema` bounds, exact-ID control correlation, and strict cancellation normalization. The control/event shapes are labelled version-bound-experiment; documented stream/session CLI switches are public-documentation. The live workflow covers named start, exact resume, distinct fork, structured output, and cancellation scenarios, each using the version-bound SDK-observed `--max-turns 1` child setting. Because `--safe-mode` disables MCP, T04 has no MCP/tool/approval scenario; those cases move to T06/T07. The live adapter validates the selected executable's observed initialize/result/interrupt shapes, records only bounded markers/counts/hashes plus bounded `{wireCode,lineNumber,bytesReceived}` diagnostics, omits `session_id` from user frames, and keeps the interrupt receipt `{still_queued, cancelled}`. Raw partial streams require the observed message/block lifecycle and index correlation; unsupported historical frame details are recorded only as the generic `protocol-invalid/unsupported-frame` diagnosis. The dry harness and this partial live evidence do not constitute release readiness; T04 remains unchecked pending reconciliation.
-  Recovery reconciliation (offline only, 2026-09-15): `claude-live-recovery.ts` defines a separate immutable structured-replacement-then-cancellation workflow. Its durable ledger stores the operator-reported baseline as fixed external evidence, preserves T4 as `unknown_after_dispatch`/`unknown_recovery`, and admits only the two named recovery scenarios in order. Recovery reservations use explicit `reserved` → `running` → terminal transitions; cancellation cannot start or complete while structured replacement is reserved, running, failed, or otherwise incomplete. The bounded prior-evidence fixture is created only inside a current-user-owned real 0700 directory, with stable identity checks and 0600 `O_EXCL|O_NOFOLLOW` creation; tampered or symlinked paths fail closed without outside writes. No replacement or cancellation model turn was launched; T04 remains unchecked.
-  Isolated recovery recording (2026-09-15; immutable external evidence): campaign `3f5X3d` dynamically admitted the installed Claude `2.1.270` profile and dispatched exactly one structured-replacement turn. The outcome is `unknown_recovery`/`unknown_after_dispatch` with bounded `protocol-invalid` / `malformed-frame` evidence at line `8` and `20792` bytes; session hash `7499528543ce427b`, initialize-request hash `b766d0e324f1a790`, ledger SHA-256 `b0ba6ce66eaf790f0dbcf78479523841a561eca2886da2ce1822020c573d80f4`, and structured-fixture SHA-256 `467335e6b2cbea1e8d688d3459d8df6278f673272fcb22215d0aae2def44e114`. No final or structured result/marker was observed. Cancellation remains reserved, unstarted, and prohibited because the structured replacement did not complete. A separate `7149RJ` setup attempt failed `profile-not-ready` before dispatch with zero Claude model calls; its pre-start ledger is retained only as external evidence (ledger SHA-256 `df7de30a8564103c86d52f4f558d2ebeca34d69863a48bd652782eed5c652da4`), with no replacement fixture and no cancellation dispatch. These schema-incompatible temporary artifacts are not copied into the repository. The original campaign remains immutable (T1–T3 succeeded, original T4 remains `unknown_after_dispatch`/`unknown_recovery`, and T5 remains unattempted); no ambiguous dispatch was replayed. This recovery reservation workflow is not an application-wide Claude-call cap. Post-validation counts are 148/148 focused tests and 238 passed with 6 expected skips in the full subscription-runtime suite; T04 remains unchecked because the replacement outcome is unresolved.
- [ ] **T05 — Prove tools, function hooks, and approvals.** Depends on: T04. Test schema/result conversion, approve/deny, delayed client-tool results, input mutation, ordered processor dispatch through one relay, result processing before model continuation, hook timeout, and transport loss. Deliver a callback/ordering map; do not treat native hook naming or output-only JSONL as proof.
- [ ] **T06 — Probe context, extensions, and recovery boundaries.** Depends on: T05. Exercise compaction/context restoration, selected skills/commands, dynamic subagents, tool catalog changes, and process loss around a harmless tool call. Identify what can resume, what requires reconciliation, and which execution paths need a separate host adapter. Deliver the prototype results and remaining architectural decisions.
- [ ] **T07 — Close the Phase 0 technical decision gate.** Depends on: T01–T06. Update the capability and reliability documents with the chosen transport, tested version/profile, exact host-phase mappings, required enforcement barriers, and recovery strategy. Every required behavior must have an evidenced implementation path; if a fundamental contract cannot be represented, revise and retest the architecture before production integration. Do not convert an unresolved behavior into an implicit scope exclusion.

**Milestone A exit:** a reproducible Claude prototype and a concrete design decision. This is feasibility evidence, not production parity or permission to mark downstream tests complete.

### Milestone B — Define shared contracts, then implement the Claude foundation

- [ ] **T08 — Finalize runtime and persistence contracts.** Depends on: T07. Select package/API boundaries and define runtime selection, capabilities, normalized events, tool/hook callbacks, errors, session identity, stored recovery metadata, and schema/migration requirements. Map proposed states onto existing API/storage semantics. Identify separate integration points for network, durable, and legacy execution.
- [ ] **T09 — Implement shared runtime dispatch and compatibility checks.** Depends on: T08. Add the modern agent execution seam and checks at the normal preparation/dispatch boundaries, preserving API-key behavior. Deliver mock-runtime tests for supported execution, early known incompatibility, dynamically resolved incompatibility, and normal thread/pending-run writes. Do not expose the unfinished runtime as ready in Studio.
- [ ] **T10 — Implement Claude process and transport management.** Depends on: T08. Productionize the tested launcher, framing/parser, request correlation, cancellation, version checks, queues, authentication diagnostics, and process cleanup. Deliver transport tests using T03–T06 fixtures; no hidden API-key or mid-call transport fallback.
- [ ] **T11 — Implement session identity and execution records.** Depends on: T08. Add serializable Mastra/vendor run, thread, turn, item, tool-call, approval, and outcome mappings while keeping live handles in `RunScope`. Preserve pending/progress snapshots and provide version/config invalidation. Deliver storage/serialization tests and any required migration tests.
- [ ] **T12 — Connect one complete Claude agent turn.** Depends on: T09–T11. Wire ordinary `generate()`/`stream()` through host preparation, the Claude runtime, normalized output, and existing completion behavior. Verify text, schema output, abort, and error results through the generic agent contract; this remains an internal vertical slice.

**Parallel work after T08:** T09, T10, and T11 may proceed independently against the agreed contracts. T12 waits for all three.

### Milestone C — Preserve tools, processors, memory, and every execution path

- [ ] **T13 — Implement the effective Mastra tool bridge.** Depends on: T12. Reuse resolved toolsets, memory/workspace/skills/browser tools, client tools, agent/workflow delegates, processor-loaded tools, and controller `activeTools`. Preserve schemas, actor/request context, abort, hooks, and tracing. Deliver catalog and dispatch tests proving vendor-native tools remain opt-in.
- [ ] **T14 — Implement host processor state and callback ordering.** Depends on: T13. Maintain the `MessageList`, steps, IDs, and processor state required for supported input/output/tool-result phases. Implement the T07 decisions for request interception/cache, per-step options, retries, tripwires, and stream transforms. Deliver ordering and model-visible-result tests; `Tool.execute()` alone is not completion.
- [ ] **T15 — Implement approvals, client results, and tool suspension.** Depends on: T11, T13, T14. Persist pending requests and resume data; correlate accept/deny, client replies, duplicate/late replies, cancellation, and disconnect. Deliver tests proving no protected action runs before authorization and no reply is applied to the wrong turn.
- [ ] **T16 — Implement recovery and safe continuation.** Depends on: T15. Reconcile interrupted turns/tools, distinguish known completion from uncertain dispatch, and support documented resume/fork behavior. Use tool-provided idempotency only when available; otherwise expose deliberate recovery. Deliver restart/crash tests covering the external-commit/local-acknowledgement gap without blind replay.
- [ ] **T17 — Implement memory and auxiliary model integration.** Depends on: T14, T16. Implement the selected history/context policy, working/observational memory mappings, compaction restoration, and dependency resolution for recall, titles, scorers, and independent judge/generator calls. Preserve existing nonblocking title/live-score behavior and report auxiliary failures separately. Deliver multi-turn, resume, missing-dependency, and async-failure tests; never silently route to API-key models.
- [ ] **T18 — Integrate controllers, workflows, and alternate agent paths.** Depends on: T14–T17. Preserve controller mode options/delegation; wire workflow start/step/resume/retry/time-travel boundaries; implement the T08 network, durable, and legacy routes. Deliver path-specific tests, including invalid structured results, partial workflow progress, suspension, and safe recovery. An unimplemented path remains an explicit release gap.
- [ ] **T19 — Integrate selected native extensions.** Depends on: T13–T17. Add native tool opt-ins, skills/commands, dynamic subagents, task events, and dependency/configuration updates using the validated isolation profile. Deliver tests for delegated permissions, ordered hooks, tool changes after resume, and inherited capability rejection.

**Parallel work:** T18 and T19 can proceed together once their prerequisites pass. Required compatibility work in this milestone must finish before the Claude release gate.

### Milestone D — Complete Studio integration and validate Claude

- [ ] **T20 — Add server/client runtime APIs.** Depends on: T18, T19. Expose status, supported models, per-operation compatibility, runtime configuration, existing approval/cancel/resume controls, and recovery/auxiliary diagnostics. Preserve local single-user access boundaries and keep credentials out of responses. Deliver server/client tests, including direct API calls that bypass Studio.
- [ ] **T21 — Add the Studio experience.** Depends on: T20. Implement connection/setup status, per-agent runtime/model selection, effective tools/native opt-ins, approval/client-tool flows, nested activity, incompatibility details, and recovery. Keep cancellation, draft editing, and prior results available when execution is blocked. Deliver targeted MSW/UI tests using the actual API contracts.
- [ ] **T22 — Complete Claude verification and documentation.** Depends on: T21. Run the narrow unit/integration checks, Studio tests, bounded authenticated smoke tests, then relevant E2E coverage. Verify the negative cases in the reliability document and API-key regressions. Add setup/compatibility/recovery docs and changesets following repository guidance.
- [ ] **T23 — Close the Claude release gate.** Depends on: T22. Review every T01 requirement and all execution paths against test evidence, check no hidden fallback or omitted critical behavior, and record the supported binary/configuration range. Unresolved required behavior returns to implementation; passing chat alone is insufficient. This gate establishes readiness and does not publish or deploy anything.

**Milestone D exit:** Claude support validated through Studio for the accepted scope. Begin Codex production work after this gate, preserving the agreed Claude-first order.

### Milestone E — Validate Codex assumptions before implementing its adapter

- [ ] **T24 — Run Codex capability and isolation probes.** Depends on: T23. Reuse the harness to verify installed App Server version/schema, managed ChatGPT login, stdio handshake, native-tool/config isolation, dynamic tool/MCP equivalence, approvals, hooks, skills, structured output, and resume/interrupt. Confirm fail-open hook behavior and tool coverage; do not use external-token authentication or rely on schema presence alone.
- [ ] **T25 — Close the Codex design gate.** Depends on: T24. Select negotiated tool transports before execution, map Codex events and recovery onto the shared contracts, record experimental/version constraints, and resolve every required mapping. If Codex exposes a shared-contract defect, revise it and rerun affected Claude tests before continuing.

### Milestone F — Implement Codex, then verify both engines

- [ ] **T26 — Implement the Codex transport and tool backend.** Depends on: T25. Add managed account status/login, model discovery, threads/turns/items, event translation, interruption/steering, dynamic tools and validated MCP alternatives. Reuse the host authorization and processor state machinery; native MCP hooks cannot be the sole guardrail. Deliver protocol and host-contract tests.
- [ ] **T27 — Complete Codex state, feature, and execution-path parity.** Depends on: T26. Wire memory, approvals, client tools, suspension/recovery, selected skills/subagents, generic/controller/workflow/network/durable/legacy paths, and auxiliary model consumers through the shared mechanisms. Deliver the same contract tests used for Claude plus Codex-specific failure cases.
- [ ] **T28 — Complete Codex Studio integration and documentation.** Depends on: T27. Add managed browser/device-code connection UX and Codex-specific status/model/recovery details through shared components. Verify UI/API consistency, no credential exposure, and no silent runtime fallback. Add docs and changesets.
- [ ] **T29 — Close combined verification and release readiness.** Depends on: T28. Run targeted tests for both engines and API-key regressions, bounded live smoke tests, and relevant Studio E2E coverage. Reconcile every acceptance item and version/configuration constraint in all three documents. Record unresolved scope gaps as blockers; mark readiness only when the accepted behavior is demonstrated. Publishing/deployment remains a separate action.

**Next task: T04.** Do not begin T08 production contracts before T07's feasibility decision. Implement each component's tests with that component; T22 and T29 integrate and verify the evidence rather than postponing all testing until the end.

## Phase 0: Capability inventory and Claude compatibility spike

- [ ] Produce the feature -> dependent product behavior -> required contracts -> equivalent bridge or explicit block -> negative test matrix before implementing user-facing runtime selection.
- [ ] Define capability requirements from existing interfaces and resolved options. Optional declarations may improve early diagnostics, but do not require all existing dynamic functions to add metadata or execute arbitrary callbacks early just to inspect them.
- [ ] Define the common compatibility result and proposed failure/recovery states, including partial workflow execution and indeterminate tool execution.
- [x] Detect and record the installed CLI version dynamically from its own `--version` output; the T03 evidence observed Claude `2.1.270`. Admission/release checks must reject missing, malformed, ambiguous, or nonzero version output and prevent prepared/live/recovery version drift.
- [x] Verify authentication through the CLI's supported status/login surface without reading credentials (metadata-only; no model/protocol/subscription-consuming turn).
- [ ] Prove subscription-backed streaming in headless mode.
- [ ] Expose one schema-backed Mastra tool through MCP and verify its result/error round-trip.
- [ ] Prove permission approve/deny, cancellation, explicit session resume, and structured output.
- [ ] Prove a synchronous Mastra function hook through a local HTTP/command relay and separately test `hook_callback` registration/response over the control stream.
- [ ] Test pre-tool input mutation/blocking, post-tool feedback/result processing, prompt context injection, and bounded stop-hook continuation against Mastra processor contracts.
- [ ] Exercise selected skills/commands, dynamically defined subagents, nested task events, and a Mastra workflow invoked through a tool.
- [ ] Exercise tool catalog changes, client-tool callbacks, compaction/context restoration, and session fork behavior.
- [ ] Compare each processor phase's ordering and payload with the runtime event; distinguish observable behavior preserved by the bridge from identical internal execution.
- [ ] Verify native tools and inherited MCP servers cannot bypass the configured Mastra tool set by default.
- [x] Establish a tested Claude launch profile: `--safe-mode --tools ""` for no customizations/native built-ins, `--strict-mcp-config --mcp-config <generated>` for the effective Mastra bridge, and `--setting-sources ""`; preserve real macOS `HOME`/Keychain ownership while keeping `CLAUDE_CONFIG_DIR` unset and `TMPDIR` owned. Reject `--bare`, inherited/custom extension inputs, credentials, and provider-selection environment variables. `--allowedTools` auto-approves matching tools; it is not a catalog whitelist. The T03 probe recorded the installed version (`2.1.270`) for historical metadata/profile evidence only; future admission/release must dynamically resolve and record the selected executable version and reject drift across prepared, live, and recovery phases.
- [ ] Test inherited settings/hooks/MCP under headless execution, which lacks normal interactive trust prompts. For Codex, generated configuration alone does not suppress merged user/project hooks; validate isolation and any managed-hook policy against the actual runtime.
- [ ] Dispatch an ordered Mastra processor chain inside one host relay for a given lifecycle event. Claude matching hooks can run in parallel; registering one native hook per processor does not preserve ordering.
- [ ] Inspect inherited hooks, plugins, project instructions, skills, and auto memory; define an explicit loading policy compatible with per-agent isolation.
- [ ] Capture sanitized protocol fixtures for automated tests. The offline fixture is covered; live evidence currently records T1–T3 success and T4 `unknown_after_dispatch`/`unknown_recovery` with no replay, while T5 remains unattempted.

Technical gate: output-only JSONL does not establish interactive permission or function-hook support. Validate the bidirectional control protocol, hook relays, and documented permission surfaces against the installed CLI. Control symbols found in the binary are evidence for an experiment, not proof of a functioning handshake. Do not invent response formats or bypass approvals to make the spike pass.

Avoid relying on `--bare` without verifying its effects: prior research found that it disables subscription authentication and capabilities needed by this design.

## Phase 1: Shared agent runtime contract

- [ ] Implement shared compatibility enforcement in core before execution, with Studio/server/controller/workflow diagnostics using the same result.
- [ ] Resolve known static dependencies before vendor execution; preserve normal request-dependent/dynamic resolution and validate before the next external boundary. Do not claim a complete static proof for arbitrary dynamic workflow code.
- [ ] Use the workflow engine's awaited `onStart` or equivalent before-step gate for compatibility, allowing `createRun` to persist its normal pending snapshot. Preserve auditable failed/blocked run state.
- [ ] Include automatic title, memory, scorer, dataset/evaluation, and fallback model calls in runtime resolution. Never silently dispatch them to API-key providers.
- [ ] Add explicit runtime configuration and capability reporting without changing the default API-key path.
- [ ] Share agent preparation: resolved instructions, request context, authorization, tools, memory inputs, and tracing.
- [ ] Define input/output contracts for messages, streaming, errors, cancellation, structured output, sessions, and approvals.
- [ ] Define hook registration/dispatch, tool callbacks, context/compaction, skills/commands, subagent events, and capability/version negotiation in the runtime contract.
- [ ] Preserve ordinary `generate()`/`stream()` callers and workflow agent steps; do not rely on controller registration alone.
- [ ] Cover networks/resumeNetwork, standalone durable agents, and legacy paths explicitly; verify controller mode toolsets and subagent calls use the same runtime policy without bypassing their existing options.
- [ ] Define how configured agents and Studio-edited agents persist runtime selection.
- [ ] Admit required capabilities only when the native mapping or equivalent bridge is validated for the selected runtime/version/configuration. Reject missing, untested, or incompatible requirements with the exact affected agent/tool/processor/workflow path. This is a predictable failure policy, not evidence that the feature can never be implemented.
- [ ] Permit narrower behavior only through an explicit configuration change; never silently disable cache, processors, memory, scoring, approvals, or workflow recovery.

Review `maxSteps`, per-step callbacks, tool choice, client tools, processors, hooks, and scorer integration individually. For example, pre-tool hooks can block or change arguments, a host tool callback can process results before returning them, and stop hooks can drive bounded validation/continuation. None should be dismissed just because a runtime owns its model loop. Also do not claim that a prompt-context hook can rewrite an entire provider request or serve a cached response without evidence.

## Phase 2: Claude backend and MCP tool bridge

- [ ] Supervise the unmodified local CLI process, parse framed events, handle stderr, and clean up on cancellation/server shutdown.
- [ ] Prevent accidental API-key billing in subscription mode by controlling the child process's authentication environment.
- [ ] Reuse the effective catalog from Mastra tool resolution, including toolsets, memory, workspace/skills/browser, client, delegation, workflow, and processor-loaded tools; honor `activeTools` and existing hooks.
- [ ] Preserve tool input/output schemas, request context, runtime authorization, tracing, and error semantics.
- [ ] Carry stable run/tool-call IDs through approvals and results.
- [ ] Add bounded queues and cancellation propagation for parallel workflow steps and subscription-limit failures.
- [ ] Keep tool side effects from being repeated blindly after retries or process restarts.
- [ ] Persist execution identity and state before dispatch where possible. Treat a crash between an external side effect and durable acknowledgement as indeterminate; use idempotency/reconciliation or manual recovery, not an exactly-once claim based on a local ledger alone.
- [ ] Select a validated MCP/control transport before execution. Do not switch transports or runtimes mid-call after tool/approval state exists.
- [ ] Enforce native capability opt-ins in runtime configuration, not only in prompts or UI visibility.
- [ ] Preserve selected native skills/commands/subagents and hook functionality within those permissions, rather than disabling every extension to achieve isolation.
- [ ] Resolve selected native extension dependencies (including environment variables, MCP tools, and delegated permissions) before enabling them. Skill selection must not silently expand tools or select new credential sources.
- [ ] Maintain the host message/step state, IDs, processor state, and ordering needed by `ProcessorRunner` before applying tool-result processing in a callback. Calling `Tool.execute` alone does not implement that contract; test the normalized host execution state before claiming equivalence.

Keep deterministic shape/range/cross-field constraints in schemas. Runtime existence, authorization, and conflict checks remain in tool execution.

## Phase 3: State, memory, workflows, and compatibility

- [ ] Store external session IDs alongside Mastra agent/thread or workflow-run identity. Never select the latest session implicitly.
- [ ] Keep Mastra records authoritative for Studio threads, workflow state, and tool execution history.
- [ ] Define when to resume vendor context versus construct a new session from Mastra history, avoiding duplicate history injection.
- [ ] Handle changed instructions/tools, thread branching, working memory, and external session loss explicitly.
- [ ] Isolate concurrent agents and workflow runs; a session ID alone may not isolate vendor project-level memory.
- [ ] Map schema-backed output into Mastra's structured result and validate it.
- [ ] Translate text/tool/error/completion events and available usage into Mastra streams and traces; do not fabricate missing telemetry.
- [ ] Preserve workflow observe/cancel/suspend/resume and document what happens to an interrupted external turn.
- [ ] Define processor and hook behavior, including tripwires and retries, with a supported-feature matrix.
- [ ] Map each exact host phase: initial input, input step, LLM request, LLM response, output step, tool result, API error, output stream, and final output. Test observable ordering, not merely similarly named hook events.
- [ ] Evaluate stop/subagent-stop hooks for completion scoring and bounded repair, and compaction hooks for restoring host memory context.
- [ ] Model Mastra workflow graphs, skill/command procedures, and native subagent/task orchestration as distinct cooperating features.
- [ ] Store process/callback handles in `RunScope`; persist serializable session, turn, item, tool-call, and workflow-run identifiers for recovery.
- [ ] Preserve existing completion semantics: `executeOnFinish` errors are caught by prepare-stream, title generation is background work, and ordinary live scoring is dispatched asynchronously. Surface auxiliary failures separately and never rerun the main turn to repair them. Any new strict persistence/scoring outcome policy must be explicit, not a default change introduced by this adapter.
- [ ] Reject workflow retry/time travel when the declared side-effect/recovery policy cannot be honored. Preserve prior completed steps and expose partial/needs-reconciliation state instead of presenting a fresh successful run.

Release coverage must include ordinary agents, custom tools, and workflow agent steps. Native hooks and dynamic capabilities are part of the implementation design, not automatically deferred extras. Exact per-model-request mutation, cached-response substitution, and durable recovery of a pending external tool call remain contract tests rather than blanket feature exclusions.

Until those tests establish a behavior-preserving path, configurations requiring the affected contract are not executable through that runtime. Their exclusion remains an explicit scope gap. If all requested configurations cannot be preserved, report the architectural conflict before claiming the integration complete; do not redefine completion as a working subset.

## Phase 4: Studio integration

- [ ] Add local runtime installation, authentication, version, and health status endpoints.
- [ ] Update provider connectivity logic, which currently relies on API-key environment variables, to distinguish local runtimes.
- [ ] Add per-agent runtime/model selection and native capability opt-ins.
- [ ] Surface selected skills/commands, hook activity, nested subagents/tasks, compaction, and user-dialog events where supported; distinguish native provider activity from Mastra workflow runs.
- [ ] Initially support the user's existing terminal login; present exact setup instructions when disconnected.
- [ ] Map approval requests and pending state into the existing Studio execution UI.
- [ ] Support cancellation, reconnect/session recovery, and clear missing-CLI, unauthenticated, quota, and process-failure errors.
- [ ] Show agent-specific compatibility, the affected dependency path, and remediation before Run. Keep draft editing and unrelated tools available when a particular runtime configuration is blocked.
- [ ] Reuse existing outcomes where possible; add auxiliary failure/recovery diagnostics without making background title/scorer completion a prerequisite for ordinary response success. Any new strict-finalization state is an explicit policy requiring a deliberate API/storage change.
- [ ] Restrict process-launch/control endpoints to the local single-user deployment model with appropriate origin/access checks.

Relevant areas: `packages/server`, `packages/client-js`, `packages/playground`, and `packages/playground-ui`. Read their most-specific repository instructions before implementation.

## Phase 5: Codex App Server

- [ ] Add a dedicated Codex adapter using the same shared runtime contract; do not repurpose `@mastra/openai` as though it already wraps Codex.
- [ ] Launch App Server over stdio and perform the initialization handshake.
- [ ] Read managed account status and support pre-authenticated ChatGPT login.
- [ ] Add the documented browser/device-code login flow when implementing in-app connection setup; keep credential persistence in Codex.
- [ ] Do not use external `chatgptAuthTokens`; the inspected protocol marks that route internal-only. Use managed account flows.
- [ ] Implement thread creation/resume, turn execution, event translation, interruption, and approval responses.
- [ ] Discover supported models through the runtime where available.
- [ ] Evaluate negotiated `dynamicTools` / `item/tool/call` as the primary path for per-agent and client tools; preserve their call IDs, schemas, results, approval gates, and request context.
- [ ] Reuse MCP for shared/external tools and workflow services and as an alternate bridge where appropriate. Compare both mechanisms with the same contract tests rather than preferring one solely on its experimental label.
- [ ] Add native hook mapping for tool policy/input rewriting, feedback, prompt/context injection, compaction, and bounded stop/subagent-stop continuation.
- [ ] Test hook failure behavior and tool coverage: Codex MCP hook errors/missing endpoints do not block, and hosted WebSearch/specialized paths can bypass pre/post-tool hooks. Never use those hooks as the sole required approval/redaction barrier. See [Codex hook execution](https://learn.chatgpt.com/docs/hooks).
- [ ] Support skill discovery/reload and subagent activity; map CLI-only command behavior through explicit App Server methods or skills instead of assuming slash-command strings are RPCs.
- [ ] Generate/check stable and experimental protocol bindings against the supported installed version. A schema variant does not prove an implementation executes it: current Codex documentation distinguishes active hook handlers from parsed/skipped types.
- [ ] Treat App Server's experimental status explicitly even over local stdio; do not claim that a transport choice removes the version-compatibility requirement.
- [ ] Run the same agent/tool/workflow compatibility suite as Claude.

## Scope boundaries

The requested subscription support covers agent execution, configured custom tools, and workflow agent steps. It does not supply credentials for unrelated external services called by those tools.

Embeddings and reranking remain separate providers. Semantic memory search still requires a suitable embedding model/vector store. Scorer judges, dataset generation, and other independent model consumers need dedicated capability adapters before they can also use these runtimes. Their storage/orchestration UI continues through existing Mastra APIs.

Consequences must be visible: an agent with required semantic recall and no embedding backend must not silently lose recall. Standalone evaluation/dataset jobs and explicit score-dependent operations validate their judge/generator dependencies before execution. Normal asynchronous scoring hooks and title generation retain their current nonblocking defaults, with failure/unavailable status separate from response success. Their absence is still a coverage task, not grounds for inventing passing scores or an API-key fallback. Required guardrails remain mandatory.

Separate local backends can satisfy appropriate dependencies without API keys. If none is configured and validated, the dependent operation remains unavailable. Availability of the CLI subscription alone never implies that every downstream model consumer is ready.

## Failure behavior and release gates

- [ ] Missing request interception blocks agents that require request rewriting/cache substitution; never execute the model and pretend the processor ran.
- [ ] Missing per-step mutation or pre-tool barriers blocks dependent guardrails/dynamic configurations; never substitute display filtering for a model-visible or pre-action guarantee.
- [ ] Missing required approval/enforcement dispatch prevents the protected operation at a host or verified native gate; timeout/disconnect is not consent. A fail-open vendor hook cannot provide this guarantee, so choose a different enforcement path or reject the dependent native capability.
- [ ] Invalid structured output fails the agent step and cannot feed a downstream workflow step as a valid result.
- [ ] Missing usage fields are explicitly unavailable, not zero. If a configured limit/audit depends on those fields, block that configuration; optional diagnostics may remain incomplete under an explicit policy.
- [ ] Quota/auth/version failures never trigger API-key fallback, model substitution, new-session replay, or transport switching without an explicit validated recovery decision.
- [ ] Known static incompatibility is caught before real turns/tool effects. Dynamic incompatibility is detected at normal resolution, stops before the next external boundary, and preserves earlier work. Optional declared dependency bounds can improve early checks but are not mandatory new metadata for all existing APIs.
- [ ] Compatibility cache keys include binary/adapter/protocol version, model/capabilities, tool and hook configuration, settings/workspace sources, and declared requirements. Revalidate after changes and before resume.
- [ ] Prove negative paths as well as successful runs: static rejection makes no model/tool calls, denied tools never execute, result policies run at the specified boundary, and unknown execution is not replayed. Separately prove title/live-score failures preserve existing response semantics and remain visible as auxiliary failures.
- [ ] No required feature may remain unknown/blocked within the accepted release scope. A reliable blocked subset is not completion of the original all-agent/tool/workflow requirement.

## Acceptance and validation

- [ ] Ordinary registered agent works through Studio with no model API key.
- [ ] Configured custom tools succeed, fail, and validate input correctly.
- [ ] Unconfigured/native tools are unavailable by default; explicit opt-ins behave as configured.
- [ ] Approval, denial, cancellation, and suspension/resumption preserve identities and execution state.
- [ ] Thread continuation and concurrent run isolation work without cross-agent context leakage.
- [ ] Structured output validates and malformed/interrupted output produces a clear error.
- [ ] AgentController sessions and workflow agent steps use the same selected runtime.
- [ ] Network, durable, and legacy agent execution coverage is tested or recorded as an unresolved release gap; no broad all-agent claim follows from modern stream tests alone.
- [ ] Dynamic processor/tool resolution and pending thread/workflow records preserve current ordering; no mandatory new callback declarations or zero-storage-mutation guarantees are introduced.
- [ ] Effective toolset tests include memory, workspace/skills/browser, client, controller mode, delegation, and workflow tools, not only statically assigned functions.
- [ ] Workflow streaming, observation, cancellation, and durable resume still work.
- [ ] Process failures, restarts, expired login, and subscription limits are handled without duplicate side effects.
- [ ] Existing API-key providers and direct non-model tool/workflow operations remain functional.
- [ ] Function hooks block, mutate, inject context, and return results at the expected lifecycle points; hook failures/timeouts/cancellation are handled.
- [ ] Selected skills, commands, and native subagents work while respecting the configured Mastra tool boundary.
- [ ] Dynamic tool updates and client-tool callbacks preserve request context and do not expose stale/unconfigured tools after resume.
- [ ] Stop-hook completion checks are bounded and counted consistently; compaction restores intended memory/instructions.
- [ ] Workflow graphs, native task/subagent progress, and procedural skills remain distinguishable in state and traces.

Use sanitized protocol fixtures and narrow package unit/integration tests first, then Studio MSW tests, then opt-in live local smoke tests and appropriate E2E coverage. Live tests consume subscription limits and must not become mandatory credential-dependent CI tests. Follow applicable package test guidance, add feature documentation, and read `.mastracode/commands/changeset.md` after code changes.

## Research sources

- [Claude Code authentication and credential policy](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code headless execution](https://code.claude.com/docs/en/headless)
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude hook guide](https://code.claude.com/docs/en/hooks-guide)
- [Claude function hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Claude native features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- [Claude subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Claude skills](https://code.claude.com/docs/en/agent-sdk/skills)
- [Claude file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- [Anthropic native ACP request](https://github.com/anthropics/claude-code/issues/6686)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex MCP integration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex custom prompts](https://learn.chatgpt.com/docs/custom-prompts)

These sources informed the preceding exploration. Protocol stability, exact flags, account eligibility, and permission behavior are compatibility-spike checks, not assumptions of completed implementation.
