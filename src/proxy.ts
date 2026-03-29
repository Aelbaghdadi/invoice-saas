import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// Routes accessible without authentication (prefix match)
const PUBLIC_PREFIXES = ["/login"];

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

export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public routes (login, forgot-password, reset-password, etc.)
  const isPublic = PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
  });

  if (isPublic) {
    // Redirect authenticated users away from login page only
    if (token && pathname === "/login") {
      return NextResponse.redirect(
        new URL(getDashboardUrl(token.role as string), req.url)
      );
    }
    return NextResponse.next();
  }

  // Require authentication for all other routes
  if (!token) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Role-based access control
  const userRole = token.role as string;
  const allowedPrefixes = ROLE_ROUTES[userRole] ?? [];

  if (pathname.startsWith("/dashboard")) {
    const hasAccess = allowedPrefixes.some((prefix) =>
      pathname.startsWith(prefix)
    );
    if (!hasAccess) {
      return NextResponse.redirect(
        new URL(getDashboardUrl(userRole), req.url)
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
