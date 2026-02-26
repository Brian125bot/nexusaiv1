"use client";

import { useState } from "react";
import useSWR from "swr";

import { fetcher, jsonRequest } from "@/lib/ui/fetcher";
import { swrKeys } from "@/lib/ui/swr-keys";

type CascadeEvent = {
  cascadeId: string;
  isCascade: boolean;
  coreFilesChanged: string[];
  downstreamFiles: string[];
  repairJobCount: number;
  status: "analyzing" | "dispatched" | "completed" | "failed";
  createdAt: number;
};

export function CascadeEvents() {
  const { data, mutate, isLoading } = useSWR<{ cascades: CascadeEvent[] }>(
    swrKeys.cascadeEvents,
    fetcher,
    {
      refreshInterval: 10000,
    },
  );

  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleManualAnalysis = async () => {
    setIsAnalyzing(true);
    try {
      // This would trigger a scan of recent commits for core file changes
      await jsonRequest("/api/cascade/scan", {
        method: "POST",
      });
      await mutate();
    } catch (error) {
      console.error("Failed to trigger cascade analysis:", error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const cascades = data?.cascades ?? [];

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">🌊 Blast Radius Cascade</h2>
          <p className="mt-1 text-sm text-slate-400">
            Multi-agent refactoring operations triggered by core file changes
          </p>
        </div>
        <button
          onClick={handleManualAnalysis}
          disabled={isAnalyzing}
          className="rounded-lg border border-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-50"
        >
          {isAnalyzing ? "Scanning..." : "Scan for Cascades"}
        </button>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-slate-400">Loading cascade events...</p>
      ) : cascades.length === 0 ? (
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-6 text-center">
          <p className="text-sm text-slate-500">No cascade events detected</p>
          <p className="mt-1 text-xs text-slate-600">
            Cascades are automatically triggered when core files like schema.ts or types.ts are
            modified
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {cascades.map((cascade) => (
            <CascadeEventCard key={cascade.cascadeId} cascade={cascade} />
          ))}
        </div>
      )}
    </section>
  );
}

function CascadeEventCard({ cascade }: { cascade: CascadeEvent }) {
  const statusColors: Record<CascadeEvent["status"], string> = {
    analyzing: "bg-yellow-500/10 text-yellow-300 border-yellow-500/30",
    dispatched: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
    completed: "bg-green-500/10 text-green-300 border-green-500/30",
    failed: "bg-red-500/10 text-red-300 border-red-500/30",
  };

  const statusLabels: Record<CascadeEvent["status"], string> = {
    analyzing: "Analyzing",
    dispatched: "Agents Dispatched",
    completed: "Completed",
    failed: "Failed",
  };

  return (
    <div
      className={`rounded-lg border p-4 ${statusColors[cascade.status]} transition hover:border-opacity-50`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{cascade.cascadeId}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium border ${statusColors[cascade.status]}`}
            >
              {statusLabels[cascade.status]}
            </span>
          </div>

          {cascade.coreFilesChanged.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium opacity-80">Core Files Changed:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {cascade.coreFilesChanged.map((file) => (
                  <span
                    key={file}
                    className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-slate-300"
                  >
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-2 flex gap-4 text-xs opacity-70">
            <span>📁 {cascade.downstreamFiles.length} downstream files</span>
            <span>🤖 {cascade.repairJobCount} repair agents</span>
          </div>
        </div>

        <div className="ml-4 flex flex-col items-end gap-2">
          <a
            href={`/dashboard/sessions?cascade=${cascade.cascadeId}`}
            className="text-xs font-medium underline hover:no-underline"
          >
            View Sessions →
          </a>
        </div>
      </div>
    </div>
  );
}
