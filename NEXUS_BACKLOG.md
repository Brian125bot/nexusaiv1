# NexusAI Prioritized Implementation Backlog (Source of Truth)

Last Updated: 2026-02-26
Owner: Architecture / Platform
Status: Active

## Scope
This backlog translates the current architecture review into an implementation plan with concrete patch scopes per file.

---

## P0 (Must Fix Next)

### P0.1 Normalize Acceptance Criteria model (single canonical shape)
Why: AC enforcement and UI rendering are currently inconsistent between `string[]` and object-shaped criteria.

#### Patch Scope
- `src/db/schema.ts`
  - Change `goals.acceptanceCriteria` type to canonical object array only:
    - `{ id: string; text: string; met: boolean; files?: string[] }[]`
  - Remove union `(string | AcceptanceCriterion)[]`.
- `drizzle/*` (new migration)
  - Add migration to normalize existing rows from string arrays to object arrays.
- `src/app/api/goals/route.ts`
  - Accept AC input as either `string[]` (backward compat) or object[].
  - Normalize to canonical object array before insert.
- `src/app/api/goals/[id]/route.ts`
  - Same normalization for PATCH.
- `src/app/api/cascade/analyze/route.ts`
  - Ensure cascade-created goal ACs include stable `id`, `text`, `met`, `files`.
- `src/lib/ui/types.ts`
  - Update `Goal.acceptanceCriteria` type to canonical object array.
- `src/components/dashboard/goal-board.tsx`
  - Render checklist from canonical AC objects; preserve `met` visualization.

#### Acceptance Criteria
- All goal AC reads/writes use one shape.
- Existing goals with `string[]` still load after migration.
- Goal board renders without type coercion hacks.
- Typecheck and API tests pass.

---

### P0.2 Implement true verification stage in session lifecycle
Why: Current lifecycle skips real “verifying” semantics from architecture.

#### Patch Scope
- `src/lib/jules/status-map.ts`
  - Map Jules statuses to include `verifying` where appropriate.
  - If Jules has no explicit verify state, set `verifying` as internal intermediate after `COMPLETED` before AC check.
- `src/lib/jules/sync-service.ts`
  - Add post-execution verification function:
    - Mark session `verifying`.
    - Evaluate goal AC coverage (minimum deterministic check + auditor hook).
    - Transition to `completed` or `failed`.
  - Keep lock release only after terminal status set.
- `src/db/schema.ts`
  - Optional: add `verificationSummary`/`verificationArtifacts` field on sessions if needed for observability.
- `src/app/api/orchestrator/sync/route.ts`
- `src/app/api/orchestrator/sync-batch/route.ts`
  - Ensure response includes verification outcome payload.

#### Acceptance Criteria
- Sessions visibly pass through `verifying` before terminal state.
- Failed verification marks session failed and preserves error context.
- Locks are released only on terminal completion/failure.

---

### P0.3 Complete webhook-to-remediation closed loop
Why: Webhook flow currently comments but does not auto-dispatch remediation jobs.

#### Patch Scope
- `src/lib/auditor/auto-reviewer.ts`
  - Add policy-gated remediation dispatch path on cascade/major drift.
  - Reuse existing orchestrator/cascade service calls instead of duplicating logic.
- `src/app/api/webhooks/github/route.ts`
  - Include remediation outcome in webhook response body/log context.
- `src/lib/cascade-config.ts`
  - Add explicit toggle(s):
    - `autoRemediateFromWebhook` (default false)
    - thresholds for cascade dispatch.

#### Acceptance Criteria
- When toggle enabled and policy satisfied, webhook event can trigger cascade repair dispatch.
- When disabled, behavior remains comment-only (current default).
- Idempotency: repeated same commit does not dispatch duplicate remediation.

---

## P1 (High Value)

### P1.1 Add controlled major-drift auto-fix policy
Why: Major drift is manual-only; needs configurable automation level.

