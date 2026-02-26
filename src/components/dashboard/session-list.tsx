"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";

import { AuditorReport } from "@/components/dashboard/auditor-report";
import { fetcher, jsonRequest } from "@/lib/ui/fetcher";
import { initialAuditorReportState, streamOrchestratorReport } from "@/lib/ui/sse-client";
import { swrKeys } from "@/lib/ui/swr-keys";
import type { AuditorReportState, Goal, Session } from "@/lib/ui/types";

export function SessionList() {
  const {
    data: sessionsData,
    mutate: mutateSessions,
    isLoading,
  } = useSWR<{ sessions: Session[] }>(swrKeys.activeSessions, fetcher, {
    refreshInterval: 15000,
  });
  const { data: goalsData, mutate: mutateGoals } = useSWR<{ goals: Goal[] }>(swrKeys.goals, fetcher, {
    refreshInterval: 15000,
  });
  const { mutate: mutateLocks } = useSWR(swrKeys.locks, fetcher, {
    refreshInterval: 15000,
  });

  const [form, setForm] = useState({
    goalId: "",
    prompt: "",
    sourceRepo: "",
    startingBranch: "main",
  });
  const [reportState, setReportState] = useState<AuditorReportState>(() => initialAuditorReportState());
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeSessions = useMemo(() => sessionsData?.sessions ?? [], [sessionsData?.sessions]);
  const goals = useMemo(() => goalsData?.goals ?? [], [goalsData?.goals]);

  useEffect(() => {
    if (!activeSessions.length) {
      return;
    }

    const interval = setInterval(() => {
      void jsonRequest<{ results: unknown[] }>("/api/orchestrator/sync-batch", {
        method: "POST",
        body: JSON.stringify({ sessionIds: activeSessions.map((session) => session.id) }),
      }).then(async () => {
        await Promise.all([mutateSessions(), mutateGoals(), mutateLocks()]);
      });
    }, 15000);

    return () => clearInterval(interval);
  }, [activeSessions, mutateGoals, mutateLocks, mutateSessions]);

  const selectedGoal = useMemo(
    () => goals.find((goal) => goal.id === form.goalId) ?? null,
    [goals, form.goalId],
  );

  const startDraft = async () => {
    setSubmitError(null);
    setReportState(initialAuditorReportState());

    try {
      await streamOrchestratorReport(
        {
          goalId: form.goalId,
          prompt: form.prompt,
          sourceRepo: form.sourceRepo,
          startingBranch: form.startingBranch,
          confirmDispatch: false,
        },
        {
          onStart: () =>
            setReportState((prev) => ({
              ...prev,
              isStreaming: true,
            })),
          onPhase: (phase) =>
            setReportState((prev) => ({
              ...prev,
              phases: [...prev.phases, phase],
            })),
          onDelta: (text) =>
            setReportState((prev) => ({
              ...prev,
              text: `${prev.text}${text}`,
            })),
          onToolResult: (event) =>
            setReportState((prev) => ({
              ...prev,
              toolEvents: [...prev.toolEvents, event],
            })),
          onFinal: (final) =>
            setReportState((prev) => ({
              ...prev,
              final,
            })),
          onError: (error) =>
            setReportState((prev) => ({
              ...prev,
              error,
            })),
          onDone: () =>
            setReportState((prev) => ({
              ...prev,
              isStreaming: false,
            })),
        },
      );
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to generate provisional plan");
      setReportState((prev) => ({ ...prev, isStreaming: false }));
    }
  };

  const confirmDispatch = async () => {
    setSubmitError(null);
    setReportState(initialAuditorReportState());

    try {
      await streamOrchestratorReport(
        {
          goalId: form.goalId,
          prompt: form.prompt,
          sourceRepo: form.sourceRepo,
          startingBranch: form.startingBranch,
          confirmDispatch: true,
        },
        {
          onStart: () =>
            setReportState((prev) => ({
              ...prev,
              isStreaming: true,
            })),
          onPhase: (phase) =>
            setReportState((prev) => ({
              ...prev,
              phases: [...prev.phases, phase],
            })),
          onDelta: (text) =>
            setReportState((prev) => ({
              ...prev,
              text: `${prev.text}${text}`,
            })),
          onToolResult: (event) =>
            setReportState((prev) => ({
              ...prev,
              toolEvents: [...prev.toolEvents, event],
            })),
          onFinal: (final) =>
            setReportState((prev) => ({
              ...prev,
              final,
            })),
          onError: (error) =>
            setReportState((prev) => ({
              ...prev,
              error,
            })),
          onDone: async () => {
            setReportState((prev) => ({
              ...prev,
              isStreaming: false,
            }));
            await Promise.all([mutateSessions(), mutateGoals(), mutateLocks()]);
          },
        },
      );
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to dispatch Jules session");
      setReportState((prev) => ({ ...prev, isStreaming: false }));
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h2 className="text-lg font-semibold text-slate-100">Trigger Orchestration</h2>
        <p className="mt-1 text-sm text-slate-400">
          Draft provisional lock plan first, then confirm dispatch to start Jules.
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <select
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            value={form.goalId}
            onChange={(event) => setForm((prev) => ({ ...prev, goalId: event.target.value }))}
          >
            <option value="">Select goal</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
          <input
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            placeholder="owner/repo"
            value={form.sourceRepo}
            onChange={(event) => setForm((prev) => ({ ...prev, sourceRepo: event.target.value }))}
          />
          <input
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 md:col-span-2"
            placeholder="Coding request"
            value={form.prompt}
            onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))}
          />
          <input
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            placeholder="Starting branch"
            value={form.startingBranch}
            onChange={(event) => setForm((prev) => ({ ...prev, startingBranch: event.target.value }))}
          />
          <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-400">
            {selectedGoal
              ? `${selectedGoal.acceptanceCriteria.length} acceptance criteria linked to selected goal`
              : "Select a goal to bind Auditor context"}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void startDraft()}
            disabled={reportState.isStreaming || !form.goalId || !form.prompt || !form.sourceRepo}
            className="rounded-lg border border-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-50"
          >
            Provisional Plan
          </button>
          <button
            type="button"
            onClick={() => void confirmDispatch()}
            disabled={reportState.isStreaming || !form.goalId || !form.prompt || !form.sourceRepo}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            Confirm Dispatch
          </button>
          <button
            type="button"
            onClick={() => setReportState(initialAuditorReportState())}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
          >
            Cancel / Clear
          </button>
        </div>

        {submitError ? <p className="mt-3 text-sm text-rose-400">{submitError}</p> : null}
      </section>

      <AuditorReport state={reportState} />

      <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h2 className="text-lg font-semibold text-slate-100">Active Sessions</h2>
        {isLoading ? (
          <p className="mt-2 text-sm text-slate-400">Loading active sessions...</p>
        ) : activeSessions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No active sessions.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {activeSessions.map((session) => (
              <article key={session.id} className="rounded-lg border border-slate-700 bg-slate-950/80 p-3">
                <p className="text-sm font-semibold text-slate-100">{session.branchName}</p>
                <p className="text-xs text-slate-400">{session.sourceRepo}</p>
                <p className="mt-1 text-xs text-slate-300">Status: {session.status}</p>
                {session.julesSessionUrl ? (
                  <a
                    href={session.julesSessionUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs text-cyan-300 underline"
                  >
                    Open Jules Session
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
