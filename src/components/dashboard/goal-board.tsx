"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

import { fetcher, jsonRequest } from "@/lib/ui/fetcher";
import { swrKeys } from "@/lib/ui/swr-keys";
import type { Goal, GoalStatus } from "@/lib/ui/types";

const statusOrder: GoalStatus[] = ["backlog", "in-progress", "completed", "drifted"];

const statusLabels: Record<GoalStatus, string> = {
  backlog: "Backlog",
  "in-progress": "In Progress",
  completed: "Completed",
  drifted: "Drifted",
};

function emptyGoalDraft() {
  return {
    title: "",
    description: "",
    acceptanceCriteriaText: "",
    status: "backlog" as GoalStatus,
  };
}

export function GoalBoard() {
  const { data, mutate, isLoading } = useSWR<{ goals: Goal[] }>(swrKeys.goals, fetcher, {
    refreshInterval: 15000,
  });
  const [draft, setDraft] = useState(emptyGoalDraft());
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const goals = data?.goals ?? [];
    return statusOrder.map((status) => ({
      status,
      goals: goals.filter((goal) => goal.status === status),
    }));
  }, [data?.goals]);

  const handleCreate = async () => {
    setError(null);

    const acceptanceCriteria = draft.acceptanceCriteriaText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!draft.title.trim() || acceptanceCriteria.length === 0) {
      setError("Title and at least one acceptance criterion are required.");
      return;
    }

    setIsCreating(true);
    try {
      await jsonRequest<{ goal: Goal }>("/api/goals", {
        method: "POST",
        body: JSON.stringify({
          title: draft.title,
          description: draft.description || undefined,
          acceptanceCriteria,
          status: draft.status,
        }),
      });
      setDraft(emptyGoalDraft());
      await mutate();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create goal");
    } finally {
      setIsCreating(false);
    }
  };

  const updateStatus = async (goal: Goal, status: GoalStatus) => {
    await jsonRequest<{ goal: Goal }>(`/api/goals/${goal.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await mutate();
  };

  const removeGoal = async (goalId: string) => {
    await jsonRequest<{ ok: boolean }>(`/api/goals/${goalId}`, {
      method: "DELETE",
    });
    await mutate();
  };

  if (isLoading) {
    return <p>Loading goals...</p>;
  }

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h2 className="text-lg font-semibold text-slate-100">Create Goal</h2>
        <p className="mt-1 text-sm text-slate-400">
          Define architecture intent and acceptance criteria for Auditor validation.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <input
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            placeholder="Goal title"
            value={draft.title}
            onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
          />
          <select
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            value={draft.status}
            onChange={(event) => setDraft((prev) => ({ ...prev, status: event.target.value as GoalStatus }))}
          >
            {statusOrder.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
          <textarea
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 md:col-span-2"
            rows={2}
            placeholder="Description"
            value={draft.description}
            onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
          />
          <textarea
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 md:col-span-2"
            rows={4}
            placeholder={"Acceptance criteria (one per line)\nNo hardcoded secrets\nMust update tests"}
            value={draft.acceptanceCriteriaText}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, acceptanceCriteriaText: event.target.value }))
            }
          />
        </div>
        {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
        <button
          type="button"
          disabled={isCreating}
          onClick={handleCreate}
          className="mt-4 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
        >
          {isCreating ? "Creating..." : "Create Goal"}
        </button>
      </section>

      <section className="grid gap-4 lg:grid-cols-4">
        {grouped.map((bucket) => (
          <div key={bucket.status} className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-200">
              {statusLabels[bucket.status]}
            </h3>
            <p className="mt-1 text-xs text-slate-400">{bucket.goals.length} goals</p>
            <div className="mt-3 space-y-3">
              {bucket.goals.map((goal) => (
                <article key={goal.id} className="rounded-lg border border-slate-700 bg-slate-950/80 p-3">
                  <h4 className="text-sm font-semibold text-slate-100">{goal.title}</h4>
                  {goal.description ? (
                    <p className="mt-1 text-xs text-slate-400">{goal.description}</p>
                  ) : null}
                  <ul className="mt-2 space-y-1 text-xs text-slate-300">
                    {goal.acceptanceCriteria.map((criterion) => (
                      <li key={criterion.id}>
                        {criterion.met ? "✅" : "⏳"} {criterion.text}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 space-y-1 text-xs text-slate-300">
                    {goal.reviewArtifacts.length > 0 ? (
                      goal.reviewArtifacts.map((artifact) => (
                        <a
                          key={`${artifact.sessionExternalId}-${artifact.url}`}
                          href={artifact.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-cyan-300 underline"
                        >
                          PR Artifact ({artifact.sessionExternalId})
                        </a>
                      ))
                    ) : (
                      <span className="text-slate-500">No review artifacts yet</span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {statusOrder.map((status) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => void updateStatus(goal, status)}
                        className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-200"
                      >
                        {statusLabels[status]}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => void removeGoal(goal.id)}
                      className="rounded-md border border-rose-700 px-2 py-1 text-[11px] text-rose-300"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
              {bucket.goals.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-700 p-3 text-xs text-slate-500">
                  No goals in this column.
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
