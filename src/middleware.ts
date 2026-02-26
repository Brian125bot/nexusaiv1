import { authMiddleware } from "@descope/nextjs-sdk/server";

export default authMiddleware({
  projectId: process.env.DESCOPE_PROJECT_ID!,
  redirectUrl: "/sign-in",
  publicRoutes: [
    "/",
    "/sign-in",
    "/api/webhooks/github",
  ],
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
