import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

// Role-based route prefixes
const ROLE_ROUTES: Record<string, string[]> = {
  ADMIN: ["/dashboard/admin", "/dashboard"],
  WORKER: ["/dashboard/worker", "/dashboard"],
  CLIENT: ["/dashboard/client", "/dashboard"],
};

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

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Allow all /login sub-routes (login, forgot-password, reset-password)
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    // Redirect authenticated users away from /login only
    if (session?.user && pathname === "/login") {
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

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
