import { Prisma } from "@prisma/client";

/**
 * Traduce un P2002 (constraint unique violada) al campo real que chocó, al
 * crear o editar un cliente.
 *
 * Con el adaptador @prisma/adapter-pg (Prisma 7), `meta.target` clasico
 * NO viene poblado para Postgres -- el detalle real del error viene
 * anidado en `meta.driverAdapterError.cause.constraint.fields`. Sin
 * mirar ahi, `fields` siempre quedaba vacio y todos los duplicados
 * (CIF, email del cliente, email del usuario del portal) caian en el
 * mismo mensaje generico.
 *
 * Fuera de las acciones: un fichero «use server» solo puede exportar
 * funciones async (Next lo rechaza al construir).
 */
export function duplicateFieldMessage(err: unknown): string {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const meta = err.meta as
      | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
      | undefined;

    const adapterFields = meta?.driverAdapterError?.cause?.constraint?.fields;
    const target = meta?.target;
    const fields = Array.isArray(adapterFields)
      ? adapterFields.join(",")
      : Array.isArray(target)
        ? target.join(",")
        : String(target ?? "");

    if (fields.includes("cif")) return "Ya existe un cliente con ese CIF.";
    if (fields.includes("email")) return "Ya existe un cliente o usuario con ese email.";
  }
  return "Ya existe un cliente con ese CIF o email.";
}
