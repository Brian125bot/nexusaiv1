"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/dashboard/goals", label: "Goals" },
  { href: "/dashboard/sessions", label: "Active Sessions" },
  { href: "/dashboard/logs", label: "System Logs" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cyan-300">Nexus</p>
      <h1 className="mt-2 text-lg font-semibold text-slate-100">Command Center</h1>
      <nav className="mt-6 space-y-2">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-lg px-3 py-2 text-sm transition ${
                active
                  ? "bg-cyan-500 text-slate-950"
                  : "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
