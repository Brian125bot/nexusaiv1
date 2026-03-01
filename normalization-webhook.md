# Technical Report: Goal Normalization & Reactive Session Cleanup
**Date:** Saturday, February 28, 2026
**Status:** Implemented, Verified, and Pushed
**Role:** Senior Full-Stack & DevOps Engineering

## Executive Summary
This document details the critical architectural enhancements implemented in the NexusAI project to move from a reactive prototype toward a production-grade autonomous orchestration engine. The work focused on two primary pillars: **Data Integrity (Normalization)** and **Lifecycle Reliability (Webhook Cleanup Loop)**. 

By eliminating inconsistent data types and implementing a deterministic cleanup loop, we have successfully resolved the "Hanging Session" bug and provided a stable, type-safe foundation for the upcoming Ouroboros Protocol.

---

## Part 1: Goal Acceptance Criteria Standardization

### 1.1 Technical Motivation
Previously, the `acceptanceCriteria` field in the `goals` table was defined as a union type: `(string | AcceptanceCriterion)[]`. This created several architectural "leaks":
- **UI Complexity:** The frontend had to perform type-checking (`typeof === 'string'`) during every render.
- **Verification Fragility:** The Auditor engine could not reliably "check off" items without a unique ID for each criterion.
- **Database Ambiguity:** JSONB storage was unpredictable, leading to potential runtime failures during deep-merge operations.

### 1.2 Schema Transformation (`src/db/schema.ts`)
We transitioned the schema to a strictly typed, canonical object array. 

**Legacy Type:**
```typescript
acceptanceCriteria: jsonb("acceptance_criteria").$type<(string | AcceptanceCriterion)[]>()
```

**New Canonical Type:**
```typescript
export interface AcceptanceCriterion {
  id: string;   // Stable UUID for React keys and Auditor tracking
  text: string; // The requirement description
  met: boolean; // Current completion status
  files?: string[]; // Optional: Specific files targeted by this criterion
}

// Enforced in Drizzle:
acceptanceCriteria: jsonb("acceptance_criteria").$type<AcceptanceCriterion[]>().default([]).notNull(),
```

### 1.3 Data Migration Strategy
A custom Drizzle migration (`drizzle/0004_normalize_acceptance_criteria.sql`) was generated to handle the in-place upgrade of legacy data. The migration utilizes PostgreSQL's JSONB functions to perform a non-destructive transformation:

```sql
UPDATE "goals"
SET "acceptance_criteria" = (
  SELECT jsonb_agg(
    CASE 
      WHEN jsonb_typeof(elem) = 'string' THEN 
        jsonb_build_object('id', gen_random_uuid(), 'text', elem, 'met', false)
      WHEN jsonb_typeof(elem) = 'object' THEN
        jsonb_build_object(
          'id', COALESCE(elem->>'id', gen_random_uuid()::text),
          'text', elem->>'text',
          'met', COALESCE((elem->>'met')::boolean, false),
          'files', elem->'files'
        )
      ELSE elem
    END
  )
  FROM jsonb_array_elements("acceptance_criteria") AS elem
)
WHERE jsonb_typeof("acceptance_criteria") = 'array';
```

### 1.4 API Normalization Layer
To maintain a developer-friendly API while enforcing storage rigidity, we implemented a normalization layer in the `POST` and `PATCH` handlers (`src/app/api/goals/`).

**The Pattern: Flexible Input, Rigid Storage**
The Zod schema now allows users to submit simple strings, but the API logic immediately transforms them:

```typescript
const normalizedCriteria = payload.acceptanceCriteria.map((criterion) => {
  if (typeof criterion === "string") {
    return { id: randomUUID(), text: criterion, met: false };
  }
  return {
    id: criterion.id || randomUUID(),
    text: criterion.text,
    met: criterion.met ?? false,
    files: criterion.files,
  };
});
```

---

## Part 2: Reactive Session Cleanup Loop

### 2.1 Problem Statement: "The Hanging Session"
Sessions in NexusAI were frequently left in an `executing` state indefinitely. If a user manually merged or closed a Pull Request on GitHub, Nexus was unaware of the terminal state. This caused:
- **Locked Files:** The `file_locks` table remained populated, preventing subsequent repair jobs.
- **UI Drift:** The dashboard showed active sessions that were actually dead.
- **Resource Waste:** Background pollers continued to hit the Jules API for sessions that were already closed.

### 2.2 Webhook Expansion (`src/app/api/webhooks/github/route.ts`)
We expanded the GitHub Webhook handler to listen for the `pull_request.closed` action.

**Key Logic Implementation:**
1.  **Branch Matching:** The system extracts `pr.head.ref` and queries the local `sessions` table for a match.
2.  **State Mapping:** 
    - If `merged === true` → Status set to `completed`.
    - If `merged === false` → Status set to `failed`.
3.  **Atomic Cleanup:** Upon updating the session, the system immediately invokes `LockManager.releaseLocks(sessionId)`.

```typescript
if (action === "closed") {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.branchName, pr.head.ref),
  });

  if (session && !isTerminal(session.status)) {
    const newStatus = pr.merged ? "completed" : "failed";
    await db.update(sessions).set({ status: newStatus }).where(eq(sessions.id, session.id));
    await LockManager.releaseLocks(session.id); // Purge file_locks table
    console.log(`🧹 Nexus: PR closed. Released locks for session ${session.id}`);
  }
}
```

### 2.3 Synchronization Guarding (`src/lib/jules/sync-service.ts`)
To prevent the background synchronization service from overwriting the deterministic state set by the webhook, we implemented a **Terminal State Guard**.

```typescript
// Skip polling if the session is already in a terminal state
if (session.status === "completed" || session.status === "failed") {
  return { session, externalStatus: session.status, pullRequestUrl: null };
}
```
This ensures that once a session is "Closed" by a human or the GitHub environment, the AI loop respects that decision as final.

---

## Part 3: Verification & Quality Assurance

### 3.1 Build & Type Validation
The project was built locally using `npm run build` to verify:
- **Zero Type Regressions:** TypeScript correctly validated the new `acceptanceCriteria` object usage in the dashboard.
- **Route Integrity:** All 22 API and Page routes were successfully optimized.

### 3.2 Unit Testing
The `GoalManager` test suite was updated and verified:
- `should create a goal with acceptance criteria`: **PASSED** (Confirmed objects are stored).
- `should update goal progress`: **PASSED** (Confirmed `met` flag toggles correctly).

### 3.3 CI/CD Alignment
The changes were pushed to two new branches for modular review:
- `feature-normalization`: Contains all schema and API standardization work.
- `feature-webhook`: Contains the reactive cleanup and sync optimization logic.

---

## Part 4: Conclusion
Today's work has eliminated the primary source of state-drift within the NexusAI orchestrator. By standardizing the "Goal" data structure and implementing a reactive "Cleanup" loop, we have moved from a fragile prototype to a system capable of managing its own lifecycle. 

**Next Steps:**
1. Merge `feature-webhook` into `main`.
2. Implement "Intent-Based Locking" to allow shared read access during analysis.
3. Begin development of the "Hunter" service for proactive repository scanning.
