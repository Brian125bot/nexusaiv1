# NexusAI: The Ouroboros Protocol & Evolutionary Roadmap

This document serves as the foundational mandate for the Nexus project. It defines the transition from a reactive orchestration prototype to a fully autonomous, self-improving "Agentic Tier 3" system.

---

## 🏗️ Core Architectural Mandates (The Gaps)
To achieve the "Complete State," the following structural enhancements must be prioritized:

1.  **The Recursive Verification Loop:** Transition from a "Stop-at-PR" model to a "Continuous-Refinement" loop. If a PR branch fails a CI check, the system must automatically ingest logs and re-dispatch repair agents.
2.  **Intent-Based Locking:** Upgrade the `file_locks` system from binary to "Shared" (Read) vs. "Exclusive" (Write) locks to enable high-parallelism during massive cascades without race conditions.
3.  **Agent Provider Interface (API):** Abstract the `jules` client into a provider-agnostic interface. The "Loop" logic must remain independent of specific LLM providers (Jules, OpenHands, Llama-Index).
4.  **AST-Based Cascade Analysis:** Integrate static analysis (`ts-morph` or `grep`) into the `analyze` route. The engine should detect actual code references, not just prompt-based probabilities.
5.  **Goal Hierarchies:** Transition the `goals` schema to a Parent-Child (Epic -> Task) model to represent complex cascades and track partial success states.

---

## 🎯 End-Stage Objectives (The Ouroboros Protocol)

### 1. Proactive Autonomy (The Hunter)
*   **Autonomous Task Initiation:** Moving beyond human-triggered webhooks to proactively scanning the repository for architectural drift.
*   **AST-Driven Scans:** The "Hunter" service will use static analysis to identify code violating established goals and autonomously dispatch repair agents.

### 2. Self-Healing Verification Loop
*   **Automated Failure Recovery:** Monitoring GitHub "Check Runs" to detect regressions caused by Nexus-proposed changes.
*   **Closed-Loop Remediation:** Upon detecting a failure, the system fetches error logs, generates a patch, and iterates on the PR without human intervention.

### 3. Semantic Memory & Learning
*   **Anti-Pattern Registry:** Maintaining a persistent registry of failed logic and rejected PRs.
*   **Wisdom Accumulation:** Future refactors will ingest this history to ensure the Cascade Engine proposes increasingly reliable shifts.

### 4. Autonomous Evolution (Ouroboros)
*   **Self-Referential Upgrades:** Nexus observing its own core orchestration logic and proposing upgrades to its own "nervous system."
*   **Human-as-Orchestrator:** The user’s role is elevated to Lead Architect, setting high-level "Intents" while the system manages the complexity of implementation.

### 5. Secured Control Plane
*   **Governance & Guardrails:** Robust rate-limiting, HMAC verification, and "Force Clear" capabilities to keep the loop within operational boundaries.
*   **Command Center:** A secured Descope dashboard for monitoring the "Traffic Map" of parallel AI agents and active file locks.

---

## 📊 Current MVP Progress
- [x] **Schema Normalization:** Standardized `acceptanceCriteria` object schema.
- [x] **Reactive Cleanup:** Webhook-driven terminal state transition and lock purging.
- [x] **Atomic Lock Management:** Exclusive file locking for collision prevention.
- [ ] **Recursive Loop:** (Planned) Integration with GitHub Check Runs.
- [ ] **AST Analysis:** (Planned) Migration from prompt-only to AST-informed cascades.

---

*Note: This document takes precedence over general defaults. Every architectural change must align with the Ouroboros Protocol.*
