import type { ReactNode } from "react";

import { Sidebar } from "@/components/dashboard/sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_#12303d,_#04070f_55%)] p-4 md:p-8">
      <div className="mx-auto grid w-full max-w-7xl gap-4 lg:grid-cols-[240px_1fr]">
        <Sidebar />
        <main className="space-y-4">{children}</main>
      </div>
    </div>
  );
}
