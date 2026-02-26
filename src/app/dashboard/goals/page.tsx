import { GoalBoard } from "@/components/dashboard/goal-board";
import { TrafficMap } from "@/components/dashboard/traffic-map";

export default function GoalsDashboardPage() {
  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
        <h1 className="text-2xl font-semibold text-slate-100">Goals</h1>
        <p className="mt-1 text-sm text-slate-400">
          Manage architectural goals, acceptance criteria, and review artifacts.
        </p>
      </header>
      <GoalBoard />
      <TrafficMap />
    </div>
  );
}
