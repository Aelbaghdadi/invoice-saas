import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Role } from "@prisma/client";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const LOCK_ATTEMPTS = 3;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60,       // 8h absolute
    updateAge: 60 * 60,        // refresh every 1h of activity
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = user.role;
        token.advisoryFirmId = user.advisoryFirmId;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id as string;
      session.user.role = token.role as Role;
      session.user.advisoryFirmId = token.advisoryFirmId as string | null;
      return session;
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        // Check if account is locked
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          throw new Error("ACCOUNT_LOCKED");
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);

        if (!isValid) {
          const newAttempts = user.failedAttempts + 1;
          const shouldLock = newAttempts >= LOCK_ATTEMPTS;

          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedAttempts: newAttempts,
              lockedUntil: shouldLock
                ? new Date(Date.now() + LOCK_DURATION_MS)
                : null,
            },
          });

          if (shouldLock) throw new Error("ACCOUNT_LOCKED");
          return null;
        }

        // Reset on successful login
        await prisma.user.update({
          where: { id: user.id },
          data: { failedAttempts: 0, lockedUntil: null },
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          advisoryFirmId: user.advisoryFirmId,
        };
      },
    }),
  ],
});
