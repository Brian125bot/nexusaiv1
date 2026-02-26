import { SystemLogView } from "@/components/dashboard/system-log-view";

export default function LogsDashboardPage() {
  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h1 className="text-2xl font-semibold text-slate-100">System Logs</h1>
        <p className="mt-1 text-sm text-slate-400">
          Inspect live registry and lock telemetry from the Nexus backend.
        </p>
      </header>
      <SystemLogView />
    </div>
  );
}
