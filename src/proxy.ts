import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routes accessible without authentication
const PUBLIC_ROUTES = ["/login"];

// Role-based route prefixes
const ROLE_ROUTES: Record<string, string[]> = {
  ADMIN: ["/dashboard/admin", "/dashboard"],
  WORKER: ["/dashboard/worker", "/dashboard"],
  CLIENT: ["/dashboard/client", "/dashboard"],
};

export default auth((req: NextRequest & { auth: any }) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Allow public routes
  if (PUBLIC_ROUTES.includes(pathname)) {
    // Redirect authenticated users away from login
    if (session?.user) {
      return NextResponse.redirect(new URL(getDashboardUrl(session.user.role), req.url));
    }
    return NextResponse.next();
  }

  // Require authentication for all other routes
  if (!session?.user) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Role-based access control
  const userRole = session.user.role;
  const allowedPrefixes = ROLE_ROUTES[userRole] ?? [];

  if (pathname.startsWith("/dashboard")) {
    const hasAccess = allowedPrefixes.some((prefix) =>
      pathname.startsWith(prefix)
    );
    if (!hasAccess) {
      return NextResponse.redirect(new URL(getDashboardUrl(userRole), req.url));
    }
  }

  return NextResponse.next();
});

function getDashboardUrl(role: string): string {
  switch (role) {
    case "ADMIN":
      return "/dashboard/admin";
    case "WORKER":
      return "/dashboard/worker";
    case "CLIENT":
      return "/dashboard/client";
    default:
      return "/login";
  }
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
