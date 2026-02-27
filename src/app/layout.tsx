import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { publicEnv } from "@/lib/config";
import { GodModeAuthProvider } from "@/lib/auth/god-mode-provider";
import "./globals.css";

const headingFont = Space_Grotesk({
  variable: "--font-heading",
  subsets: ["latin"],
});

const monoFont = IBM_Plex_Mono({
  variable: "--font-ibm-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

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
      <body className={`${headingFont.variable} ${monoFont.variable} antialiased`}>
        <GodModeAuthProvider projectId={publicEnv.NEXT_PUBLIC_DESCOPE_PROJECT_ID}>
          {children}
        </GodModeAuthProvider>
      </body>
    </html>
  );
}
