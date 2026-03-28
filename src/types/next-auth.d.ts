import { Role } from "@prisma/client";
import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      advisoryFirmId: string | null;
    } & DefaultSession["user"];
  }

  interface User {
    role: Role;
    advisoryFirmId: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    advisoryFirmId: string | null;
  }
}
