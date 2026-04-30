/**
 * Cambia el password del admin@demo.com
 * Uso: npx tsx scripts/set-admin-password.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const ADMIN_EMAIL = "admin@demo.com";
const NEW_PASSWORD = "admin123";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const hash = await bcrypt.hash(NEW_PASSWORD, 12);
  const updated = await prisma.user.update({
    where: { email: ADMIN_EMAIL },
    data: { passwordHash: hash, failedAttempts: 0, lockedUntil: null },
  });
  console.log(`✓ Password actualizada para ${updated.email} → ${NEW_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
