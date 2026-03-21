import type { Metadata } from "next";
import { publicEnv } from "@/lib/config";
import { GodModeAuthProvider } from "@/lib/auth/god-mode-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus Command Center",
  description: "AI-native orchestration dashboard for the Nexus Orchestrator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <GodModeAuthProvider projectId={publicEnv.NEXT_PUBLIC_DESCOPE_PROJECT_ID}>
          {children}
        </GodModeAuthProvider>
      </body>
    </html>
  );
}
