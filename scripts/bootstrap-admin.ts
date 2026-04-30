/**
 * Bootstrap inicial: crea AdvisoryFirm + admin para que seed-demo pueda correr.
 * Uso: npx tsx scripts/bootstrap-admin.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? "admin@demo.com";
const ADMIN_PASSWORD = "Demo1234!";
const FIRM_NAME = "Asesoría Demo S.L.";
const FIRM_CIF = "B99999999";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log(`✓ Admin ${ADMIN_EMAIL} ya existe (id ${existing.id})`);
    return;
  }

  const firm = await prisma.advisoryFirm.upsert({
    where: { cif: FIRM_CIF },
    update: {},
    create: { name: FIRM_NAME, cif: FIRM_CIF },
  });

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      name: "Admin Demo",
      passwordHash,
      role: "ADMIN",
      advisoryFirmId: firm.id,
    },
  });

  console.log(`✓ AdvisoryFirm: ${firm.name} (${firm.id})`);
  console.log(`✓ Admin creado: ${admin.email} / ${ADMIN_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
