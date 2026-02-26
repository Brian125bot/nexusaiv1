"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

import { fetcher } from "@/lib/ui/fetcher";
import { swrKeys } from "@/lib/ui/swr-keys";
import type { LockRow } from "@/lib/ui/types";

export function TrafficMap() {
  const { data, isLoading } = useSWR<{ locks: LockRow[] }>(swrKeys.locks, fetcher, {
    refreshInterval: 15000,
  });

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const selectedLock = useMemo(() => {
    if (!selectedSessionId) {
      return null;
    }

    return (data?.locks ?? []).find((lock) => lock.sessionId === selectedSessionId) ?? null;
  }, [data?.locks, selectedSessionId]);

  if (isLoading) {
    return <p>Loading lock map...</p>;
  }

  const locks = data?.locks ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h2 className="text-lg font-semibold text-slate-100">File Lock Traffic</h2>
        <p className="mt-1 text-sm text-slate-400">Live lock map from active session registry.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-700 text-left text-sm text-slate-200">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400">
                <th className="py-2 pr-4">File</th>
                <th className="py-2 pr-4">Session</th>
                <th className="py-2 pr-4">Branch</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {locks.map((lock) => (
                <tr
                  key={lock.id}
                  className="cursor-pointer hover:bg-slate-800/80"
                  onClick={() => setSelectedSessionId(lock.sessionId)}
                >
                  <td className="py-2 pr-4 font-mono text-xs">{lock.filePath}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{lock.sessionId.slice(0, 14)}</td>
                  <td className="py-2 pr-4 text-xs">{lock.branchName}</td>
                  <td className="py-2 pr-4 text-xs">
                    <span className="rounded-full border border-cyan-700 px-2 py-0.5 text-cyan-200">
                      {lock.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {locks.length === 0 ? (
            <p className="mt-4 rounded-md border border-dashed border-slate-700 p-4 text-sm text-slate-500">
              No active file locks.
            </p>
          ) : null}
        </div>
      </section>

      <aside className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Session Details</h3>
        {selectedLock ? (
          <div className="mt-3 space-y-2 text-sm text-slate-200">
            <p>
              <span className="text-slate-400">Session:</span> {selectedLock.sessionId}
            </p>
            <p>
              <span className="text-slate-400">Branch:</span> {selectedLock.branchName}
            </p>
            <p>
              <span className="text-slate-400">Base:</span> {selectedLock.baseBranch}
            </p>
            <p>
              <span className="text-slate-400">Goal:</span> {selectedLock.goalId ?? "Unmapped"}
            </p>
            {selectedLock.julesSessionUrl ? (
              <a
                className="inline-block rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950"
                href={selectedLock.julesSessionUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Jules Session
              </a>
            ) : (
              <p className="text-slate-500">No Jules URL available yet.</p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">Select a locked file to inspect linked session data.</p>
        )}
      </aside>
    </div>
  );
}
