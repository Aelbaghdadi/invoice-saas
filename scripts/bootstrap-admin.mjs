// Crea la AdvisoryFirm + el PRIMER usuario ADMIN en una base de datos vacía.
// Node plano (sin tsx), pensado para ejecutarlo dentro del contenedor tras el
// primer deploy:
//
//   node scripts/bootstrap-admin.mjs
//
// Parametrizable por variables de entorno (con valores por defecto de demo):
//   ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, FIRM_NAME, FIRM_CIF
//
// El login es por `username` (no por email). Si no se pasa ADMIN_USERNAME se
// deriva de la parte local del email (admin@empresa.com -> "admin").
//
// Es idempotente: si el admin ya existe (mismo email), no hace nada.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? process.env.DEMO_ADMIN_EMAIL ?? "admin@demo.com";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? ADMIN_EMAIL.split("@")[0];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Demo1234!";
const ADMIN_NAME = process.env.ADMIN_NAME ?? "Administrador";
const FIRM_NAME = process.env.FIRM_NAME ?? "Asesoría";
const FIRM_CIF = process.env.FIRM_CIF ?? "B00000000";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log(`✓ El admin ${ADMIN_EMAIL} ya existe (id ${existing.id}). Nada que hacer.`);
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
      username: ADMIN_USERNAME,
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      passwordHash,
      role: "ADMIN",
      advisoryFirmId: firm.id,
    },
  });

  console.log(`✓ Asesoría: ${firm.name} (${firm.cif})`);
  console.log(`✓ Admin:    ${admin.email}`);
  console.log(`✓ Usuario de acceso: ${admin.username}  (se inicia sesión con esto, no con el email)`);
  if (ADMIN_PASSWORD === "Demo1234!") {
    console.log("⚠ Estás usando la contraseña por defecto (Demo1234!). Cámbiala YA");
    console.log("  desde Ajustes → Contraseña, o define ADMIN_PASSWORD antes de ejecutar.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
