import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as dotenv from "dotenv";
dotenv.config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as any);

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, clientProfile: { select: { name: true, cif: true } } }
  });
  console.log("Usuarios en BD:");
  console.table(users.map(u => ({ ...u, clientCif: u.clientProfile?.cif, clientName: u.clientProfile?.name, clientProfile: undefined })));
  await prisma.$disconnect();
}
main();
