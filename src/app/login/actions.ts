"use server";

import { signIn } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { loginRateLimit, getClientIp } from "@/lib/rateLimit";

type FormState = {
  error?: string;
} | undefined;

export async function loginAction(
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const email = (formData.get("email") as string)?.toLowerCase().trim() ?? "";
  const password = formData.get("password") as string;

  // Rate limit por IP + email (previene credential stuffing y bloqueo por terceros)
  const ip = getClientIp(await headers());
  const rlKey = `login:${ip}:${email}`;
  const rl = loginRateLimit.check(rlKey);
  if (!rl.allowed) {
    return { error: "RATE_LIMITED" };
  }

  try {
    await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.message?.includes("ACCOUNT_LOCKED")) {
        return { error: "ACCOUNT_LOCKED" };
      }
      return { error: "INVALID_CREDENTIALS" };
    }
    return { error: "UNKNOWN_ERROR" };
  }

  // Redirect after successful login - role-based redirect handled by middleware
  redirect("/dashboard");
}