#### Patch Scope
- `src/lib/auditor/auto-reviewer.ts`
  - Replace hardcoded “manual action only” with policy decision tree.
- `src/lib/config.ts`
  - Add env-backed policy flags:
    - `AUDITOR_MAJOR_DRIFT_MODE` = `manual | suggest | auto`
- `src/app/api/webhooks/github/route.ts`
  - Emit policy mode in debug metadata.

#### Acceptance Criteria
- `manual`: current behavior.
- `suggest`: comment includes structured fix plan.
- `auto`: dispatches remediation path under lock/policy checks.

---

### P1.2 Fix reviewer token efficiency for cascade analysis
Why: Full-diff duplication per file is costly/noisy.

#### Patch Scope
- `src/lib/auditor/auto-reviewer.ts`
  - Parse diff into per-file hunks.
  - Pass only relevant hunk per `FileChange` entry.
  - Add cap/truncation strategy for very large diffs.
- `src/lib/auditor/cascade-engine.ts`
  - Adjust prompt construction to consume per-file concise patches.

#### Acceptance Criteria
- Prompt token volume materially reduced for multi-file PRs.
- Cascade quality is stable or improved in sampled runs.
- No regression in comment generation.

---

### P1.3 Improve operational telemetry surface
Why: Telemetry exists in responses/logs but not centralized for dashboards.

#### Patch Scope
- `src/db/schema.ts`
  - Add optional persisted telemetry fields/table for dispatch metrics.
- `drizzle/*` (new migration)
  - Schema migration for telemetry persistence.
- `src/app/api/cascade/analyze/route.ts`
- `src/app/api/orchestrator/batch/route.ts`
  - Persist telemetry fields (latency/conflict/failure counts).
- `src/components/dashboard/system-log-view.tsx`
  - Add summarized telemetry panes (conflict rate, median latency, failure ratio).

#### Acceptance Criteria
- Telemetry queryable from DB (not only ephemeral response JSON).
- Dashboard displays trend-friendly metrics.

---

## P2 (Should Have / UX & Governance)

### P2.1 Reinstate dashboard auth guard and login flow
Why: Architecture calls for secured control plane.

#### Patch Scope
- `src/app/dashboard/layout.tsx`
  - Add auth guard wrapper.
- `src/app/login/page.tsx`
  - Add login page.
- `src/lib/auth/session.ts`
  - Ensure non-dev bypass behavior is strict and test-covered.

#### Acceptance Criteria
- Unauthenticated users cannot access `/dashboard` in non-dev mode.
- Login flow redirects correctly.

---

### P2.2 Cascade governance and replay controls
Why: Improve auditability and operational control for cascade ledger.

#### Patch Scope
- `src/app/api/cascade/events/route.ts`
  - Add filtering by status/date/repo.
- `src/app/api/cascade/analyze/route.ts`
  - Add explicit replay guard/idempotency key support.
- `src/components/dashboard/cascade-events.tsx`
  - Add filter controls and details view per cascade.

#### Acceptance Criteria
- Architects can filter and inspect cascade history reliably.
- Replays cannot create accidental duplicate repair waves.

---

## Cross-Cutting Requirements (Apply to all priorities)
- Preserve rate-limit and auth checks on all mutation endpoints.
- Add/extend tests for each behavior change:
  - Route conflict tests
  - Lifecycle transition tests
  - Policy-mode tests
  - Diff parser/token-budget tests
- Keep all new behavior behind explicit config defaults when risky.
- Maintain zero TypeScript errors (`npx tsc --noEmit`).

---

## Recommended Execution Order
1. P0.1 (AC normalization) - unblocks downstream verification quality.
2. P0.2 (verification stage) - enforces intended lifecycle.
3. P0.3 (webhook closed loop) - enables autonomous remediation.
4. P1.2 (token efficiency) - cost/perf stabilization before higher traffic.
5. P1.1 + P1.3 (policy + telemetry persistence).
6. P2 items for security UX and governance improvements.
