import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#163347,_#040810_60%)] px-6 py-16">
      <div className="mx-auto max-w-4xl rounded-3xl border border-slate-700 bg-slate-950/70 p-8 shadow-2xl shadow-cyan-950/40 md:p-12">
        <p className="text-xs font-semibold uppercase tracking-[0.35em] text-cyan-300">Nexus Orchestrator</p>
        <h1 className="mt-4 text-4xl font-bold text-slate-100 md:text-5xl">Command Center Online</h1>
        <p className="mt-4 max-w-2xl text-base text-slate-300">
          Manage architectural goals, review lock traffic, stream Auditor decisions, and track Jules sessions
          from a single control surface.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/dashboard/goals"
            className="rounded-lg bg-cyan-500 px-5 py-3 text-sm font-semibold text-slate-950"
          >
            Open Dashboard
          </Link>
          <Link
            href="/dashboard/sessions"
            className="rounded-lg border border-slate-600 px-5 py-3 text-sm font-semibold text-slate-200"
          >
            View Active Sessions
          </Link>
        </div>
      </div>
    </main>
  );
}
