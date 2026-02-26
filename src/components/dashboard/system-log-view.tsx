"use client";

import useSWR from "swr";

import { fetcher } from "@/lib/ui/fetcher";
import { swrKeys } from "@/lib/ui/swr-keys";
import type { LockRow, Session } from "@/lib/ui/types";

export function SystemLogView() {
  const { data: sessionsData } = useSWR<{ sessions: Session[] }>(swrKeys.activeSessions, fetcher, {
    refreshInterval: 15000,
  });
  const { data: locksData } = useSWR<{ locks: LockRow[] }>(swrKeys.locks, fetcher, {
    refreshInterval: 15000,
  });

  const sessions = sessionsData?.sessions ?? [];
  const locks = locksData?.locks ?? [];

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
      <h2 className="text-lg font-semibold text-slate-100">System Logs</h2>
      <p className="mt-1 text-sm text-slate-400">Operational snapshot updated every 15 seconds.</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Active Sessions</h3>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
            {JSON.stringify(sessions, null, 2)}
          </pre>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">File Locks</h3>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
            {JSON.stringify(locks, null, 2)}
          </pre>
        </div>
      </div>
    </section>
  );
}
