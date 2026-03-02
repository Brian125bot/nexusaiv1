"use client";

import * as HoverCard from "@radix-ui/react-hover-card";
import { useMemo, useState } from "react";
import useSWR from "swr";

import { fetcher, jsonRequest } from "@/lib/ui/fetcher";
import { swrKeys } from "@/lib/ui/swr-keys";
import type { Goal, GoalStatus, Session } from "@/lib/ui/types";

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
  const { data: sessionsData } = useSWR<{ sessions: Session[] }>(swrKeys.activeSessions, fetcher, {
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

  const verifyingGoalIds = useMemo(
    () =>
      new Set(
        (sessionsData?.sessions ?? []).flatMap((session) =>
          session.status === "verifying" && session.goalId ? [session.goalId] : [],
        ),
      ),
    [sessionsData?.sessions],
  );

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

  const reAudit = async (goalId: string) => {
    try {
      await jsonRequest(`/api/goals/${goalId}/re-audit`, {
        method: "POST",
      });
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to re-audit");
    }
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
              {bucket.goals.map((goal) => {
                const isVerifying = verifyingGoalIds.has(goal.id);

                return (
                  <article
                    key={goal.id}
                    className={`rounded-lg border bg-slate-950/80 p-3 ${
                      isVerifying
                        ? "animate-pulse border-amber-500/50 ring-1 ring-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.2)]"
                        : "border-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-slate-100">{goal.title}</h4>
                      {isVerifying ? (
                        <span className="rounded-md border border-amber-500/40 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                          Verifying...
                        </span>
                      ) : null}
                    </div>
                  {goal.description ? (
                    <p className="mt-1 text-xs text-slate-400">{goal.description}</p>
                  ) : null}
                  <ul className="mt-2 space-y-2 text-xs text-slate-300">
                    {goal.acceptanceCriteria.map((criterion) => (
                      <li key={criterion.id} className="flex flex-col gap-1">
                        <HoverCard.Root openDelay={120} closeDelay={120}>
                          <HoverCard.Trigger asChild>
                            <button type="button" className="flex items-start gap-1.5 text-left">
                              <span>{criterion.met ? "✅" : "⏳"}</span>
                              <span className={criterion.met ? "text-slate-300" : "text-slate-400 italic"}>
                                {criterion.text}
                              </span>
                            </button>
                          </HoverCard.Trigger>
                          <HoverCard.Portal>
                            <HoverCard.Content
                              side="top"
                              align="start"
                              sideOffset={8}
                              collisionPadding={16}
                              className="z-50 w-72 max-w-[calc(100vw-2rem)] break-words rounded-lg border border-slate-700 bg-slate-900/95 p-3 text-xs text-slate-300 shadow-xl backdrop-blur-sm"
                            >
                              <p className="font-semibold text-slate-200">Auditor Reasoning</p>
                              <p className="mt-1 leading-relaxed text-slate-300">
                                {criterion.reasoning?.trim()
                                  ? criterion.reasoning
                                  : "No auditor reasoning captured."}
                              </p>
                              <HoverCard.Arrow className="fill-slate-700" />
                            </HoverCard.Content>
                          </HoverCard.Portal>
                        </HoverCard.Root>
                        {criterion.files && criterion.files.length > 0 && (
                          <div className="ml-5 flex flex-wrap gap-1">
                            {criterion.files.map((file) => (
                              <span
                                key={file}
                                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                                  criterion.met
                                    ? "border-emerald-700/50 bg-emerald-950/30 text-emerald-300"
                                    : "border-slate-700 bg-slate-800 text-slate-400"
                                }`}
                                title={file}
                              >
                                {file.split("/").pop()}
                              </span>
                            ))}
                          </div>
                        )}
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
                    {goal.reviewArtifacts.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void reAudit(goal.id)}
                        className="rounded-md border border-cyan-600 bg-cyan-950/30 px-2 py-1 text-[11px] text-cyan-200 hover:bg-cyan-900/50"
                      >
                        Re-Audit
                      </button>
                    )}
                  </div>
                  </article>
                );
              })}
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
