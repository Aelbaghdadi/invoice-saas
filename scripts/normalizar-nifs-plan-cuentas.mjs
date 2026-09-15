// Normaliza los NIF del plan de cuentas (AccountEntry) a la clave canonica
// que usa el buscador de revision: mayusculas, sin espacios/puntos/guiones
// y SIN prefijo de pais ("PT515160873" -> "515160873").
//
// Por que existe: el importador de Excel guardaba el NIF crudo y el buscador
// pregunta por la version sin prefijo, asi que los terceros intracomunitarios
// nunca casaban. El importador ya normaliza; este script arregla lo que se
// importo antes del fix y fusiona los duplicados que creo el aprendizaje.
//
// Uso:
//   node --env-file=.env scripts/normalizar-nifs-plan-cuentas.mjs           (simulacro)
//   node --env-file=.env scripts/normalizar-nifs-plan-cuentas.mjs --apply   (aplica)
//
// Replica la logica de prefijos de src/lib/validators.ts (parseTaxId).
// Si esa logica cambia, cambiala tambien aqui.
// `pg` viene con @prisma/adapter-pg, que el proyecto ya usa como driver.
// Se usa SQL plano a proposito: este script toca la clave unica de
// AccountEntry y conviene verlo tal cual, sin capa de ORM por medio.
import pg from "pg";

const APPLY = process.argv.includes("--apply");

const EU = new Set(["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","EL","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"]);
const NON_EU = new Set(["GB","CH","NO","US","MX","AR","BR","CL","CO","MA","TR","JP","CN","KR","AU","NZ","CA","IN","SG"]);

function parse(raw) {
  const n = String(raw ?? "").toUpperCase().replace(/[\s\-.]/g, "");
  if (n.length >= 7) {
    const p = n.slice(0, 2);
    if (EU.has(p) || NON_EU.has(p)) return { clean: n.slice(2), country: p };
  }
  return { clean: n, country: null };
}

const vacio = (v) => v == null || String(v).trim() === "";

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const { rows } = await db.query(
  `SELECT id, "clientId", nif, name, "supplierAccount", "expenseAccount",
          "defaultVatRate", "defaultOperationType", "defaultRetentionType", "defaultRetentionRate",
          "intracomGoodsTypePurchase", "intracomGoodsTypeSale"
     FROM "AccountEntry" ORDER BY "createdAt"`
);

// Indice (clientId, nif) -> fila, para detectar fusiones
// Se guarda el pais detectado en cada fila: sin el, el guard de fusion entre
// paises distintos (mas abajo) nunca podria dispararse.
const porClave = new Map(rows.map((r) => [r.clientId + "\u0000" + r.nif, { ...r, pais: parse(r.nif).country }]));

let renombrados = 0, fusionados = 0, intactos = 0, conflictos = 0;

