Spec 1: Nexus Registry & State Foundation
1. Overview
The goal of Step 1 is to build the source of truth for the Nexus Orchestrator. This component manages the persistence of architectural goals and real-time "file locks" to prevent multiple Jules sessions from creating merge conflicts.

2. Core Objectives
Establish a serverless relational database connection (Neon).

Define a schema that captures high-level project intent and low-level git-state.

Implement a Concurrency Guard logic to track which files are currently being modified by AI.

3. Data Schema (Drizzle ORM / Postgres)
A. goals Table
Tracks the high-level objectives the user wants to achieve.

id: UUID (Primary Key).

title: String (e.g., "Implement Multi-tenant Auth").

description: Text (The high-level "vibe" or requirement).

acceptance_criteria: JSONB Array (e.g., ["No hardcoded secrets", "Uses Lucia Auth"]).

status: Enum (backlog, in-progress, completed, drifted).

created_at: Timestamp.

B. sessions Table
Tracks active Jules API sessions.

id: String (The Jules Session ID).

branch_name: String (The feature branch name).

base_branch: String (Usually main, or a parent session branch for stacked PRs).

status: Enum (queued, executing, verifying, completed, failed).

C. file_locks Table
The "Traffic Controller" logic.

id: Serial.

session_id: Foreign Key (references sessions.id).

file_path: String (The absolute path in the repo, e.g., /src/lib/db.ts).

locked_at: Timestamp.

4. Key Features to Implement
Feature 1.1: The "Locking" Service
Create a TypeScript service (/lib/registry/lock-manager.ts) with the following functions:

requestLock(session_id, file_paths[]): Checks if any of the requested files are already in the file_locks table.

getConflictStatus(file_paths[]): Returns a list of active sessions that are currently "touching" those files. This data will later be fed to Gemini to decide if we should stack or queue a PR.

Feature 1.2: Goal Progress Tracker
A service to update the "Acceptance Criteria" status.

updateGoalProgress(goal_id, criteria_index, is_met): Allows the Auditor (Gemini) to check off items as Jules completes them.

5. Technical Requirements
Runtime: Node.js/TypeScript.

Database: Neon (Postgres).

ORM: Drizzle ORM.

Validation: Zod (for input validation of session data).

6. Definition of Done (DoD)
[ ] Database is provisioned on Neon and accessible via connection string.

[ ] npx drizzle-kit push successfully generates the tables.

[ ] A test script can successfully "lock" a file and reject a second lock request for the same path.

[ ] A "Goal" can be created with a list of acceptance criteria via a local function call.