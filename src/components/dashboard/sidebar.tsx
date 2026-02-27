"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useDescope } from "@descope/nextjs-sdk/client";
import { useCallback } from "react";

const navItems = [
  { href: "/dashboard/goals", label: "Goals" },
  { href: "/dashboard/sessions", label: "Active Sessions" },
  { href: "/dashboard/logs", label: "System Logs" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const sdk = useDescope();

  const handleLogout = useCallback(async () => {
    console.log("🚪 Nexus: Initiating logout...");
    await sdk.logout();
    console.log("🚪 Nexus: Logout complete, redirecting to sign-in");
    router.push("/sign-in");
  }, [sdk, router]);

  return (
    <aside className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cyan-300">Nexus</p>
      <h1 className="mt-2 text-lg font-semibold text-slate-100">Command Center</h1>
      <nav className="mt-6 flex h-[calc(100vh-12rem)] flex-col justify-between">
        <div className="space-y-2">
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
        </div>

        <button
          onClick={handleLogout}
          className="mt-auto flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-red-500/10 hover:text-red-400"
          aria-label="Logout"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Logout
        </button>
      </nav>
    </aside>
  );
}
