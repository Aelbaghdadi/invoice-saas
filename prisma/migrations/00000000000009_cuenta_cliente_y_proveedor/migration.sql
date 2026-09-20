-- En A3 el mismo tercero puede tener ficha de CLIENTE (43x) y de PROVEEDOR
-- (40x/41x): FARMACIA AGUACATE CB, NIF E87329710, es 43000053 como cliente y
-- 41000486 como proveedor. AccountEntry solo tenia una pareja de cuentas por
-- (cliente, NIF), asi que la ultima que entraba —importando el plan o
-- aprendiendo al validar— pisaba a la otra, y el autorelleno se quedaba
-- vacio una factura si y otra tambien.

-- Las dos columnas existentes ya usaban "" como vacio (el aprendizaje guarda
-- cadena vacia, nunca null). Hacerlo default evita pasarlas en cada create.
ALTER TABLE "AccountEntry" ALTER COLUMN "supplierAccount" SET DEFAULT '';
ALTER TABLE "AccountEntry" ALTER COLUMN "expenseAccount"  SET DEFAULT '';

ALTER TABLE "AccountEntry" ADD COLUMN "customerAccount" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AccountEntry" ADD COLUMN "incomeAccount"   TEXT NOT NULL DEFAULT '';

-- Reparto con el MISMO criterio que partyAccountMatchesType /
-- resultAccountMatchesType (src/lib/accountingAccount.ts): lo que hasta hoy
-- se ofrecia en ventas es lo que pasa a las columnas de ventas, ni mas ni
-- menos. Comparacion sobre el valor CRUDO a proposito: el formulario solo
-- completa la cuenta al salir del campo, asi que puede haber un "43.1"
-- guardado; quitar el punto antes de comparar convertiria "4.3" (que es
-- 40000003, un proveedor) en "43" y lo mandaria al lado de clientes.
UPDATE "AccountEntry"
   SET "customerAccount" = "supplierAccount", "supplierAccount" = ''
 WHERE "supplierAccount" LIKE '43%';

UPDATE "AccountEntry"
   SET "incomeAccount" = "expenseAccount", "expenseAccount" = ''
 WHERE "expenseAccount" LIKE '7%';

-- Las 44x/46x/47x se quedan en la columna de proveedor. Hoy se ofrecen en los
-- dos sentidos (la comprobacion es una lista negra, no blanca) y no hay forma
-- de saber desde el prefijo a cual pertenecen. Si el asesor usa alguna en
-- ventas, la primera factura la pedira una vez y quedara aprendida en su
-- columna.
