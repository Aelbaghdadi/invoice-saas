import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const p = new PrismaClient({ adapter });
  const users = await p.user.findMany({ select: { email: true, role: true, name: true } });
  console.log(JSON.stringify(users, null, 2));
  await p.$disconnect();
}

main();
