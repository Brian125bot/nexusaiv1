import { SessionList } from "@/components/dashboard/session-list";

export default function SessionsDashboardPage() {
  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h1 className="text-2xl font-semibold text-slate-100">Active Sessions</h1>
        <p className="mt-1 text-sm text-slate-400">
          Monitor live Jules execution and stream Auditor orchestration reports.
        </p>
      </header>
      <SessionList />
    </div>
  );
}
