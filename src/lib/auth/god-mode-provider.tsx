"use client";

import { type ReactNode, useEffect, useState } from "react";
import { AuthProvider } from "@descope/nextjs-sdk";
import { useDescope, useUser } from "@descope/nextjs-sdk/client";

const isGodModeActive =
  process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_SKIP_AUTH === "true";

const GOD_MODE_USER = {
  name: "Dev User (Nexus God Mode)",
  email: "dev@nexus-orchestrator.local",
  roles: ["admin", "lead_architect"],
};

interface GodModeAuthProviderProps {
  children: ReactNode;
  projectId: string;
}

/**
 * Wrapper around Descope AuthProvider that handles God Mode gracefully.
 * In God Mode, it provides a mock user context to prevent UI components from crashing.
 */
export function GodModeAuthProvider({ children, projectId }: GodModeAuthProviderProps) {
  return (
    <AuthProvider projectId={projectId}>
      {children}
    </AuthProvider>
  );
}

/**
 * Hook to get the current user. Returns mock user in God Mode.
 */
export function useGodModeUser() {
  const [isClient, setIsClient] = useState(false);
  const { user: descopeUser } = useUser();

  useEffect(() => {
    setIsClient(true);
  }, []);

  if (isGodModeActive && isClient) {
    return {
      user: GOD_MODE_USER,
      isAuthenticated: true,
      isMock: true,
    };
  }

  return {
    user: descopeUser
      ? {
          name: descopeUser.name || descopeUser.email || "User",
          email: descopeUser.email,
          roles: (descopeUser as any).roles || [],
        }
      : null,
    isAuthenticated: !!descopeUser,
    isMock: false,
  };
}

/**
 * Hook to get the Descope SDK. Safe to use in God Mode.
 */
export function useGodModeSdk() {
  const sdk = useDescope();

  return {
    sdk,
    isGodMode: isGodModeActive,
  };
}
