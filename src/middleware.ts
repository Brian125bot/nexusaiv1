import { NextRequest, NextResponse } from "next/server";

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Define public routes
  const isPublicRoute = 
    pathname === "/" || 
    pathname === "/sign-in" || 
    pathname === "/api/webhooks/github";

  if (isPublicRoute) {
    return NextResponse.next();
  }

  // Check for Descope session cookies (DS or DSR)
  // This is a lightweight check for the Edge runtime.
  // Full validation happens in the API routes/Server Components using the Node.js runtime.
  const hasSession = req.cookies.has("DS") || req.cookies.has("DSR");

  if (!hasSession) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    // Redirect to sign-in for pages
    const signInUrl = new URL("/sign-in", req.url);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