try {
  await db.query("BEGIN");

  for (const r of rows) {
    const { clean: limpio, country: pais } = parse(r.nif);
    if (limpio === r.nif) { intactos++; continue; }
    if (!limpio) { console.log(`SALTO  ${r.nif} (queda vacio al limpiar) [${r.id}]`); continue; }

    const claveDestino = r.clientId + "\u0000" + limpio;
    const destino = porClave.get(claveDestino);

    if (destino && destino.id !== r.id) {
      // PELIGRO: "DE123456789" y "PT123456789" limpian al mismo numero pero
      // son DOS terceros distintos. Fusionarlos borraria las cuentas de uno.
      // Solo fusionamos si el destino no tiene pais o es el mismo pais.
      if (destino.pais && pais && destino.pais !== pais) {
        console.log(`AVISO  ${r.nif} y ${destino.nif} limpian ambos a "${limpio}" pero son paises distintos (${pais} vs ${destino.pais}). NO se fusiona: resuelvelo a mano. [${r.id}]`);
        conflictos++;
        continue;
      }
      // Dos terceros distintos pueden compartir numero: uno importado con
      // prefijo y otro sin el (caso real: CN418306763 "Guangzhou Blings Bag",
      // cuenta 40000046, frente a 418306763 "Guangzhou Hongxin Cosmetics",
      // cuenta 41000192). Si el nombre o alguna cuenta no coinciden, NO se
      // fusiona: se borraria la cuenta de uno de los dos sin avisar.
      const sinSignos = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const nombreReal = (fila) => (fila.name === fila.nif ? "" : sinSignos(fila.name));
      const difieren = (a, b) => !vacio(a) && !vacio(b) && String(a).trim() !== String(b).trim();
      if (
        difieren(nombreReal(destino), nombreReal(r)) ||
        difieren(destino.supplierAccount, r.supplierAccount) ||
        difieren(destino.expenseAccount, r.expenseAccount) ||
        // Bienes/servicios asignado "siempre": si cada fila dice una cosa, lo
        // decide el gestor; fusionar perderia una de las dos asignaciones.
        difieren(destino.intracomGoodsTypePurchase, r.intracomGoodsTypePurchase) ||
        difieren(destino.intracomGoodsTypeSale, r.intracomGoodsTypeSale)
      ) {
        console.log(`AVISO  ${r.nif} ("${r.name}", ${r.supplierAccount || "sin cuenta"}) y ${destino.nif} ("${destino.name}", ${destino.supplierAccount || "sin cuenta"}) limpian a "${limpio}" pero son terceros distintos. NO se fusiona: resuelvelo a mano. [${r.id} / ${destino.id}]`);
        conflictos++;
        continue;
      }
      // Ya existe la fila canonica (creada por el aprendizaje al validar):
      // completar en ella lo que le falte y borrar la fila con prefijo.
      const sets = [];
      const vals = [];
      const rellena = (col, val) => { vals.push(val); sets.push(`"${col}" = $${vals.length}`); };
      // El aprendizaje crea la fila con name = el propio NIF cuando no
      // conoce la razon social; en ese caso el nombre real lo tiene la fila
      // importada que estamos absorbiendo.
      if ((vacio(destino.name) || destino.name === destino.nif) && !vacio(r.name) && r.name !== r.nif) {
        rellena("name", r.name);
      }
      if (vacio(destino.supplierAccount) && !vacio(r.supplierAccount)) rellena("supplierAccount", r.supplierAccount);
      if (vacio(destino.expenseAccount)  && !vacio(r.expenseAccount))  rellena("expenseAccount",  r.expenseAccount);
      if (destino.defaultVatRate == null       && r.defaultVatRate != null)       rellena("defaultVatRate", r.defaultVatRate);
      if (destino.defaultOperationType == null && r.defaultOperationType != null) rellena("defaultOperationType", r.defaultOperationType);
      if (destino.defaultRetentionType == null && r.defaultRetentionType != null) rellena("defaultRetentionType", r.defaultRetentionType);
      if (destino.defaultRetentionRate == null && r.defaultRetentionRate != null) rellena("defaultRetentionRate", r.defaultRetentionRate);
      if (destino.intracomGoodsTypePurchase == null && r.intracomGoodsTypePurchase != null) rellena("intracomGoodsTypePurchase", r.intracomGoodsTypePurchase);
      if (destino.intracomGoodsTypeSale == null && r.intracomGoodsTypeSale != null) rellena("intracomGoodsTypeSale", r.intracomGoodsTypeSale);

      console.log(`FUSION ${r.nif} -> ${limpio}  (${sets.length} campos completados) [${r.id} -> ${destino.id}]`);
      if (APPLY) {
        if (sets.length) {
          vals.push(destino.id);
          await db.query(`UPDATE "AccountEntry" SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
        }
        await db.query(`DELETE FROM "AccountEntry" WHERE id = $1`, [r.id]);
      }
      porClave.delete(r.clientId + "\u0000" + r.nif);
      // Reflejar en memoria lo completado: si una tercera fila colisiona con
      // la misma clave, no debe volver a rellenar los mismos campos.
      for (let i = 0; i < sets.length; i++) {
        const col = sets[i].slice(1, sets[i].indexOf('"', 1));
        destino[col] = vals[i];
      }
      fusionados++;
    } else {
      console.log(`RENOM  ${r.nif} -> ${limpio} [${r.id}]`);
      if (APPLY) {
        await db.query(`UPDATE "AccountEntry" SET nif = $1 WHERE id = $2`, [limpio, r.id]);
      }
      porClave.delete(r.clientId + "\u0000" + r.nif);
      porClave.set(claveDestino, { ...r, nif: limpio, pais });
      renombrados++;
    }
  }

  if (APPLY) { await db.query("COMMIT"); } else { await db.query("ROLLBACK"); }
} catch (e) {
  await db.query("ROLLBACK");
  console.error("ERROR — no se ha aplicado nada:", e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}

console.log(`\n${APPLY ? "APLICADO" : "SIMULACRO (nada escrito; usa --apply)"}: ${renombrados} renombrados, ${fusionados} fusionados, ${conflictos} conflictos sin tocar, ${intactos} ya correctos de ${rows.length} filas.`);
if (conflictos > 0) {
  console.log(`
Hay ${conflictos} colisiones marcadas como AVISO (paises distintos, o terceros distintos con el mismo numero). Se han dejado intactas: revisalas a mano.`);
}
