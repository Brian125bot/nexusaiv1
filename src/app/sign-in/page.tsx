"use client";

import { Descope } from "@descope/nextjs-sdk";
import { useRouter } from "next/navigation";

export default function SignInPage() {
    const router = useRouter();

    return (
        <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_#163347,_#040810_60%)] px-4">
            <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950/80 p-8 shadow-2xl shadow-cyan-950/40">
                <p className="text-xs font-semibold uppercase tracking-[0.35em] text-cyan-300">
                    Nexus Orchestrator
                </p>
                <h1 className="mt-3 text-2xl font-bold text-slate-100">Sign In</h1>
                <p className="mt-2 text-sm text-slate-400">
                    Authenticate to access the Command Center.
                </p>
                <div className="mt-6">
                    <Descope
                        flowId="sign-up-or-in"
                        onSuccess={() => router.push("/dashboard/goals")}
                        theme="dark"
                    />
                </div>
            </div>
        </main>
    );
}
