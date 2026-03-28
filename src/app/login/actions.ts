"use server";

import { signIn } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";

type FormState = {
  error?: string;
} | undefined;

export async function loginAction(
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

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
