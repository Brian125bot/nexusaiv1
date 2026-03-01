export type GoalStatus = "backlog" | "in-progress" | "completed" | "drifted";
export type SessionStatus = "queued" | "executing" | "verifying" | "completed" | "failed";

export type ReviewArtifact = {
  type: "pull_request";
  url: string;
  sessionExternalId: string;
  createdAt: string;
};

export type Goal = {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: { id: string; text: string; met: boolean; reasoning?: string; files?: string[] }[];
  reviewArtifacts: ReviewArtifact[];
  status: GoalStatus;
  createdAt: string;
};

export type Session = {
  id: string;
  externalSessionId: string | null;
  goalId: string | null;
  sourceRepo: string;
  lastReviewedCommit: string | null;
  julesSessionUrl: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  branchName: string;
  baseBranch: string;
  status: SessionStatus;
  createdAt: string;
};

export type LockRow = {
  id: number;
  filePath: string;
  lockedAt: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  julesSessionUrl: string | null;
  externalSessionId: string | null;
  goalId: string | null;
  status: SessionStatus;
};

export type OrchestratorRequest = {
  goalId: string;
  prompt: string;
  sourceRepo: string;
  startingBranch?: string;
  confirmDispatch?: boolean;
};

export type StreamPhaseEvent = {
  phase: string;
  status?: string;
  [key: string]: unknown;
};

export type StreamToolResultEvent = {
  toolName: string;
  output: unknown;
};

export type StreamFinalEvent = {
  reasoning: string;
  toolResults: Record<string, unknown[]>;
  provisionalPlan: unknown | null;
  julesSessionId: string | null;
  julesSessionUrl: string | null;
  model: string;
  confirmDispatch: boolean;
};

export type AuditorReportState = {
  phases: StreamPhaseEvent[];
  text: string;
  toolEvents: StreamToolResultEvent[];
  final: StreamFinalEvent | null;
  error: string | null;
  isStreaming: boolean;
};
