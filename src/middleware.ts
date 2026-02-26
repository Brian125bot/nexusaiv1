import { NextRequest, NextResponse } from "next/server";
import { authMiddleware } from "@descope/nextjs-sdk/server";
import { authEnv } from "@/lib/config";

const descopeMiddleware = authMiddleware({
  projectId: authEnv.DESCOPE_PROJECT_ID,
  redirectUrl: "/sign-in",
  publicRoutes: [
    "/",
    "/sign-in",
    "/api/webhooks/github",
  ],
});

export default async function middleware(req: NextRequest) {
  const response = await descopeMiddleware(req);

  if (
    req.nextUrl.pathname.startsWith("/api/") &&
    !req.nextUrl.pathname.startsWith("/api/webhooks/github") &&
    isRedirectResponse(response)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has("location");
}
