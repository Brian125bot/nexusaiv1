"use client";

import type { AuditorReportState } from "@/lib/ui/types";

type AuditorReportProps = {
  state: AuditorReportState;
};

export function AuditorReport({ state }: AuditorReportProps) {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 md:p-6">
      <h2 className="text-lg font-semibold text-slate-100">Auditor Report Stream</h2>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Phases</h3>
          <ul className="mt-2 space-y-1 text-sm text-slate-200">
            {state.phases.map((phase, index) => (
              <li key={`${phase.phase}-${index}`}>
                <span className="font-mono text-cyan-300">{phase.phase}</span>
                {phase.status ? ` (${phase.status})` : ""}
              </li>
            ))}
            {state.phases.length === 0 ? <li className="text-slate-500">No events yet.</li> : null}
          </ul>
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tool Results</h3>
          <ul className="mt-2 space-y-2 text-xs text-slate-200">
            {state.toolEvents.map((event, index) => (
              <li key={`${event.toolName}-${index}`} className="rounded-md border border-slate-700 p-2">
                <p className="font-mono text-cyan-300">{event.toolName}</p>
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-slate-300">
                  {JSON.stringify(event.output, null, 2)}
                </pre>
              </li>
            ))}
            {state.toolEvents.length === 0 ? <li className="text-slate-500">No tool events yet.</li> : null}
          </ul>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950/80 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reasoning</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-100">{state.text || "Waiting for stream..."}</p>
      </div>

      {state.final?.provisionalPlan ? (
        <div className="mt-4 rounded-lg border border-amber-700 bg-amber-950/20 p-3 text-sm text-amber-200">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300">Provisional Plan</h3>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">
            {JSON.stringify(state.final.provisionalPlan, null, 2)}
          </pre>
        </div>
      ) : null}

      {state.final?.julesSessionUrl ? (
        <a
          href={state.final.julesSessionUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950"
        >
          Open Jules Session
        </a>
      ) : null}

      {state.error ? <p className="mt-3 text-sm text-rose-400">{state.error}</p> : null}
    </section>
  );
}
