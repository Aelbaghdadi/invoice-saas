import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const firm = await prisma.advisoryFirm.upsert({
    where: { cif: "B00000001" },
    update: {},
    create: { name: "Asesoría Demo", cif: "B00000001" },
  });

  const hash = await bcrypt.hash("Demo1234!", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@demo.com" },
    update: {},
    create: {
      email: "admin@demo.com",
      name: "Admin Demo",
      passwordHash: hash,
      role: "ADMIN",
      advisoryFirmId: firm.id,
    },
  });

  console.log("✓ Firma creada:", firm.name);
  console.log("✓ Admin creado:", admin.email);
  console.log("\nCredenciales:");
  console.log("  Email:    admin@demo.com");
  console.log("  Password: Demo1234!");
}

main().catch(console.error).finally(() => prisma.$disconnect());
