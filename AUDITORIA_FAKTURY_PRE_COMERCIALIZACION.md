# Auditoría de Faktury antes de comercializar

| | |
|---|---|
| **Fecha** | 25/09/2026 |
| **Alcance** | Commit `9d4b10f` de la rama `dev`, el que está desplegado en dev.faktury.es. Se ha revisado el código, el esquema y las migraciones, la configuración de despliegue y la documentación del repositorio. Quedan fuera los cambios sin commitear del árbol de trabajo (salvo menciones puntuales), la configuración real de Coolify y Hetzner, y la base de datos de producción. Los 22 fallos ya detectados en este commit que se están arreglando (`fixes.json`) no se vuelven a contar, salvo cuando la auditoría encuentra algo distinto. |
| **Método** | 13 agentes especialistas: arquitectura, rendimiento, UX, flujo de gestoría, bugs e integridad, seguridad, base de datos, precisión contable, exportación, preparación SaaS, QA, observabilidad y abogado del diablo. Sus resultados se consolidaron en 155 hallazgos únicos (`F-001` a `F-155`). Los 42 P0/P1 pasaron una verificación adversarial doble, y los 22 argumentos del abogado del diablo, una verificación independiente. |
| **Pruebas ejecutadas** | `tsc --noEmit` (limpio), `vitest` (370 tests en 19 ficheros, todos en verde), `eslint`, y simulaciones en Node 22 sobre una copia de solo lectura del commit usando el código real: `NextResponse`, `parseTaxId`, `fileValidation`, runtime de Prisma 7.5 y `pdfjs-dist`. |
| **Estado posterior** | El 26/09 se subió a `dev` el commit `11d1eab`, que corrige los 22 fallos de la revisión anterior (`fixes.json`). Ninguno de los P0 de este documento está corregido todavía. |
| **Límites** | No se ha ejecutado nada en navegador, contra una BD real ni contra producción. Los P2 y P3 no pasaron verificación adversarial. Cuando algo no se pudo comprobar, se dice. |

**Leyenda.** 🔴 P0 bloqueante · 🟠 P1 alta · 🟡 P2 media · 🟢 P3 baja.
**Nivel de evidencia.**
- **HECHO VERIFICADO**: comprobado en el código o reproducido.
- **RIESGO PROBABLE**: el mecanismo está comprobado, pero el efecto real no se ha medido o depende de algo externo.
- **POSIBLE MEJORA**.

---

## 1. Executive Summary

### Estado general

Faktury funciona hoy para una asesoría piloto (MS Assessors) mientras el desarrollador está disponible para resolver lo que surja. El núcleo del producto hace trabajo real: subida, OCR, pantalla de revisión y Excel para A3. Se nota que sale de uso diario. La revisión es de lo mejor del código. La lógica fiscal delicada (recargo, intracomunitarias, numeración, huella de reexportación) está en módulos puros con tests, y la auditoría tiene cadena de hash y trigger de inmutabilidad.

Eso es que *funciona*. Estar *preparado para producción con clientes que pagan* es otra cosa, y hoy no se cumple:

- La entrega del Excel a A3 puede dejar facturas marcadas como exportadas sin fichero y sin forma de recuperarlas. Con un apóstrofo tipográfico en el nombre del cliente, el fallo es determinista (F-001, F-017).
- Un cliente del portal puede ejecutar código en la sesión del gestor o del admin subiendo un «XML» (F-002).
- No consta ninguna copia de seguridad fuera del único servidor, que ya llenó el disco una vez (F-003).
- Hay 8 puntos por los que un ADMIN ve o modifica datos de otra asesoría (F-004, F-005).
- La integridad de estados y de cifras depende de la UI y de que las acciones no se crucen (F-008, F-009, F-014, F-015).
- No hay CI, ni tests contra BD, ni seguimiento de errores, ni el marco legal necesario para cobrar (F-032, F-033, F-034, F-038).

### Nivel de madurez

| Dimensión | Nivel | Motivo |
|---|---|---|
| Lógica fiscal y de dominio | Madura para el alcance del piloto | Módulos puros, 370 tests, casos reales documentados |
| Revisión (trabajo del gestor) | Buena | Visor, atajos, cuadre, cola del lote. Huecos serios: F-016, F-047 |
| Orquestación (acciones, rutas, transacciones) | Prototipo | 249 de 310 llamadas `prisma.*` están en páginas y acciones. No hay máquina de estados ni transacciones comunes |
| Exportación a A3 | Contenido correcto, entrega frágil | La fila A3 está bien. Marcar y entregar el lote no (F-001) |
| Aislamiento multi-tenant | Insuficiente para 2 o más asesorías | Filtro a mano en cada consulta, 8 fugas, CIF único global |
| Operación y continuidad | Artesanal | Sin backup externo, sin alertas, recuperación automática rota, despliegue manual |
| Proceso de calidad | Débil | Sin CI, lint en rojo, E2E roto, 0 tests de integración |
| Preparación comercial | Inexistente | Sin DPA, condiciones ni privacidad; sin planes, medición de uso ni baja de datos |

**Madurez global:** piloto funcional o MVP avanzado. No es todavía un SaaS comercializable.

### Fortalezas

- La lógica fiscal está aislada en `src/lib` y tiene 370 tests deterministas. TypeScript en modo strict está limpio.
- La fila A3 es correcta en los puntos delicados: una fila por tipo de IVA, IRPF solo en la primera, recargo por línea, prefijo de país del lado del tercero, y NIF y cuentas como texto. La reexportación compara con el snapshot exportado, no con la fila viva.
- La auditoría usa una cadena SHA-256 por factura y un trigger de PostgreSQL impide UPDATE y DELETE.
- Hay patrones bien hechos que sirven de plantilla para los arreglos: `rejectBatch`, el claim atómico `UPLOADED→ANALYZING`, `assertUploadClientAccess`, `canAccessClient` y el flujo de restablecimiento de contraseña.

### Debilidades

- El servidor no aplica transiciones de estado ni exige total, fecha, número o líneas al validar. Un descuadre también pasa (el bloque de `src/app/dashboard/worker/review/[id]/actions.ts:433-435` está vacío).
- La exportación marca las facturas antes de generar el fichero. No tiene transacción, reserva atómica, re-descarga ni anulación.
- El OCR y el enrutado alteran datos contables en silencio: signo de las rectificativas (F-012), receptor forzado (F-019) y empresa equivocada del grupo (F-021). La detección de duplicados no funciona con NIF que llevan prefijo (F-010).
- El procesado en segundo plano usa `after()` dentro del proceso web, sin cola, y la red de recuperación está rota (F-007, F-029).
- La documentación describe otra arquitectura (Supabase, Vercel) y tests que no existen.

### Riesgos principales

1. **Trabajo contable perdido.** Facturas que constan como «exportadas» y nunca llegaron a A3 (F-001, F-009, F-025).
2. **Pérdida total de datos** por disco, error humano o ransomware (F-003, F-036).
3. **Brecha de datos.** Hay un XSS desde el portal (F-002). En cuanto exista una segunda asesoría, además, los 8 accesos cruzados (F-004, F-005) quedarían al alcance de ese código.
4. **Errores que llegan al 303 sin aviso.** Doble contabilización (F-008, F-015), duplicados no detectados (F-010), signos invertidos (F-012), periodo contable ignorado (F-011).
5. **Exposición legal** por cobrar sin contrato de encargado ni subencargados documentados (F-038, F-037).

### Recuento

| Prioridad | Nº | Verificación adversarial |
|---|---|---|
| 🔴 P0 | 5 | Sí, doble |
| 🟠 P1 | 37 | Sí, doble |
| 🟡 P2 | 82 | No |
| 🟢 P3 | 31 | No |
| **Total** | **155** | |

- De los 42 P0/P1, 37 son HECHO VERIFICADO y 5 RIESGO PROBABLE (F-003, F-023, F-029, F-036, F-037).
- 28 de los 42 están marcados como quick win.
- El abogado del diablo planteó 22 argumentos. En la verificación salieron 11 válidos, 8 riesgos aceptables y 3 falsos positivos.

### Opinión sobre comercializar

No se puede comercializar en el estado actual, pero la distancia es corta. Casi todo lo bloqueante es de esfuerzo XS o S y no obliga a rediseñar nada. Los especialistas estiman dos o tres semanas de trabajo enfocado para cerrar la Fase 0 y lo esencial de la Fase 1 (es una estimación, no una medida). A partir de ahí se pueden aceptar asesorías nuevas como pilotos acompañados.

Lo que no conviene es firmar con un segundo cliente antes de cerrar F-001, F-002, F-003 y el aislamiento (F-004 y F-005). Sería vender un sistema que puede perder en silencio el trabajo del asesor, filtrar datos entre despachos o desaparecer con un disco.

Hay que corregir además una frase de un documento interno: `INFORME_PRODUCTO_v3.md:709` afirma que el aislamiento entre asesorías está «cubierto por tests automatizados». No es cierto, porque ningún test toca la BD, y esa frase no puede llegar a material comercial.

### 🟠 LIMITED PILOT

**Por qué no 🟢 GO ni 🟡 CONDITIONAL GO.** Hay 5 P0 abiertos. Dos se pueden disparar hoy con una sola asesoría:
- F-001 salta con un nombre de cliente que lleve `’`, `–`, `€` o `%`.
- F-002 se explota con un XML subido por cualquier cliente del portal.

Además, no consta ningún backup externo (F-003) ni existe el contrato de encargado que exige el art. 28 RGPD para cobrar (F-038). Varias condiciones dependen todavía de decisiones con el asesor (F-011, F-023). Con esto no se puede comercializar en abierto, ni siquiera condicionado.

**Por qué no 🔴 NO-GO.** El producto funciona en producción con un cliente real, el contenido del Excel es correcto, la lógica fiscal está probada y los bloqueantes son conocidos y baratos. No hay que rehacer nada.

**Qué significa aquí LIMITED PILOT:**
1. MS Assessors sigue. F-002, F-003 y el mínimo de F-001 y F-017 se cierran esta semana, porque ya le afectan.
2. No entra ninguna asesoría nueva hasta cerrar la Fase 0 (sección 20).
3. Después se admiten solo unas pocas asesorías (los especialistas hablaban de 3 a 5), en estas condiciones:
   - el onboarding lo hace el equipo;
   - contrato mensual;
   - contrato de encargado firmado;
   - alcance fiscal explícito: pymes de comercio y servicios en régimen general o recargo, sin ISP emitida ni ventas exentas (F-079);
   - revisión humana de cada factura.
4. Una segunda asesoría solo comparte instancia si están cerrados F-004, F-005, F-006 y F-026. Si no, va en instancia y BD separadas (F-045).
5. El paso a CONDITIONAL GO, es decir, a comercializar en abierto, llega al cerrar la Fase 1.

---

## 2. Top 10 riesgos

Ordenados por peligro real para el negocio, con este criterio: integridad de datos, precisión contable, aislamiento multi-tenant y estabilidad, por ese orden.

| # | Prioridad | Problema | Área | Impacto | Esfuerzo | Evidencia |
|---|---|---|---|---|---|---|
| 1 | 🔴 P0 · HECHO VERIFICADO | **F-001 (+F-017)** La exportación marca las facturas como exportadas antes de generar el Excel, sin transacción ni re-descarga. Un nombre de cliente con `’`, `–`, `€` o `%` hace fallar cada exportación de ese cliente y se lleva sus facturas | Exportación A3 | Crítico | M (mínimo inmediato XS) | `src/app/api/export/route.ts:118-193` (marca), `:207-218` (genera), `src/lib/exportFormats.ts:186` |
| 2 | 🔴 P0 · RIESGO PROBABLE | **F-003** No hay copia fuera del único servidor (BD, PDF originales, dev y builds). El disco llegó al 100 % el 15/09 | Continuidad | Crítico | S | `DEPLOY.md:114`, `DEPLOY.md:44-50`, `docker-entrypoint.sh:8` |
| 3 | 🔴 P0 · HECHO VERIFICADO | **F-002** XSS almacenado: un XML subido por un cliente se sirve inline en el mismo origen con CSP `'unsafe-inline'` | Seguridad | Crítico | XS | `src/lib/fileValidation.ts:41`, `src/app/api/invoices/[id]/raw/route.ts:36-44`, `next.config.ts:10` |
| 4 | 🔴 P0 · HECHO VERIFICADO | **F-004 + F-005** Ocho puntos por los que un ADMIN lee o escribe datos de otra asesoría: los 7 aparcados más «Subir facturas» | Multitenancy | Crítico | S / XS | `src/lib/invoiceAccess.ts:17`, `src/app/dashboard/admin/export/page.tsx:30-35`, `src/app/dashboard/worker/upload/page.tsx:16-21` |
| 5 | 🟠 P1 · HECHO VERIFICADO | **F-008 + F-015** No hay máquina de estados en el servidor. El final del OCR deshace rechazos y divisiones, y se puede validar una factura ya dividida, lo que produce doble contabilización | Integridad de estados | Alto | S | `src/lib/processInvoice.ts:571-631`, `src/app/dashboard/worker/review/[id]/actions.ts:516-518` |
| 6 | 🟠 P1 · HECHO VERIFICADO | **F-009 + F-014 + F-025** Se valida sin total, líneas, fecha ni número. Las líneas de IVA incompletas se descartan en silencio y la exportación no bloquea nada: una factura en USD entra como euros | Validación y exportación | Alto | S | `src/app/dashboard/worker/review/[id]/actions.ts:135`, `:433-435`, `src/lib/exportFormats.ts:467-470`, `src/app/api/export/route.ts:91` |
| 7 | 🟠 P1 · HECHO VERIFICADO | **F-010** La detección de duplicados compara el NIF crudo del OCR con el normalizado. Con `ES`, guiones, puntos o VAT europeo no detecta nada | Duplicados | Alto | S | `src/lib/issueDetector.ts:147-152`, `src/lib/processInvoice.ts:341` |
| 8 | 🟠 P1 · HECHO VERIFICADO | **F-012 + F-019 + F-021** El OCR y el enrutado alteran datos contables sin dejar rastro: signo de las rectificativas, receptor forzado al cliente y empresa equivocada del grupo | OCR / enrutado | Alto | S | `src/lib/rectificative.ts:21`, `:66-85`, `src/lib/processInvoice.ts:347-358`, `src/lib/providerRouting.ts:38-49` |
| 9 | 🟠 P1 · HECHO VERIFICADO | **F-011** El «Periodo contable» no llega al Excel. Una factura tardía se contabiliza en su trimestre original, que a menudo ya está presentado | Periodos / exportación | Alto | S (requiere decisión con el asesor) | `src/app/api/export/route.ts:43-64`, `src/lib/exportFormats.ts:245-258` |
| 10 | 🟠 P1 · HECHO VERIFICADO | **F-007** La recuperación de facturas atascadas no funciona. El cron está documentado como POST (da 405) y, lanzado con GET, deja en «Error OCR · ilegible» lo que rescata | Operación OCR | Alto | S | `src/app/api/cron/retry-stuck/route.ts:14`, `:50`, `prisma/migrations/00000000000000_init/migration.sql:497` |

Fuera del top 10 por no ser un defecto de producto, pero bloqueante para cobrar: **F-038 y F-037**, el marco legal y RGPD.

---

## 3. P0: bloqueantes

### 🔴 F-001 · La exportación a A3 marca las facturas como exportadas antes de generar y entregar el Excel · HECHO VERIFICADO

**Área:** exportación A3, transacciones y auditoría.

**Problema.** `GET /api/export` deja escrito todo el efecto de la exportación antes de generar el fichero, sin transacción: lote, items, puntero `exportBatchId` en cada factura y auditoría. Cualquier fallo posterior deja facturas validadas como exportadas sin haber llegado a A3. La app no ofrece ninguna forma de volver a descargarlas ni de anular el lote.

**Evidencia.**
- `src/app/api/export/route.ts:118` `exportBatch.create`, seguido de `:132` `exportBatchItem.createMany`.
- `src/app/api/export/route.ts:179-182`. Sin `exportBatchId: null`, sin `status` y sin `$transaction`:
  ```ts
  invoice.updateMany({ where: { id: { in: invoiceIds } }, data: { exportBatchId: batch.id } })
  ```
- `:185` `appendAuditLogs` está fuera del `try`. `:207` `suggestFilename` también está fuera. `:209-218` `generateA3Excel` y `new NextResponse(..., { headers: { "Content-Disposition": \`attachment; filename="${filename}"\` } })` sí están dentro.
- `:230-233`. El `catch` lo reconoce: *«el batch quede registrado igualmente (no rebobinamos la BD)»*.
- `src/lib/exportFormats.ts:186` `invoices[0]?.client.name.replace(/\s+/g, "_")`, sin sanear el nombre. `src/app/dashboard/admin/clients/actions.ts:15` solo exige `z.string().min(2)`.
- Reproducido en Node 22.14 con el `NextResponse` del proyecto:
  - «L’Esquirol SCP», «CAFÉ – BAR PEPE SL», «€» y emojis dan `TypeError: Cannot convert argument to a ByteString` dentro del `try`: 500 con las facturas ya marcadas.
  - «100% Natural» da 200, pero `decodeURIComponent` en `src/app/dashboard/admin/export/ExportForm.tsx:126-130` lanza `URIError`, el usuario ve «Error de conexión» y no se descarga nada.
  - Las letras latin-1 (é, ñ, ç) funcionan.
- Timeout. Prisma 7.5 aplica por defecto `timeout 5e3` y `maxWait 2e3`, y `src/lib/prisma.ts:8-15` no los cambia. `src/lib/auditLog.ts:76-121` hace `findFirst` y `create` en secuencia por cada factura, dentro de una única transacción interactiva. `rejectBatch` ya trocea en tandas de 25 por esta misma razón (`src/app/dashboard/worker/batch/actions.ts:235`). El umbral no se ha medido.
- Sin salida:
  - La siguiente exportación filtra `exportBatchId: null` (`route.ts:56`).
  - El historial es de solo lectura (`src/app/dashboard/admin/export/page.tsx:89-136`).
  - `src/lib/errorCodes.ts:70` (ERR-EXPORT-002) dice «Reintenta», pero el reintento da 404 ERR-EXPORT-001.
  - La única vía de vuelta es corregir datos reales en la revisión (`src/app/dashboard/worker/review/[id]/actions.ts:450-484`), y si se deshace la corrección la factura vuelve a quedar asociada al lote.
- Agravantes:
  - Las facturas con total 0 se excluyen del fichero pero se marcan (`src/lib/exportFormats.ts:467-470`, F-009).
  - Dos exportaciones simultáneas sacan las mismas facturas en dos ficheros (F-049).

**Escenario.** Un cliente se llama «L’Estanc del Mar SL», con el apóstrofo pegado desde Word. El admin pulsa «Descargar Excel» y recibe un 500. El lote queda creado y las N facturas validadas quedan marcadas. La vista previa pasa a «0 facturas · N ya exportadas» y el botón se deshabilita. El mes siguiente pasa lo mismo. Si nadie echa en falta esas facturas, su IVA queda fuera del 303. Lo mismo ocurre con una pestaña cerrada o un corte de red durante la descarga.

Nota: el escenario inicial de «exportación trimestral de todos los clientes» no se puede alcanzar desde la UI, porque `ExportForm.tsx:35`, `:62` siempre envían `clientId`.

**Por qué bloquea.** El Excel para A3 es el entregable del producto. Hay al menos un disparador determinista y varios transitorios. Todos acaban igual: trabajo validado que desaparece del circuito y que solo se recupera con SQL a mano en producción.

**Recomendación.**
1. **Mínimo inmediato:**
   - Nombre de fichero ASCII: NFKD, quitar diacríticos y dejar solo `[A-Za-z0-9._-]`, más `filename*=UTF-8''…` (cierra F-017).
   - `appendAuditLogs` en tandas de 25 dentro de un `try`, como hace `rejectBatch`.
   - Cambiar el texto de ERR-EXPORT-002 para que no invite a reintentar.
2. **Completo:**
   - Leer las facturas, generar el buffer y el nombre en memoria y solo después abrir `prisma.$transaction(async tx => …, { timeout: 30_000, maxWait: 5_000 })`.
   - Dentro de la transacción: `ExportBatch`, `ExportBatchItem` y `updateMany({ where: { id: { in }, exportBatchId: null, status: "VALIDATED" } })`, exigiendo `count === invoices.length`; si no coincide, 409.
   - Auditoría en bloque en la misma transacción: cabezas de cadena con una sola consulta (`DISTINCT ON "invoiceId"`) y el **mismo** `computeAuditHash`.
3. No marcar las facturas excluidas del fichero (F-009).
4. «Volver a descargar», regenerando desde `ExportBatchItem.snapshot`, y «Anular lote» auditado.
5. Pasar la descarga a POST (F-071) y revocar el blob con retraso (F-127).
6. Tests de integración con la BD de test (F-033):
   - Un cliente con «’» y un fallo simulado de `generateA3Excel`: tras el 500 no debe quedar ninguna factura marcada.
   - Dos exportaciones concurrentes: solo una debe marcar.

**Impacto:** Crítico. **Esfuerzo:** M (el mínimo inmediato es XS-S). **Riesgo de modificarlo:** medio. Es el único camino a A3. No se debe tocar el formato de `ExportBatchItem.snapshot` ni sus claves, ni `computeAuditHash`, ni `A3_HEADERS`.
**Dependencias:** F-033, para el test de integración. F-048, para la parte de auditoría dentro de la transacción; basta resolverla para la exportación.
**Relacionados:** F-017, F-009, F-049, F-071, F-069, F-018, F-127.

---

### 🔴 F-002 · Un XML subido por un cliente se sirve inline en el mismo origen con una CSP que permite scripts (XSS almacenado) · HECHO VERIFICADO

**Área:** seguridad de ficheros.

**Problema.** Cualquier usuario que pueda subir ficheros, incluido el rol CLIENT, que es un tercero externo, puede subir un `.xml` que en realidad sea XHTML o SVG con `<script>`. La app lo guarda como `application/xml` y lo sirve inline desde su propio origen. La CSP permite scripts inline y conexiones a cualquier host HTTPS. Cuando el gestor o el admin pulsan «Abrir archivo», el script se ejecuta con su sesión.

**Evidencia.**
- `src/lib/fileValidation.ts:41` acepta como XML cualquier fichero que empiece por `<` seguido de un ASCII imprimible:
  ```ts
  if (b[i] === 0x3c && b[i + 1] >= 0x20 && b[i + 1] <= 0x7e) return true;
  ```
- `src/lib/fileValidation.ts:99` hace `case "xml": return "application/xml";`. `src/app/api/uploads/route.ts:38` admite CLIENT, y `:179`, `:191` guardan ese MIME. La resubida del cliente sigue el mismo camino (`src/app/dashboard/client/invoices/reupload-actions.ts:55-85`).
- `src/app/api/invoices/[id]/raw/route.ts:36-44` responde con `"Content-Type": invoice.fileType` y `"Content-Disposition": "inline"`, sin CSP propia. `src/proxy.ts:69` excluye `/api` del matcher.
- `next.config.ts:10` define `"script-src 'self' 'unsafe-inline' 'unsafe-eval'"` y `:14` `"connect-src 'self' https: wss:"`. `:54` los aplica con `source: "/(.*)"`, también a `/api`, como se confirmó con un GET anónimo a dev.
- `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1244-1252` y `src/app/dashboard/admin/invoices/[id]/AdminInvoiceViewer.tsx:32-47`: «Abrir archivo» (target `_blank`, mismo origen) es la **única** forma de ver un XML en la interfaz.
- `src/lib/ocr.ts:476-485`: el parser es permisivo, así que una Facturae válida que lleve dentro `<x:script xmlns:x="http://www.w3.org/1999/xhtml">` se procesa sin error y parece legítima en la cola.
- Simulación con el código real: XHTML, Facturae con script y SVG dan todos `{ok: true, kind: "xml"}`. No se ha ejecutado en navegador. Que se ejecute un script en namespace XHTML dentro de un documento XML es comportamiento estándar de los navegadores.

**Escenario.** Un cliente sube «factura_proveedor.xml». El atacante también puede ser un proveedor que envía ese XML al cliente, y este lo sube de buena fe. El gestor pulsa «Abrir archivo» para ver el contenido. Con la sesión de un ADMIN, el script puede:
- llamar a `GET /api/export` sin `preview`, lo que marca como exportadas todas las facturas VALIDATED de la asesoría (F-001, F-071);
- enviarse el A3 a cualquier dominio HTTPS;
- leer páginas y llamar a server actions.

Con más de una asesoría, puede además usar F-004 para leer PDF de otras asesorías.

**Por qué bloquea.** Un externo ejecuta código con la sesión del personal de la asesoría. Se puede explotar hoy, con una sola asesoría. Es una brecha RGPD y el tipo de hallazgo que cualquier pentest o cuestionario de seguridad de un comprador señala como alto.

**Recomendación.**
1. En `/raw`, lista blanca de lo que se sirve inline: `application/pdf`, `image/jpeg|png|webp`. Todo lo demás, XML incluido, con `application/octet-stream` o `text/plain; charset=utf-8` y `Content-Disposition: attachment`.
2. Añadir `Content-Security-Policy: sandbox; default-src 'none'` a `/raw`, como entrada específica en `headers()` colocada después de la general. Comprobarlo con `curl -I`. Con esto quedan neutralizados también los XML maliciosos que ya estén guardados, sin migrar nada.
3. Mostrar el XML en la UI como texto escapado (`<pre>`), en lugar de abrir `/raw`.
4. Al subir, parsear el XML y exigir que la raíz sea `Facturae`. Rechazar los namespaces XHTML y SVG y `<?xml-stylesheet?>`.
5. En `splitInvoice` (`src/app/dashboard/worker/review/[id]/actions.ts:1038-1049`), aceptar solo JPEG y PNG comprobados por magic bytes. Este vector es interno, de gestor a admin.
6. Restringir `connect-src` a los orígenes que hagan falta.

**Impacto:** Crítico. **Esfuerzo:** XS. **Riesgo de modificarlo:** bajo. Solo cambia cómo se ve un XML: descarga o texto.
**Dependencias:** ninguna.
**Relacionados:** F-095, F-122.

---

### 🔴 F-003 · Sin copia de seguridad externa ni plan de recuperación: BD, PDF originales, dev y builds en un único servidor · RIESGO PROBABLE

**Área:** infraestructura y continuidad.

**Problema.** Los datos de producción (Postgres) y los originales de las facturas (bucket `facturas` de Garage) viven en el mismo host que el entorno de desarrollo y que los builds. No consta ninguna copia fuera de esa máquina. La única copia conocida es un `pg_dump` manual que se hace solo antes de migrar y que se guarda en `/root`, en el mismo disco.

**Evidencia.**
- `DEPLOY.md:114`, dentro de «Pendiente después del primer deploy»: *«Backup offsite del bucket de facturas (Garage).»*
- `DEPLOY.md:10-11` y `:23-26`: la app llega a Postgres y a Garage por la red interna de Docker. Mismo host.
- `DEPLOY.md:44-50`: *«Como la BD **no tiene datos reales**, resetéala… `npx prisma migrate reset --force --skip-seed`»*. Estaba pensado para el primer despliegue, pero nadie lo ha actualizado ahora que producción tiene datos reales.
- `docker-entrypoint.sh:8` `npx prisma migrate deploy` se ejecuta en cada arranque sin copia previa. La migración 8 hace `DROP COLUMN` (`prisma/migrations/00000000000008_recargo_equivalencia_por_linea/migration.sql:23-24`).
- `src/lib/storage.ts:77-112`: `deleteObject` y `deletePrefix` borran sin versionado.
- En `scripts/` no hay ningún script de backup ni de restauración.
- Notas del equipo:
  - Disco al 100 % el 15/09 durante un build, liberado con `docker image prune`.
  - `pg_dump` manual a `/root`.
  - dev y prod en la misma instancia de Coolify.
- `docs/RGPD_REALIDAD_TECNICA.md` (sin commitear) lo admite: *«Backups: no hay ninguno definido»*.
- **No verificable desde el repo:** si Coolify tiene activados los Scheduled Backups de Postgres con destino S3, o si Hetzner Backups está activo.

**Escenario.** Ocurre cualquiera de estas cosas:
- falla el disco;
- el disco se vuelve a llenar durante un build y corrompe Postgres;
- un `docker volume prune` equivocado;
- un ransomware;
- un operador que ante un P3009 sigue `DEPLOY.md` §3.

El resultado es la pérdida total e irrecuperable de las facturas originales y de los datos validados de todas las asesorías.

**Por qué bloquea.** Los documentos tienen un plazo de conservación de 4 a 6 años. El art. 32.1.c RGPD obliga al encargado a poder restaurar la disponibilidad de los datos. Cualquier asesoría que haga due diligence preguntará por las copias, y hoy la respuesta honesta es que no hay ninguna fuera del servidor.

**Recomendación.**
1. **Hoy, en 30 minutos:** comprobar en Coolify y en la consola de Hetzner qué hay activado y dejarlo escrito en `DEPLOY.md`. Activar Hetzner Backups como parche inmediato.
2. Configurar los Scheduled Backups diarios de Postgres con destino S3 externo en la UE, en otro proveedor o región. Retención de 30 diarias y 12 mensuales, y alerta si falla.
3. Sincronizar cada noche el bucket `facturas` a un destino externo con versionado u object lock, para que un borrado o un cifrado no se propague a la copia. Cifrar las copias en origen.
4. Hacer una restauración de prueba en limpio, con BD y una muestra de PDF. Documentarla como runbook con RPO de 24 h y RTO de 4 h, y repetirla cada trimestre.
5. Reescribir `DEPLOY.md` §3: `migrate reset` solo con BD vacía, y dump externo obligatorio antes de cualquier Redeploy que traiga migraciones (F-036).
6. Activar Docker Cleanup y, a medio plazo, sacar dev y los builds de la máquina de producción.

**Impacto:** Crítico. **Esfuerzo:** S. **Riesgo de modificarlo:** bajo.
**Dependencias:** ninguna. Si se confirma que Coolify ya sube Postgres a S3 externo, la parte de la BD baja a P1 (falta la restauración probada). El bucket sigue siendo P0.
**Relacionados:** F-036, F-044, F-032.

---

### 🔴 F-004 · Los 7 accesos conocidos (aparcados) por los que un ADMIN lee y escribe datos de otra asesoría · HECHO VERIFICADO

**Área:** multitenancy y exportación.

**Problema.** El aislamiento entre asesorías depende de que cada consulta lleve su filtro. No hay RLS ni extensión de Prisma que lo imponga. En siete sitios el filtro falta para el rol ADMIN. El usuario aparcó este asunto el 15/09/2026 porque producción solo tiene una asesoría. Sigue siendo bloqueante antes de dar de alta la segunda en la misma instancia.

**Evidencia.**
- `src/lib/invoiceAccess.ts:17` `if (user.role === "ADMIN") return true;`. Lo usan `/api/invoices/[id]/raw` y `/preview`, que sirven PDF ajenos.
- `src/app/api/search/route.ts:37-77`: para ADMIN no hay filtro de asesoría. Devuelve ids, nombres y CIF con `q` de 2 caracteres. Ningún componente de la app la usa.
- `src/app/dashboard/worker/invoices/actions.ts:22` `if (role === "ADMIN") return null;`. Abre `quickRejectDuplicate`, que rechaza y envía el correo al cliente, y `dismissDuplicateIssue`.
- `src/app/dashboard/worker/issues/actions.ts:10` `if (role !== "WORKER") return null;`.
- `src/app/dashboard/admin/closures/actions.ts:22-45` (`closePeriod`, upsert con cualquier `clientId`) y `:60-66` (`reopenPeriod` por `closureId`), ambos sin comprobar la asesoría.
- `src/app/dashboard/admin/export/page.tsx:30-35` hace `prisma.client.findMany({ where: { isUnclassifiedBucket: false } })` y `prisma.exportBatch.count()`/`findMany` sin `where`. `ExportForm.tsx:163` muestra `${c.name} — ${c.cif}`. `prisma/schema.prisma:518-532`: `ExportBatch` no tiene `advisoryFirmId`.
- `src/app/dashboard/admin/invoices/actions.ts:37` `advisoryFirmId ?? undefined` en `reprocessAllOcrErrors`. Solo es explotable con un ADMIN sin asesoría asignada (F-006).
- **Mitigación que existe:** la descarga del Excel sí está acotada por asesoría (`src/app/api/export/route.ts:37-57`). `canAccessClient` (`src/lib/accessibleClients.ts:45-58`) es correcto y ya se usa en otros sitios.

**Escenario.** Con una segunda asesoría dada de alta:
- **Pasivo:** su ADMIN abre «Exportar» y ve nombre y CIF de todos los clientes de MS Assessors (en autónomos, un NIF personal) y su historial de lotes.
- **Activo:**
  1. `GET /api/search?q=20` devuelve ids de facturas ajenas.
  2. `/api/invoices/{id}/raw` descarga el PDF.
  3. `quickRejectDuplicate` rechaza una factura ajena, escribe en la auditoría inmutable y envía un correo al cliente de la otra asesoría.
  4. `closePeriod` bloquea las subidas y validaciones de esa asesoría.
- **Con F-002** el atacante ni siquiera tiene que ser ADMIN: le basta con ser cliente del portal.

**Por qué bloquea.** Es fuga y modificación de datos fiscales y personales entre clientes que pagan: una brecha notificable según el art. 33 RGPD. Hoy no se puede explotar, y deja de ser así el mismo día que se da de alta la segunda asesoría.

**Recomendación.**
1. `canReadInvoice`: para ADMIN, comparar `invoice.client.advisoryFirmId` con el de la sesión. Si no hay asesoría, `false`.
2. Reutilizar `canAccessClient` en lugar de crear helpers nuevos. Añadir solo `canAccessInvoice`, que resuelve el cliente y delega. Aplicarlo en `worker/invoices`, `worker/issues` (para todos los roles), `closePeriod` y `reopenPeriod`.
3. Borrar `/api/search`, que no tiene consumidor. Si se conserva, filtrar por asesoría.
4. `admin/export/page.tsx`: filtrar los clientes por `advisoryFirmId`. Migración nueva con `ExportBatch.advisoryFirmId` NOT NULL, FK e índice, con backfill vía `userId`. El número hay que acordarlo con Zuhir, porque la 10 es suya.
5. Sustituir `?? undefined` por un corte explícito (F-006).
6. Tests con dos asesorías contra la BD de test (F-027).

**Impacto:** Crítico. **Esfuerzo:** S. **Riesgo de modificarlo:** bajo. La semántica de `canAccessClient` es correcta; se trata de aplicarla donde falta.
**Dependencias:** F-033 para los tests. Número de migración acordado con Zuhir. Decisión de despliegue (F-045). El fix #22 en curso solo pagina el historial de exportación. El árbol de trabajo ya filtra el historial, pero no la lista de clientes.
**Relacionados:** F-005, F-006, F-026, F-027, F-087, F-138.

---

### 🔴 F-005 · «Subir facturas» del ADMIN lista clientes (nombre y CIF) de todas las asesorías y preselecciona el primero · HECHO VERIFICADO

**Área:** multitenancy y subida. Es un octavo sitio que **no** está en la lista de aparcados.

**Problema.** En la rama ADMIN, la página de subida consulta los clientes sin filtrar por asesoría y envía la lista entera al navegador.

**Evidencia.**
- `src/app/dashboard/worker/upload/page.tsx:16-21`:
  ```ts
  prisma.client.findMany({ where: { isUnclassifiedBucket: false }, orderBy: { name: "asc" }, select: { id: true, name: true, cif: true } })
  ```
  En el mismo fichero, `:31-38` sí filtra los grupos por asesoría.
- `page.tsx:63` pasa la lista entera a un Client Component, así que queda en el payload RSC aunque no se pinte.
- `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:74` `useState(clients[0]?.id ?? "")`. `:247` pinta `${c.name} (${c.cif})`. `:274-290` ofrece todas las empresas en «Clasificar entre varios».
- Es la entrada del menú y el botón principal del ADMIN (`src/components/layout/Sidebar.tsx:55`, `:121`).
- La escritura sí está protegida: `src/app/api/uploads/route.ts:108-119` y `src/lib/uploadAccess.ts:43-46` responden 403 con ERR-UPLOAD-005 «No tienes acceso a este cliente.».

**Escenario.** Con dos asesorías, el ADMIN de cualquiera de ellas ve la cartera de la otra solo con abrir la pantalla de uso diario. Si el primer cliente por orden alfabético es de la otra asesoría, la subida por defecto falla con un error confuso.

**Por qué bloquea.** Es una fuga pasiva entre tenants que ocurre sin ninguna acción maliciosa, en cuanto haya una segunda asesoría. Además rompe un proceso crítico.

**Recomendación.** Usar `getAccessibleClientIds` (`src/lib/accessibleClients.ts:18-27`), igual que hace `worker/groups/page.tsx:15-20`, o filtrar con `advisoryFirmId: session.user.advisoryFirmId` y devolver `[]` si es null. Nunca usar `?? undefined`. Quitar la preselección es opcional una vez filtrada la lista. Añadir un test con dos asesorías.

**Impacto:** Alto. **Esfuerzo:** XS. **Riesgo de modificarlo:** bajo.
**Dependencias:** ninguna.
**Relacionados:** F-004, F-006, F-110.

---

## 4. P1: alta prioridad

Agrupados por tema. Todos tienen doble verificación adversarial. Si la verificación corrigió la evidencia original, se usa la corregida.

### 4.1 Integridad de estados y concurrencia

#### 🟠 F-008 · El final del OCR sobrescribe sin condición y deshace rechazos, divisiones y validaciones hechos mientras analizaba · HECHO VERIFICADO
**Evidencia:**
- `src/lib/processInvoice.ts:571-631`: `$transaction([deleteMany lines, createMany lines, invoice.update({ where: { id: invoiceId }, data: { status: targetStatus, … } })])`, sin exigir `ANALYZING`. El `catch` (`:651-655`) hace lo mismo con `OCR_ERROR`.
- `parseAndSave` (`src/app/dashboard/worker/review/[id]/actions.ts:152-201`), `rejectInvoice` (`:924-930`) y las divisiones (`:1025-1031`, `:1088-1091`, `:1245-1260`) no rechazan `UPLOADED` ni `ANALYZING`.
- En la UI, `canReject` y `canSplit` no miran el OCR (`ReviewForm.tsx:336-337`), y las flechas de la cola llevan a facturas en análisis (`src/lib/reviewQueue.ts:101`).
- El propio código ya lo sabe: `src/lib/invoiceStatuses.ts:184-190` excluye `UPLOADED`/`ANALYZING` del rechazo en lote porque *«el OCR en curso las devolvería a revisión… sin dejar rastro»*.

**Escenario:**
- Rechazo: el cliente recibe el correo de rechazo y la factura vuelve a «Por revisar».
- División: la original vuelve a la cola junto a sus hijas, y validarla contabiliza dos veces.
- En los dos casos la auditoría registra `oldValue "UPLOADED"` fijo.

**Recomendación:**
- Usar `ocrAttempts` como fencing token.
- Transacción interactiva con `updateMany({ id, status: "ANALYZING", ocrAttempts })`; si `count = 0`, abortar sin tocar las líneas. Aplicarlo también en el `catch`.
- Cron con condición de `ANALYZING` y `updatedAt`.
- Rechazar en servidor guardar, validar, rechazar y dividir en `UPLOADED`/`ANALYZING`, y deshabilitarlos en la UI.

**Impacto** Alto · **Esfuerzo** S · **Riesgo de cambio** bajo-medio: mantener el claim atómico inicial · **Base de** F-056.

#### 🟠 F-015 · Se puede validar una factura dividida o rechazada y volver a dividir una ya dividida · HECHO VERIFICADO
**Evidencia:**
- `src/app/dashboard/worker/review/[id]/actions.ts:516-518` pasa a `VALIDATED` desde cualquier estado.
- Las divisiones solo comprueban `exportBatchItems` (`:1027-1031`, `:1171-1175`) y actualizan sin condición (`:1088-1091`, `:1257-1260`).
- El export no excluye las originales con hijas (`src/app/api/export/route.ts:54-63`).
- En la UI, una `SPLIT_SOURCE` cuenta como pendiente (`ReviewForm.tsx:333`, `:337`).
- Se llega a ella por el buscador, por los enlaces de Auditoría, por URL o con Atrás y recarga.
- Validar una `REJECTED` es intencionado (`ReviewForm.tsx:1316`), pero con Enter y sin confirmación, y no se limpia `rejectionReason`.

**Escenario:** la foto original validada sale en A3 junto a sus hijas, o se redivide y se duplican las hijas.

**Recomendación:**
- Estados de origen permitidos, con `updateMany` y comprobación de `count`.
- Dividir reservando antes la original.
- `SPLIT_SOURCE` y `PENDING_ROUTING` en solo lectura.
- `REJECTED` solo con «Reabrir y validar» explícito.
- Excluir del export las originales que tengan hijas.

**Impacto** Alto · **Esfuerzo** S · **Relacionados** F-008, F-056, F-062.

### 4.2 Validación y exportación contable

#### 🟠 F-009 · Se puede validar sin total, líneas, fecha ni número, y el export marca como exportadas las facturas que excluye del Excel · HECHO VERIFICADO
**Evidencia:**
- En la UI, `hasValues = vatTotals.anyFilled && totalAmount` (`ReviewForm.tsx:715`). Con el total vacío, `mathOk` queda en `null` y no bloquea (`:722`, `:934-955`).
- En el servidor, `actions.ts:325-326` guarda número y fecha nulos sin quejarse, y en `:433-435` está el bloque vacío `if (validate && !isValid && isValid !== null) { // Allow validating with warning but don't block }`.
- `generateA3Excel` descarta `|total| < 0,005` (`src/lib/exportFormats.ts:467-470`), pero `route.ts:118-193` crea lote, item, puntero y auditoría para todas.
- Sin líneas y con total 121 sale una fila 0/0/0 sin aviso (`exportFormats.ts:57-65`).
- Simulado: 2 facturas en el lote, 1 fila en el Excel.

**Mitigación parcial:** la vista previa avisa de «Total = 0» y «Fecha vacía» (`exportFormats.ts:307`, `:367-374`), pero `ExportForm.tsx:358` dice «los avisos no bloquean».

**Recomendación:**
- Al validar, exigir en servidor total, fecha, número, al menos una línea con base distinta de 0 y NIF del tercero (con excepción explícita para simplificadas), devolviendo `{ error }`.
- En el export, calcular el conjunto exportable con la misma función que el generador y marcar solo ese.

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-014 · Una línea de IVA incompleta se descarta en silencio al guardar y la factura se valida descuadrada · HECHO VERIFICADO
**Evidencia:**
- `actions.ts:135` `if (isNaN(taxBase) || isNaN(vatRate) || isNaN(vatAmount)) continue;`. Los totales solo suman las líneas que sobreviven (`:226-227`), y la factura se guarda `VALIDATED` con `isValid=false` (`:507`).
- En el cliente, `vatTotals` suma cada campo que se pueda leer (`ReviewForm.tsx:695-710`). La autocuota no se borra al vaciar el % (`:584-590`).
- Simulado: [100/21/21] + [50/''/5], total 176. El semáforo sale verde y el servidor guarda solo la primera línea.
- También se pierde una línea exenta con solo base [50/''/''].

**Mitigación tardía:** aviso de descuadre en la vista previa del export, sin bloquear.

**Recomendación:**
- Error explícito para líneas parcialmente rellenas.
- Bloqueo en servidor si `isValid === false`.
- Mismo criterio en el semáforo.

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-022 · No se comprueba que cada cuota sea base × %: cuotas cruzadas entre tipos pasan el cuadre, la revisión y el export · HECHO VERIFICADO
**Evidencia:**
- Todas las comprobaciones son sobre el total: `src/lib/exportFormats.ts:394-405`, `actions.ts:385-396`, `ReviewForm.tsx:696-722`, `src/lib/issueDetector.ts:98-123`.
- La cuota va tal cual a la columna L (`exportFormats.ts:268`).
- Solo el parseo de respaldo por texto controla la desviación (`src/lib/ocr.ts:369-371`, 5 %).
- Simulado: 100 al 21 % con cuota 20 y 200 al 10 % con cuota 21 (total 341). `validateForA3Export` devuelve `[]`.

**Por qué importa:** en recibidas el total no cambia, pero el desglose por tipo va mal en el libro registro, en las casillas 01-09 del 303 en emitidas y en el 390.

**Recomendación:**
- `vatLineMismatches(lines)` en `src/lib`, con umbral `|round2(base×%) − cuota| > max(0,02; 0,5 %)` (también para el recargo, excluyendo ISP e intracomunitarias).
- Usarla en `issueDetector`, en `validateForA3Export` y como marca por línea en el formulario.

**Impacto** Alto · **Esfuerzo** XS.

#### 🟠 F-025 · Ningún error bloquea el export: avisos sin severidad recortados a 20 · HECHO VERIFICADO
**Evidencia:**
- `src/app/api/export/route.ts:91` `warnings: allWarnings.slice(0, 20)`, solo en la vista previa. La descarga no llama a `validateForA3Export`.
- `src/lib/exportFormats.ts:276-280`: los avisos no tienen severidad. `:364-366`: la moneda extranjera es solo un aviso.
- `ExportForm.tsx:358` «Se exportan igualmente».
- `attemptValidate` (`ReviewForm.tsx:934-955`) no mira ni moneda, ni fecha, ni número ni NIF.
- Matiz: el descuadre y las cuentas vacías sí se bloquean, pero solo en la UI. El recorte a 20 cuenta facturas con avisos, no avisos sueltos.

**Escenario:** una factura en USD, validada ignorando el banner, entra en A3 como euros.

**Recomendación:**
- Severidad `bloqueante | aviso`.
- Las bloqueantes (moneda distinta de EUR, sin fecha, número o total, sin líneas, sin cuentas, sin NIF) se excluyen del fichero y no se marcan.
- Vista previa ordenada por gravedad y sin recorte ciego.
- Bloquear en servidor la validación en moneda extranjera sin convertir.

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-017 · El nombre del fichero del export sale del cliente sin sanear · HECHO VERIFICADO
**Evidencia:**
- `src/lib/exportFormats.ts:186` solo cambia espacios.
- `src/app/api/export/route.ts:216`, `:226` `filename="${filename}"`.
- `ExportForm.tsx:126-130` `decodeURIComponent` sin `try`.
- Resultados en Node 22.14: `’`, `Ł`, `€` y emojis dan TypeError en el servidor; `%` da URIError en el cliente; `"` o `;` dejan el nombre truncado sin `.xlsx`.
- Por F-001, cada intento marca las facturas y no entrega el fichero.

**Recomendación:**
- Nombre ASCII más `filename*=UTF-8''` (RFC 6266), leído con `try/catch` en el cliente.
- Tests con esos nombres.
- Liberar a mano los lotes ya afectados en producción, con permiso del usuario.

**Impacto** Alto · **Esfuerzo** XS · **Parte del mínimo de** F-001.

#### 🟠 F-018 · Una factura corregida tras exportarse vuelve a salir como una fila normal · HECHO VERIFICADO
**Evidencia:**
- `actions.ts:469-483`: si cambia la huella, el puntero pasa a `null` y queda solo una auditoría `reexport`.
- El export no distingue «nunca exportada» de «corregida» (`route.ts:54-64`), ni en la vista previa (`:85-92`) ni en el fichero (`exportFormats.ts:512-515`).
- `exportFormats.ts:249-251`: A3 no admite dos facturas con el mismo NIF y número.
- **Mitigación:** quien corrige ve un aviso en ámbar (`ReviewForm.tsx:1321-1338`). Pero exporta el ADMIN, a veces días después, y no ve nada.
- La reacción de A3 (rechazo o duplicado) no está verificada.

**Recomendación:**
- En la vista previa, bloque «N facturas corregidas después de exportarse», con el lote anterior y las diferencias respecto al snapshot, y confirmación explícita.
- Recuento global de pendientes de reexportar.
- No añadir hojas al `.xlsx` sin verificar antes cómo se comporta A3.

**Impacto** Alto · **Esfuerzo** M.

#### 🟠 F-011 · El «Periodo contable» de la revisión no llega al export · HECHO VERIFICADO
**Evidencia:**
- `accountingPeriodMonth`/`Year` no aparecen en `src/app/api/export/route.ts`, `src/lib/exportFormats.ts` ni `src/lib/exportFingerprint.ts`. El export filtra por `periodMonth`/`periodYear` (`route.ts:43-64`).
- `buildA3Row` pone la fecha de la factura en A y B (`exportFormats.ts:245-258`), con el comentario *«El gestor puede sobreescribirla en el Excel»*.
- El cierre se comprueba con el valor que envía el formulario (`actions.ts:179-180`), mientras que `closePeriodFromBatch` cuenta por periodo de subida (`src/app/dashboard/worker/batch/actions.ts:66-73`). `PeriodClosure` no tiene `periodType`.
- Hueco: un gestor puede sortear un cierre cambiando el periodo contable.

**Escenario:** una factura de compra de marzo recibida en abril, con periodo contable abril, entra en A3 con fecha de marzo, en un trimestre ya presentado.

**Recomendación:** decidir con el asesor entre dos opciones:
- (a) Que el campo sea efectivo: columna B según la regla acordada, filtro por `COALESCE(accountingPeriod, period)`, huella sin provocar reexportaciones masivas y cierre coherente.
- (b) Eliminar el campo.

En los dos casos, fijarlo con tests.

**Impacto** Alto · **Esfuerzo** S · **Depende de** una sesión con el asesor. El verificador del abogado del diablo lo bajaría a P2; se mantiene P1 porque el control de la pantalla promete algo que no hace.

#### 🟠 F-041 · Exportar es solo del ADMIN y cliente a cliente, sin aviso de facturas sin validar · HECHO VERIFICADO
**Evidencia:**
- `src/app/api/export/route.ts:11-13` devuelve 401 si el rol no es ADMIN.
- `ExportForm.tsx:35-38` arranca con `clients[0]` y el mes en curso, y no lee la URL.
- La vista previa no cuenta las facturas del periodo que siguen en `PENDING_REVIEW`, `NEEDS_ATTENTION` u `OCR_ERROR`.
- Lotes y Cierres no enlazan con Exportar, y `closePeriod` no comprueba nada (`src/app/dashboard/admin/closures/actions.ts:7-49`).
- En trimestral el fichero se llama «…_2026-07…» en lugar de «T3» (`exportFormats.ts:180-190`).
- Matiz: Lotes ya muestra «N Validadas» por lote.

**Recomendación:**
- **P1:** aviso «N sin validar» con confirmación, periodo anterior por defecto, parámetros por URL, botón en Lotes y Cierres, «T3» en el nombre y aviso al cerrar.
- **P2:** bandeja cliente × periodo, ZIP y permiso configurable para gestores.

**Impacto** Alto · **Esfuerzo** M · **Depende de** F-001.

### 4.3 OCR y enrutado que alteran datos contables

#### 🟠 F-013 · La extracción de texto de PDF con pdfjs falla siempre en el servidor · HECHO VERIFICADO
**Evidencia:**
- `src/lib/ocrLlm.ts:29` `GlobalWorkerOptions.workerSrc = ""` pisa el valor por defecto de Node (`node_modules/pdfjs-dist/legacy/build/pdf.mjs:21176-21179`). El getter lanza el error (`:21350-21354`).
- `ocrLlm.ts:79` `catch { return { text: "", items: [] }; }`, sin log.
- El resultado es `PDF_ESCANEADO` y el paso a multimodal (`src/lib/processInvoice.ts:99-105`), que no devuelve `rawText` (`ocrLlm.ts:506-509`).
- Reproducido: con `""` da error; con el valor por defecto se extraen 843 y 1.160 caracteres de dos PDF de demo.
- Quedan desactivados el ruteo por texto, la sugerencia de IRPF y la detección de abono por texto.
- **Mitigación:** el visor recalcula las cajas en el navegador (`src/components/ui/PdfViewer.tsx:140-195`).

**Recomendación:**
- `globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs")` y quitar la línea 29.
- Validarlo con `next build && next start`, porque Next empaqueta `pdfjs-dist`.
- Registrar el error del `catch` y añadir un test con los PDF de `scripts/demo-pdfs`.
- Confirmar en producción con `SELECT source, count(*) FROM "InvoiceExtraction" GROUP BY source`.
- **Arreglar antes F-012** y revisar F-021 y F-073, cuyas heurísticas por texto se reactivarán.

**Impacto** Alto · **Esfuerzo** XS · **Riesgo de cambio** bajo-medio: cambia la vía real de los PDF digitales; conviene comparar 20 o 30 facturas.

#### 🟠 F-012 · Las rectificativas se niegan siempre, y el OCR invierte el signo de facturas ordinarias por una mención en el texto · HECHO VERIFICADO
**Evidencia:**
- `src/lib/rectificative.ts:21` `/rectificativ|nota de credito|factura de abono/` se busca en todo el texto. Da positivo con «no es rectificativa».
- `:66-85` `applyRectificativeSign` no recibe el tipo de rectificativa, así que niega también las rectificativas al alza y las de sustitución (`actions.ts:359-373`).
- `processInvoice.ts:298-301`: `detectIssues` se ejecuta antes de aplicar el signo. `:488-519` niega sin marcar `isRectificative`. Como todo se niega a la vez, cuadra y va a la cola limpia.
- El `min="0"` de los campos no se aplica porque el FormData se construye a mano (`ReviewForm.tsx:827-865`). El texto de ayuda «Detección automática» (`:1734-1737`) es falso.
- **Estado actual:** la vía por texto solo actúa con Document AI, porque con Gemini está dormida por F-013. La negación desde la revisión sí está activa.

**Impacto:**
- Una compra de 121 € con 21 € de IVA pasa a −21 € de IVA soportado: 42 € de desviación.
- El saldo del proveedor sale invertido.

**Recomendación:**
- Con solo el indicio textual, crear la incidencia «Parece rectificativa, revisa el signo» sin tocar signos.
- En la revisión, elegir «Abono / Al alza / Sustitución» y negar solo en abono.
- Auditar las inversiones.
- Avisar si hay negativos sin la casilla marcada.

**Impacto** Alto · **Esfuerzo** S · **Debe ir antes o junto a** F-013.

#### 🟠 F-019 · Se fuerza al cliente como receptor o emisor sin comparar con el NIF leído · HECHO VERIFICADO
**Evidencia:**
- `src/lib/processInvoice.ts:347-358` sustituye los datos. El receptor que leyó el OCR solo queda en `InvoiceExtraction` (`:163-187`).
- Ninguna regla de `src/lib/issueDetector.ts:50-212` compara con `client.cif`.
- En la revisión solo se detecta que emisor y receptor sean iguales (`actions.ts:249-264`). El lado bloqueado son inputs ocultos (`ReviewForm.tsx:1415-1433`).

**Escenario:** una factura al DNI del socio o a otra empresa del grupo se exporta como IVA deducible del cliente.

**Recomendación:**
- Incidencia «Factura a nombre de X (NIF), no del cliente» cuando el NIF leído es válido y distinto.
- Aviso de destinatario no identificado en compras.
- Mostrar lo que leyó el OCR.

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-021 · La regla aprendida de proveedor enruta facturas a la empresa equivocada del grupo · HECHO VERIFICADO
**Evidencia:**
- `src/lib/providerRouting.ts:38-49`: una sola confirmación quita la marca de ambigua y un cambio sobrescribe `clientId`. Simulado A → B → B: la regla queda activa hacia B.
- `src/lib/processInvoice.ts:219-238` la aplica también con `no_match` y `ambiguous` (el caso intragrupo que `src/lib/invoiceRouting.ts:71-78` manda a clasificación manual), y antes del respaldo por texto.
- `:256-257`: no deja rastro. `:347-358` oculta el receptor real.
- Solo se aprende al clasificar a mano (`src/app/dashboard/worker/clasificar/actions.ts:140`), así que la regla no se corrige sola. No hay tests.

**Recomendación:**
- Aplicar la regla solo con `no_cif` o `invalid_cif`, y después del texto.
- Una vez ambigua, que siga ambigua.
- Registrar que se enrutó por regla y mostrar el receptor leído.
- Opción para devolver la factura a «Por clasificar».

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-023 · Intracomunitarias e ISP se exportan al 0 % y el sistema empuja a ponerlas a 0 · RIESGO PROBABLE
**Evidencia:**
- `src/lib/exportFormats.ts:258-259` exporta el tipo y la cuota del documento. `:315-321` avisa de que *«debería ir a 0%»*.
- `src/lib/issueDetector.ts:130-141` crea una incidencia.
- `ReviewForm.tsx:1675-1684` tiene un botón «Poner IVA a 0%».
- `src/lib/ocrLlm.ts:393` descarta las líneas al 0 %.
- En el código no hay nada de autorrepercusión.
- **No verificable sin A3.** Con deducción plena el resultado del 303 no cambia, pero sí las casillas. Solo afecta a clientes con operaciones 3, 4 u 8. En ventas intracomunitarias el 0 % es correcto.

**Recomendación:** importación de prueba en el A3 del piloto con compras 3, 8 y 4, al 0 % y al 21 %. Según el resultado:
- documentarlo, o
- exportar el tipo de autorrepercusión en compras y quitar el aviso y el botón en compras.

**Impacto** Alto · **Esfuerzo** S.

### 4.4 Duplicados, incidencias y trabajo del gestor en la revisión

#### 🟠 F-010 · La detección de duplicados compara el CIF crudo del OCR con el normalizado guardado · HECHO VERIFICADO
**Evidencia:**
- `src/lib/issueDetector.ts:147-152` `issuerCif: extraction.issuerCif`, que solo tiene quitados los espacios (`src/lib/ocrLlm.ts:414`, `src/lib/ocr.ts:285`).
- Lo guardado es `parseTaxId(...).clean`, sin prefijo de país ni separadores (`src/lib/processInvoice.ts:341`, `src/lib/validators.ts:72-74`, `:248-272`).
- Simulado con el `parseTaxId` real: `B-12345678`, `ESB12345678`, `B.12.345.678`, `b12345678`, `DE123456789`, `IE6388047V` y `ESW0184081H` no casan.
- El número se compara literal. No se vuelve a comprobar al validar.
- El «Posible duplicado» del listado admin lee un `duplicate_warning` que nadie escribe (`src/app/dashboard/admin/invoices/page.tsx:100`).
- **Mitigación parcial:** el prompt de Gemini pide los CIF sin guiones, y existe la deduplicación por hash, que solo detecta ficheros idénticos.

**Escenario:** foto más PDF, o un reenvío, de un proveedor europeo: gasto e IVA deducidos dos veces.

**Recomendación:**
- Comparar limpio contra limpio. En emitidas, usar el cliente y `receiverCif`.
- Normalizar el número.
- Repetir la comprobación al validar con confirmación.
- Listado admin sobre `InvoiceIssue`.
- Tests con los casos simulados.

**Impacto** Alto · **Esfuerzo** S. No es «una línea».

#### 🟠 F-016 · La revisión no muestra las incidencias de la factura · HECHO VERIFICADO
**Evidencia:**
- `src/app/dashboard/worker/review/[id]/page.tsx:63-68` carga incidencias (sin filtrar por estado) y `:273` las pasa al formulario, pero `ReviewForm.tsx:220`, `:321` no las usan.
- `actions.ts` no consulta ni cierra incidencias.
- `src/components/layout/Sidebar.tsx:46-48` justifica haber quitado «Incidencias» con un comentario falso.
- «Resolver incidencias (N)» lleva a una revisión que no dice cuál es la incidencia.
- **Mitigación:** la insignia en el listado del gestor (`src/app/dashboard/worker/invoices/page.tsx:289-316`).

**Recomendación:**
- Bloque de incidencias `OPEN` arriba del panel, con enlace a la original y las acciones «No es duplicada» y «Es duplicada».
- Confirmación al validar con un duplicado abierto.
- Cerrarlas al validar (F-057).
- Corregir el comentario.

**Impacto** Alto · **Esfuerzo** S · **Tras** F-010.

#### 🟠 F-047 · Sin protección de cambios sin guardar en la revisión · HECHO VERIFICADO
**Evidencia:**
- Navegan sin comprobar nada:
  - `onNext` y `onPrev` hacen `router.push` (`ReviewForm.tsx:1058-1059`);
  - «Volver», «Siguiente pendiente», «<» y «>» son `Link` (`:1095-1154`);
  - Posponer no envía los campos (`:980-993`);
  - Reprocesar recarga la página (`:1017-1023`).
- `src/hooks/useReviewShortcuts.ts:120-130`: Alt+flechas no miran si el foco está en un input, y en macOS secuestran Option+←/→.
- Búsqueda de `beforeunload`/`isDirty`: 0 resultados.
- **Agravante del commit auditado:** ahora se puede volver a facturas validadas. Una corrección perdida deja valores ya validados que irán a A3.

**Recomendación:**
- `isDirty` y navegación con guarda Guardar / Descartar / Cancelar.
- `beforeunload` como complemento.
- En Windows seguir interceptando Alt+flechas, porque si no el navegador hace Atrás.

**Impacto** Alto · **Esfuerzo** S.

### 4.5 Trazabilidad

#### 🟠 F-024 · La auditoría no registra fecha, cuentas, periodo contable, retención ni países, ni los ajustes automáticos del OCR · HECHO VERIFICADO
**Evidencia:**
- `trackedFields` (`actions.ts:399-405`) omite `invoiceDate`, `supplierAccount`, `expenseAccount`, `accountingPeriod*`, `retentionType`/`Base`, los países, `rectifiedInvoiceSeries`, `art80Tres` e `intracomGoodsSource`, aunque se guardan (`:314-350`).
- `AUDIT_FIELD_LABELS.invoiceDate` existe (`src/lib/invoiceStatuses.ts:113`), pero nunca se escribe.
- `processInvoice` solo audita el estado (`:635-641`), aunque sustituye la parte del cliente, recalcula el IRPF, invierte signos y propone recargo (`:347-357`, `:463-486`, `:502-520`, `:531+`).
- `AccountEntry` cambia sin rastro (`actions.ts:607-635`, `:873`, y las acciones de admin).
- **Atenuante:** la entrada `reexport` y el snapshot, solo en la primera divergencia.

**Recomendación:**
- Completar `trackedFields`, con fechas en formato YYYY-MM-DD y los importes normalizados.
- Entradas `auto:signo`, `auto:recargo`, `auto:irpf` y `auto:parteCliente`.
- `AccountEntryLog` como modelo aparte en una migración nueva, porque `AuditLog.invoiceId` es NOT NULL.
- **Sin tocar `computeAuditHash`.**

**Impacto** Alto · **Esfuerzo** S (lo de `AccountEntry` es M y puede ir después).

### 4.6 Multitenancy, identidad y clientes

#### 🟠 F-006 · El filtro de asesoría falla en abierto (`advisoryFirmId ?? undefined`) y no hay capa central de aislamiento · HECHO VERIFICADO
**Evidencia:**
- Hay 22 apariciones del patrón. Con Prisma 7.5 sin `strictUndefinedChecks`, `undefined` elimina el filtro.
- Fallan en abierto: `src/app/dashboard/admin/page.tsx:52`, `admin/invoices/page.tsx:48`, `admin/audit/page.tsx:43`, `admin/batch/page.tsx:60`, `admin/clients/page.tsx:37`, `admin/closures/page.tsx:23`, `admin/workers/page.tsx:26`, `admin/workers/[id]/page.tsx:28`, `admin/export/page.tsx:55`.
- El caso más grave es una escritura: `admin/invoices/actions.ts:37-86` (`reprocessAllOcrErrors`).
- Otros sitios con el mismo patrón fallan cerrado en la práctica, por ejemplo `admin/clients/[id]/accounts/actions.ts`.
- `User.advisoryFirmId` es opcional con `ON DELETE SET NULL` (`prisma/schema.prisma:174`, `prisma/migrations/00000000000000_init/migration.sql:428`).
- `requireAdminFirm` falla cerrado, pero solo existe en `admin/workers/actions.ts:60-68`.
- **Precondición:** un ADMIN sin asesoría. Hoy no se alcanza desde la app, porque no se borran asesorías y los scripts siempre la asignan.

**Recomendación:**
- `requireFirmSession()` en `src/lib`, empezando por `reprocessAllOcrErrors`.
- Regla ESLint `no-restricted-syntax`.
- Migración nueva con FK `Restrict` y `CHECK (role = 'CLIENT' OR advisoryFirmId IS NOT NULL)`, comprobando antes que en producción no haya nulos.
- A medio plazo, `$extends` o RLS.

**Impacto** Crítico · **Esfuerzo** M.

#### 🟠 F-026 · CIF, email de cliente y usuario son únicos en toda la plataforma · HECHO VERIFICADO
**Evidencia:**
- `prisma/schema.prisma:164-165` (`User.username`/`email`) y `:185`, `:188` (`Client.cif`/`email`) son `@unique` globales.
- `src/app/dashboard/admin/clients/actions.ts:59-62` responde «Ya existe un cliente con ese CIF.».
- No se pueden borrar ni editar clientes.
- `src/lib/unclassifiedClient.ts:13-14` depende de ese unique.
- El login (`src/lib/auth.ts:58`) y la recuperación de contraseña buscan por clave global.

**Escenario:** una empresa que cambia de asesoría no se puede dar de alta en la nueva, y el mensaje le revela que es cliente de otra.

**Recomendación:**
- Migración nueva con `@@unique([advisoryFirmId, cif])` y adaptar el upsert del buzón al mismo tiempo.
- Comprobación previa dentro de la asesoría y mensajes neutros.
- Decidir si el login es global o por asesoría.
- **Antes de la segunda asesoría.**

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-027 · No hay tests ni defensa estructural del aislamiento: 0 tests sobre 50 puntos de entrada · HECHO VERIFICADO
**Evidencia:**
- `vitest.config.ts:8` solo incluye `tests/unit`. Buscar «firm» en `tests/` da 0 resultados.
- Hay 40 acciones y 10 handlers HTTP sin tests de permisos.
- `src/lib/prisma.ts:8-15` no tiene `$extends` y no hay RLS.
- AGENTS.md reconoce que el linter no lo detecta.

**Recomendación:**
- `tests/integration/tenant-matrix` con dos asesorías sobre toda acción o ruta que reciba un id. Los fallos conocidos, como `it.fails`.
- Un test que falle si aparece un `actions.ts` o `route.ts` que no esté en la matriz.

**Impacto** Alto · **Esfuerzo** M · **Depende de** F-033.

#### 🟠 F-028 · No se puede desactivar a un usuario ni revocar sus sesiones · HECHO VERIFICADO
**Evidencia:**
- `User` no tiene `disabledAt` (`prisma/schema.prisma:161-180`).
- `deleteWorker` falla en cuanto hay auditoría, por la FK `RESTRICT` (`src/app/dashboard/admin/workers/actions.ts:117-138`).
- La sesión es JWT y el comentario «8h absolute» es falso: `@auth/core` la vuelve a firmar en cada lectura (`src/lib/auth.ts:22-26`), y los callbacks no consultan la BD (`:31-38`).
- Cambiar la contraseña no invalida las sesiones.
- El admin no puede cambiar la contraseña de otro usuario ni crear otro ADMIN.
- **Atenuante:** desasignar los clientes corta el acceso a los datos, porque los permisos del gestor se consultan en vivo. Queda el acceso con login y `deleteGroup`, que solo comprueba la asesoría.

**Recomendación:**
- `disabledAt` y `sessionVersion` en una migración nueva, comprobados en `authorize` y en el callback `jwt`.
- «Dar de baja» sin borrar el usuario.
- Restablecimiento de contraseña por el admin.

**Impacto** Alto · **Esfuerzo** M.

#### 🟠 F-046 · No se puede editar un cliente ni darle o reenviarle el acceso al portal (conocido, aparcado) · HECHO VERIFICADO
**Evidencia:**
- La ficha es de solo lectura (`src/app/dashboard/admin/clients/[id]/page.tsx:52-107`). Solo existe `createClient` (`actions.ts:65-167`).
- No hay reenvío de la invitación de 72 h.
- **Mitigación:** autoservicio «Solicitar nuevo enlace». Pero falla con emails escritos con mayúsculas, porque `forgotPassword` pasa el email a minúsculas y `createClient` no.

**Recomendación:**
- «Editar cliente» auditado, avisando si hay facturas exportadas con el CIF anterior.
- «Dar acceso / Reenviar invitación».
- Normalizar el email.

**Impacto** Alto · **Esfuerzo** M · **Depende de** F-039.

### 4.7 Procesado en segundo plano, rendimiento y operación

#### 🟠 F-007 · La recuperación de facturas atascadas no funciona · HECHO VERIFICADO
**Evidencia:**
- `src/app/api/cron/retry-stuck/route.ts:14` y `src/app/api/cron/closure-reminders/route.ts:18` solo exportan GET. `DEPLOY.md:78-87` los documenta como POST, lo que da 405.
- Con GET, `route.ts:50` hace `processInvoice(invoice.id, "system")`. Ese usuario no existe y viola `AuditLog_userId_fkey` (`prisma/migrations/00000000000000_init/migration.sql:497`) después de haber guardado el OCR.
- El `catch` (`src/lib/processInvoice.ts:642-656`) lo clasifica como ERR-OCR-002 «ilegible… Revísala manualmente» (`:667`).
- `ANALYZING` no se puede reprocesar (`src/app/api/invoices/[id]/process/route.ts:12`), bloquea el cierre (`src/lib/invoiceStatuses.ts:175-177`) y hace que el banner refresque sin fin.
- El OCR va en `after()` y el contenedor arranca con `exec npx next start` (`docker-entrypoint.sh:11`).
- Matiz: hay una salida manual, que es rechazar y volver a subir, insegura mientras el OCR siga vivo.

**Escenario:** un Redeploy con 20 facturas en análisis. Si el cron llama con POST, se quedan atascadas para siempre. Si llama con GET, acaban en «Error OCR · ilegible» y se vuelve a pagar Gemini.

**Recomendación:**
- Actor real, `Document.uploadedBy`, o no auditar como «system».
- Sacar historial y auditoría del `try` del OCR.
- Exportar GET y POST y corregir la documentación.
- Reinicio condicional con historial.
- Permitir reprocesar `ANALYZING` con más de 5-10 minutos.
- `exec node node_modules/next/dist/bin/next start` y un periodo de gracia de al menos 120 s.

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-029 · El OCR no tiene cola ni límite de concurrencia · RIESGO PROBABLE
**Evidencia:**
- Cada subida lanza su propio `after(processInvoice)` (`src/app/api/uploads/route.ts:205-209`). El navegador sube 3 a la vez sin tope de ficheros.
- Los reintentos esperan 1,2 y 2,4 s, sin jitter ni `Retry-After` (`src/lib/processInvoice.ts:87`, `:129`).
- Con `GEMINI_API_KEY` no hay failover a Document AI (`:98-109`), aunque README lo llame «fallback».
- El cron no reintenta `OCR_ERROR`.
- Correcciones de la verificación: Next espera a los `after()` al recibir SIGTERM, pero `npx` es PID 1 y el periodo de gracia es corto. El pool de BD no se retiene durante el OCR. La saturación no se ha medido.

**Recomendación:**
- **Corto plazo:** semáforo global de 4 a 6 alrededor de la llamada al proveedor, backoff con jitter y `Retry-After`, y reintento de los errores transitorios.
- **Medio plazo:** cola en Postgres con `FOR UPDATE SKIP LOCKED`, reparto por asesoría y «Reprocesar errores del lote» para el gestor.

**Impacto** Alto · **Esfuerzo** M.

#### 🟠 F-030 · Lotes y paneles cargan todo el histórico en cada visita; por encima de 65.535 facturas Lotes falla · HECHO VERIFICADO
**Evidencia:**
- `src/app/dashboard/worker/batch/page.tsx:109-127` y `src/app/dashboard/admin/batch/page.tsx:94-112` hacen `findMany` sin `take` ni año por defecto, con `include` completo, y filtran en memoria.
- `src/app/dashboard/worker/page.tsx:81-94` y `src/app/dashboard/admin/page.tsx:85-91` hacen lo mismo en los paneles.
- `AutoRefresh` refresca cada 5 s (`src/components/ui/AutoRefresh.tsx:23-27`).
- La consulta de `exportBatchItems` no se trocea: con 70.000 facturas lleva 70.001 parámetros, y `pg-protocol` admite 65.535 (`node_modules/pg-protocol/dist/serializer.js:95`).
- Coste solo del JS de Prisma, que es una cota inferior: 0,75 s y 135 MB con 10.000; 1,46 s y 323 MB con 30.000; 3,7 s y 806 MB con 70.000.
- Una factura atascada en `ANALYZED` mantiene el refresco activo sin fin.

**Recomendación:**
- **Inmediato:** año o periodos abiertos por defecto, `select` mínimo y sin `include` de `exportBatchItems`.
- **Después:** `groupBy` y `COUNT FILTER` en BD, y refresco con back-off.
- Test de paridad con `reviewQueue`.

**Impacto** Alto · **Esfuerzo** M.

#### 🟠 F-034 · No hay seguimiento de errores, alertas ni health check real · HECHO VERIFICADO
**Evidencia:**
- No existen `instrumentation.ts`, `/api/health`, `HEALTHCHECK` en el Dockerfile ni SDK de errores.
- `DEPLOY.md:12` propone `/login` como health check, pero solo lee el JWT (`src/app/login/page.tsx:8`, `src/lib/auth.ts:22-26`), así que da 200 con Postgres o Garage caídos.
- Hay 19 `console.*` sueltos.
- Agravantes: los errores de Resend no se registran (F-039) y los crons están documentados con el método equivocado (F-007).
- Matiz: `OCR_ERROR` sí se ve dentro de la app, pero el operador no recibe ninguna señal.

**Recomendación:**
- `instrumentation.ts` con `onRequestError` hacia GlitchTip, Sentry o un webhook.
- `/api/health` con `SELECT 1` y `HeadBucket`.
- Monitor externo.
- Alertas por `OCR_ERROR` por hora, facturas atascadas más de 15 min, fallos de correo y disco por encima del 80 %.

**Impacto** Alto · **Esfuerzo** S.

### 4.8 Proceso de desarrollo y despliegue

#### 🟠 F-032 · No hay CI ni barrera antes de desplegar · HECHO VERIFICADO
**Evidencia:**
- No existe `.github`. El Dockerfile construye sin tests (`Dockerfile:26`). Las migraciones se aplican al arrancar (`docker-entrypoint.sh:5-8`) y el Redeploy es manual.
- eslint da 54 problemas en `src` (45 errores).
- El E2E busca una etiqueta «email» que ya no existe (`tests/e2e/smoke.spec.ts:24`, `:30` frente a `src/app/login/LoginForm.tsx:22`).
- El script `clear-invoices` apunta a un fichero ignorado.
- Matiz: `next build` sí comprueba tipos, y el entorno dev hace de staging manual.

**Recomendación:**
- **Hoy:** `RUN npx vitest run` en el builder.
- **Después:** pipeline con vitest, eslint con baseline, `migrate deploy` sobre BD vacía, health check real e imagen construida fuera de producción.

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-033 · No existe infraestructura de tests de integración con BD real · HECHO VERIFICADO
**Evidencia:**
- Ningún test importa Prisma. No hay `.env.test`, `TEST_DATABASE_URL` ni factorías.
- Los 12 módulos de `src/lib` con consultas no tienen tests.
- `ARCHITECTURE.md:249-252` afirma que existen tests de `auditLog` y `reviewQueue` y un E2E de subir, validar y exportar. No existen.

**Recomendación:**
- `tests/integration` con `globalSetup` que aborte si la BD no es local o `_test`.
- `migrate deploy` y `TRUNCATE … CASCADE`. Cuidado con el trigger de auditoría: usar el bypass `SET LOCAL` solo en la BD de test.
- Factorías de dos asesorías.
- Mocks solo de lo externo: auth, `next/cache`, `after`, storage, OCR y correo.

**Impacto** Alto · **Esfuerzo** M · **Prerrequisito de** F-001 (test), F-027 y F-104.

#### 🟠 F-036 · Migraciones automáticas al arrancar, sin copia previa ni despliegue en dos fases · RIESGO PROBABLE
**Evidencia:**
- `docker-entrypoint.sh:8`, y `DEPLOY.md:33-35` dice *«No hay pasos manuales»*.
- `DEPLOY.md:44-50` recomienda `migrate reset --force`.
- La 8 hace `DROP COLUMN` y la 9 mueve datos sin vuelta atrás.
- `ARCHITECTURE.md:178`, `:188`, `:194` y `src/lib/auditLog.ts:15` citan migraciones que ya no existen.
- Correcciones de la verificación:
  - Una migración que falla es atómica y `set -e` impide que la app arranque.
  - El riesgo real es una migración con lógica equivocada.
  - El hueco en la numeración (no hay 6) es inocuo.
  - La 9 ya está aplicada en producción (20/09).

**Recomendación:**
- `pg_dump` automático fuera del servidor antes de cada Redeploy que traiga migraciones.
- Expand/contract para las destructivas.
- Health check activado en Coolify.
- `migrate diff` en CI.
- Actualizar las referencias.

**Impacto** Alto · **Esfuerzo** S.

### 4.9 Correo transaccional

#### 🟠 F-039 · Los fallos de envío de correo son invisibles · HECHO VERIFICADO
**Evidencia:**
- `src/lib/email.ts:30-34` descarta lo que devuelve `resend.emails.send`. Resend 6.9.4 no lanza excepción ni con errores 4xx/5xx ni con fallos de red: devuelve `{ data: null, error }` (`node_modules/resend/dist/index.mjs:885-939`).
- `forgotPassword` responde éxito siempre.
- La invitación va en `after()` sin resultado.
- Según el equipo, el correo aún no está montado en producción.

**Recomendación:**
- `const { error } = await …`, con log de la plantilla y el destinatario enmascarado, y `ok:false` en los envíos críticos.
- Verificar el dominio (SPF, DKIM, DMARC) y `EMAIL_FROM`, que por defecto es `facturocr.com`.

**Impacto** Alto · **Esfuerzo** XS · **Antes de activar el correo, resolver** F-040.

#### 🟠 F-040 · Un correo por fichero subido y por factura validada, sin resumen ni límite de ritmo · HECHO VERIFICADO
**Evidencia:**
- `src/app/api/uploads/route.ts:212-234` envía `count: 1` por cada fichero y por cada gestor, en serie (`src/lib/email.ts:419-434`).
- Cada primera validación avisa al cliente (`actions.ts:712-729`).
- No hay preferencias (`src/app/dashboard/admin/settings/SettingsForm.tsx:56-59`).
- Simulación: unos 3.100 correos al mes por asesoría con 150 clientes, y unos 314.000 con 100 asesorías. Es una estimación.
- Un 429 de Resend se pierde sin rastro (F-039) y puede arrastrar correos críticos (reset, invitación).

**Recomendación:**
- Un aviso por lote de subida.
- Resumen al cliente al cerrar el lote, dejando inmediato solo el rechazo.
- Interruptor por asesoría.
- Limitador y prioridad para los correos críticos.

**Impacto** Alto · **Esfuerzo** S.

### 4.10 Legal, RGPD y modelo comercial

#### 🟠 F-038 · Textos legales insuficientes y detrás del login · HECHO VERIFICADO
**Evidencia:**
- `src/app/legal/page.tsx:16-59` no identifica al titular (art. 10 LSSI).
- `src/proxy.ts:31-44`, `:68-70`: un GET anónimo recibe un 307 hacia `/login`.
- El login y el pie de los correos no enlazan nada legal.
- No hay privacidad, condiciones ni registro de aceptación en el esquema.
- Matiz: solo hay cookies técnicas, así que no hace falta banner.
- La base técnica para el DPA está en `docs/RGPD_REALIDAD_TECNICA.md` (sin commitear).

**Recomendación:**
- Con un abogado: condiciones, contrato de encargado con anexo de subencargados (Hetzner, Google, Resend) y política de privacidad.
- `/legal` y `/privacidad` públicas y enlazadas.
- Registrar la aceptación del ADMIN.

**Impacto** Alto · **Esfuerzo** S (sobre todo documental) · **Bloqueante para cobrar.**

#### 🟠 F-037 · Las facturas se envían a la API de Gemini sin región garantizada ni condiciones documentadas · RIESGO PROBABLE
**Evidencia:**
- `src/lib/ocrLlm.ts:326` usa `generativelanguage.googleapis.com/…:generateContent?key=${apiKey}`, un endpoint global de AI Studio con la clave en la query string.
- Document AI en `eu` solo se usa si no hay clave (`src/lib/ocr.ts:388-398`, `src/lib/processInvoice.ts:98-119`).
- Correcciones de la verificación:
  - Con un PDF digital solo se envía el texto extraído (`ocrLlm.ts:470-478`). El fichero completo va solo con escaneados e imágenes (`:493-502`).
  - Según los términos de Gemini, en el EEE las condiciones de pago se aplican también a la cuota gratuita, pero los datos *«may be stored transiently or cached in any country»*.
  - No se ha verificado si la clave tiene la facturación activa.

**Recomendación:**
- Verificar y documentar el nivel de pago.
- Valorar Vertex AI en región UE; la cuenta de servicio ya existe.
- Incluir a Google como subencargado.
- Clave en la cabecera `x-goog-api-key`.

**Impacto** Alto · **Esfuerzo** S.

#### 🟠 F-043 · Sin planes, límites, medición de uso ni suspensión por asesoría · HECHO VERIFICADO
**Evidencia:**
- `AdvisoryFirm` solo tiene nombre, CIF y logo (`prisma/schema.prisma:144-159`).
- El rate limit solo cubre login y reset (`src/lib/rateLimit.ts:63-64`).
- Las subidas (también del CLIENT) y el reproceso manual (`src/app/api/invoices/[id]/process/route.ts:12`) no tienen límite.
- Corrección: existen `ocrAttempts` e `InvoiceExtraction`, que dan datos de uso parciales, pero no registran fallos, reintentos internos ni tokens.

**Recomendación:**
- Informe mensual por asesoría con los datos que ya existen.
- `AdvisoryFirm.status` comprobado en el login y en `/api/uploads` y `/process`.
- Registro de uso de OCR con tokens.
- Después, planes, cuota blanda y rate limit.

**Impacto** Alto · **Esfuerzo** M.

#### 🟠 F-044 · No se pueden exportar ni borrar los datos de un cliente o de una asesoría · HECHO VERIFICADO
**Evidencia:**
- Fuera de `demoSeed` no hay ningún `delete` de `Client`, `Invoice`, `Document` ni `AdvisoryFirm`.
- Las FK son `Restrict` (`prisma/schema.prisma:508`, `:537`, `:539`, `:549`, `:577`) y hay trigger de inmutabilidad.
- El export solo da el A3 de validadas no exportadas (`src/app/api/export/route.ts:20`, `:53-62`).
- No hay purga: `rawResponse` sin límite y tokens caducados que no se borran.
- Matiz: hay que respetar la conservación legal de las validadas (4 años por la LGT y 6 por el Código de Comercio).

**Recomendación:**
- Borrado de documentos no validados con un rastro mínimo, seudonimizando en lugar de romper la cadena.
- ZIP completo por cliente o asesoría (PDF, datos y auditoría).
- Procedimiento de baja con acta.
- Política de retención.

**Impacto** Alto · **Esfuerzo** M.

---

## 5. Quick Wins

Alto impacto y esfuerzo XS o S, ordenados por prioridad. Quedan fuera los que ya están en curso (F-119, F-140, F-147, F-153).

| Hallazgo | Prioridad | Qué hacer | Esfuerzo | Impacto |
|---|---|---|---|---|
| F-002 | 🔴 P0 | `/raw`: inline solo para PDF e imágenes; el resto como `attachment` más `CSP: sandbox` | XS | Crítico |
| F-001 (mínimo) + F-017 | 🔴 P0 / 🟠 P1 | Nombre de fichero ASCII más `filename*`, auditoría en tandas de 25 dentro de `try` y texto de ERR-EXPORT-002 | XS–S | Crítico |
| F-005 | 🔴 P0 | `getAccessibleClientIds` en «Subir facturas» | XS | Alto |
| F-003 | 🔴 P0 | Hetzner Backups, backup de Postgres a S3 externo, sync versionado del bucket y restauración probada | S | Crítico |
| F-004 | 🔴 P0 | `canAccessClient` en los 7 sitios, borrar `/api/search`, filtrar `export/page` | S | Crítico |
| F-013 | 🟠 P1 | Worker de pdfjs en el mismo hilo, log del `catch`, test (después de F-012) | XS | Alto |
| F-022 | 🟠 P1 | `vatLineMismatches` (base × % frente a cuota) en detector, export y formulario | XS | Alto |
| F-039 | 🟠 P1 | Leer `{ error }` de Resend y registrarlo | XS | Alto |
| F-007 | 🟠 P1 | Crons GET/POST, actor real, auditoría fuera del `try`, reprocesar `ANALYZING` > 10 min | S | Alto |
| F-008 | 🟠 P1 | Escritura final del OCR con `updateMany` condicionado (fencing con `ocrAttempts`) | S | Alto |
| F-009 | 🟠 P1 | Exigir en servidor total, fecha, número, líneas y NIF al validar; no marcar las excluidas | S | Alto |
| F-010 | 🟠 P1 | Normalizar NIF y número en `detectIssues` y repetir la comprobación al validar | S | Alto |
| F-012 | 🟠 P1 | No invertir el signo por texto; Abono / Al alza / Sustitución explícito | S | Alto |
| F-014 | 🟠 P1 | Error en líneas incompletas y bloqueo en servidor del descuadre | S | Alto |
| F-015 | 🟠 P1 | Estados de origen permitidos; `SPLIT_SOURCE` en solo lectura | S | Alto |
| F-016 | 🟠 P1 | Bloque de incidencias en la revisión y confirmación con duplicado abierto | S | Alto |
| F-019 | 🟠 P1 | Incidencia «Factura a nombre de otro» | S | Alto |
| F-021 | 🟠 P1 | Regla de proveedor solo con `no_cif`/`invalid_cif`, después del texto, con rastro | S | Alto |
| F-024 | 🟠 P1 | Completar `trackedFields` y entradas `auto:*` (sin tocar el hash) | S | Alto |
| F-025 | 🟠 P1 | Severidad en los avisos; bloquear moneda extranjera y fecha vacía | S | Alto |
| F-032 | 🟠 P1 | `RUN npx vitest run` en el Dockerfile y arreglar el smoke E2E | S | Alto |
| F-034 | 🟠 P1 | `/api/health`, `onRequestError`, monitor externo | S | Alto |
| F-036 | 🟠 P1 | `pg_dump` externo antes de Redeploy con migraciones y runbook | S | Alto |
| F-038 | 🟠 P1 | `/legal` y `/privacidad` públicas con datos LSSI (los textos, con abogado) | S | Alto |
| F-040 | 🟠 P1 | Un aviso por lote y resumen al cliente antes de activar Resend | S | Alto |
| F-047 | 🟠 P1 | `isDirty` con confirmación en toda navegación de la revisión | S | Alto |
| F-020 | 🟡 P2 | Ejecutar siempre `detectInvoiceType` y rellenar con lo extraído al cambiar el tipo | S | Alto |
| F-031 | 🟡 P2 | Migración nueva con los índices de FK y de consultas frecuentes | S | Alto |
| F-035 | 🟡 P2 | `invoiceId` en los logs de OCR y `OcrError` estructurado con código de configuración o cuota | S | Alto |
| F-042 | 🟡 P2 | Script de alta transaccional, sin valores por defecto y sin `Demo1234!` | S | Alto |
| F-045 | 🟡 P2 | Decidir el modelo de despliegue (instancia compartida o por asesoría) | S | Alto |
| F-050 | 🟡 P2 | `@@unique([invoiceId, position])` y `updateMany` con `updatedAt` esperado | S | Alto |
| F-052 | 🟡 P2 | Medir la confianza real de Gemini; no sacar campos del Tab | S | Alto |
| F-053 | 🟡 P2 | Enlace «Abrir en revisión» y panel de diagnóstico en la ficha del admin | S | Alto |

**Segundo nivel (impacto medio, esfuerzo XS):**
- F-057: cerrar incidencias al validar, rechazar o reprocesar.
- F-060: conservar las líneas al 0 %.
- F-068: guardar la respuesta de Gemini.
- F-071: export por POST con parámetros obligatorios.
- F-075: sin sufijo `_R` en el número.
- F-076: CIF con control «J».
- F-080: pool y timeouts de BD.
- F-081: prefetch y refrescos con la pestaña oculta.
- F-082: cachear la ETA.
- F-084: `groupBy` en Auditoría.
- F-087: «Reprocesar todas» troceado.
- F-090: `xlsx` con CVE.
- F-096: `npm audit`.
- F-099: registrar las subidas rechazadas.
- F-107: toast y foco en cuentas vacías.
- F-109: `periodLabel` en todos los listados.
- F-110: confirmación al cerrar y reabrir.
- F-113: etiquetas legibles en Auditoría.
- F-116: errores del visor PDF en español.
- F-121: enlace de soporte.
- F-123: deduplicar el recordatorio de cierre.

---

## 6. UX / UI Audit

> **Alcance.** Se han leído en código todas las pantallas de `src/app/**` y los componentes de `src/components/**` del commit 9d4b10f. El contraste se ha calculado con la paleta OKLCH de Tailwind v4 y la accesibilidad con `eslint-plugin-jsx-a11y`, en una configuración temporal fuera del repo. Las capturas de `docs/screenshots*` están desfasadas (F-138) y solo se han usado como referencia. **Los hallazgos P2 y P3 de este documento no han pasado la verificación adversarial**; los P0 y P1 sí.

### 6.1 ¿Una gestoría pagaría por esto o todavía parece una herramienta interna?

**Hoy es las dos cosas.** La pantalla de revisión (`src/app/dashboard/worker/review/[id]/ReviewForm.tsx`) ya tiene aspecto de producto profesional y especializado. Tiene visor con resaltado del campo, copia del PDF al campo, avisos fiscales precisos (intracomunitaria, ISP, recargo, rectificativa, moneda), semáforo de cuadre con la diferencia exacta, atajos con ayuda y «X de N» con precarga.

**Lo que rodea a la revisión sigue siendo de piloto:**
- el alta de una asesoría es manual y uno a uno (F-054, F-042);
- no se puede editar un cliente (F-046);
- gestores y clientes no tienen «Mi cuenta» (F-101);
- se exporta cliente a cliente y no se puede volver a descargar (F-041, F-001);
- los paneles muestran contadores históricos a los que no se puede entrar (F-118);
- la accesibilidad está por debajo de AA (F-111, F-112);
- el portal no funciona bien en el móvil (F-114);
- la Auditoría muestra texto técnico (F-113).

Dentro de la propia revisión fallan dos cosas básicas: **las incidencias no se ven** (F-016) y **no se avisa de cambios sin guardar** (F-047). Además, la subida del ADMIN **expone clientes de otras asesorías** (F-005).

**Veredicto:**
- **Se puede cobrar** al piloto y a una gestoría pequeña si el onboarding lo hace el equipo.
- **No está listo** para autoservicio ni para 10-100 asesorías.
- Unos 10 arreglos XS/S cambian la percepción en 1-2 semanas.
- Lo que separa de verdad una herramienta interna de un SaaS son dos bloques M/L: el alta masiva (F-054/F-046) y la exportación masiva con red de seguridad (F-041 sobre F-001).

### 6.2 Hallazgos

| ID | Prio | Evidencia | Pantalla | Problema | Ruta |
|---|---|---|---|---|---|
| F-005 | 🔴 P0 | HECHO VERIFICADO | Subir facturas (ADMIN) | Lista nombre y CIF de los clientes de **todas** las asesorías y preselecciona el primero. Es el 8.º sitio de fuga y no estaba entre los aparcados | `src/app/dashboard/worker/upload/page.tsx:16-21` |
| F-016 | 🟠 P1 | HECHO VERIFICADO | Revisión | Se reciben `issues` pero no se pintan. Un posible duplicado se valida a ciegas | `ReviewForm.tsx:220,321` |
| F-047 | 🟠 P1 | HECHO VERIFICADO | Revisión | No avisa de cambios sin guardar. Flechas, Volver, Posponer y Option+←/→ (macOS) descartan lo tecleado, también al corregir una validada | `ReviewForm.tsx:1058-1059,1131-1154`; `useReviewShortcuts.ts:120-130` |
| F-046 | 🟠 P1 | HECHO VERIFICADO | Clientes | No se puede editar un cliente ni darle acceso al portal (conocido, aparcado) | `admin/clients/actions.ts:65-167` |
| F-041 | 🟠 P1 | HECHO VERIFICADO | Exportar | Solo ADMIN, cliente a cliente, sin aviso de «N sin validar» y sin enlace desde Lotes | `api/export/route.ts:11-13` |
| F-030 | 🟠 P1 | HECHO VERIFICADO | Lotes / paneles | Cargan todo el histórico. Lotes se refresca cada 5 s | `worker/batch/page.tsx:109-127` |
| F-038 | 🟠 P1 | HECHO VERIFICADO | Legal | `/legal` está tras el login, sin datos del titular, y el login no enlaza nada legal | `src/proxy.ts:40-44` |
| F-052 | 🟡 P2 | RIESGO PROBABLE | Revisión | Los campos «seguros» según la confianza que se autoasigna Gemini salen apagados y fuera del Tab | `SmartField.tsx:367-396` |
| F-107 | 🟡 P2 | HECHO VERIFICADO | Revisión | Validar con cuentas vacías solo hace temblar los campos | `ReviewForm.tsx:950-953` |
| F-116 | 🟡 P2 | HECHO VERIFICADO | Visor | react-pdf en inglés, spinner infinito y sin «Reintentar» | `PdfViewer.tsx:344-366` |
| F-119 | 🟡 P2 | HECHO VERIFICADO | Revisión | Los toasts tapan la navegación (**en curso**) | `Toast.tsx:124-127` |
| F-053 | 🟡 P2 | HECHO VERIFICADO | Facturas (admin) | «Ver» lleva a una ficha sin «Revisar» ni diagnóstico | `admin/invoices/[id]/page.tsx:35-115` |
| F-054 | 🟡 P2 | HECHO VERIFICADO | Onboarding | Clientes, plan de cuentas y asignaciones uno a uno, sin checklist | `ClientForm.tsx`, `AssignmentsPanel.tsx:27-48` |
| F-101 | 🟡 P2 | HECHO VERIFICADO | Cuentas | Sin «Mi cuenta». El admin fija la contraseña del gestor. El login dice «Usuario» cuando es el email | `settings/actions.ts:111-113` |
| F-108 | 🟡 P2 | HECHO VERIFICADO | Subida | Por defecto el mes en curso y «Mensual». La periodicidad se elige en cada subida | `UploadForm.tsx:53-56` |
| F-109 | 🟡 P2 | HECHO VERIFICADO | Transversal | El periodo se escribe de tres formas y los trimestrales salen como mes | `InvoicesTable.tsx:182`; `lib/period.ts:21-27` |
| F-110 | 🟡 P2 | HECHO VERIFICADO | Lotes / Cierres | Cerrar y reabrir periodo sin confirmación, con cliente y mes preseleccionados | `BatchActions.tsx:98-117` |
| F-113 | 🟡 P2 | HECHO VERIFICADO | Auditoría / panel | «cambió operationType», «Exportada (batch: cm…)» | `admin/page.tsx:137-143` |
| F-097 | 🟡 P2 | HECHO VERIFICADO | Paneles | Un error de BD se muestra como «0 facturas» o «Todo al día» | `admin/page.tsx:92` |
| F-114 | 🟡 P2 | HECHO VERIFICADO | Portal / admin | 8 tablas sin scroll horizontal; a 375 px desaparece la columna Estado | `client/invoices/page.tsx:229` |
| F-063 | 🟡 P2 | HECHO VERIFICADO | Portal | La resubida sigue apareciendo como «Rechazada» y pierde el periodo trimestral | `reupload-actions.ts:81-106` |
| F-115 | 🟡 P2 | HECHO VERIFICADO | Facturas (gestor) | Sin importe ni ordenación; las rechazadas no tienen enlace | `worker/invoices/page.tsx:184-189` |
| F-111 | 🟡 P2 | HECHO VERIFICADO | Sistema visual | Contraste por debajo de AA en los CTA, el texto secundario y el foco | `globals.css:67-99` |
| F-112 | 🟡 P2 | HECHO VERIFICADO | Accesibilidad | Zona de subida sin teclado, 39 labels sin asociar, modales sin `role=dialog` | `UploadForm.tsx:234-254` |
| F-117 | 🟡 P2 | POSIBLE MEJORA | Listados | Sin acciones masivas (validar en bloque se excluye a propósito) | `InvoicesTable.tsx:53-60` |
| F-118 | 🟡 P2 | POSIBLE MEJORA | Paneles | KPIs históricos no clicables, sin periodo en curso ni fin de lote | `worker/page.tsx:218-278` |
| F-120 | 🟡 P2 | HECHO VERIFICADO | Correos | Marca Faktury y remitente `facturocr.com`; no aparece la asesoría | `lib/email.ts:10` |
| F-121 | 🟡 P2 | HECHO VERIFICADO | Soporte | «Contacta con soporte» sin ningún canal | `lib/errorCodes.ts:70` |
| F-122 | 🟡 P2 | RIESGO PROBABLE | Visor | Se acepta HEIC, que no se ve en Chrome/Edge | `fileValidation.ts:25` |
| F-136 | 🟢 P3 | HECHO VERIFICADO | Navegador | Todas las pestañas tienen el mismo título | `src/app/layout.tsx:15-19` |
| F-137 | 🟢 P3 | HECHO VERIFICADO | Transversal | Doble h1, tres sistemas de aviso, formularios de subida y Lotes duplicados | `Topbar.tsx:239-241` |
| F-138 | 🟢 P3 | HECHO VERIFICADO | Arquitectura de información | Incidencias huérfana, `/api/search` sin UI, capturas desfasadas | `worker/issues/page.tsx` |
| F-139 | 🟢 P3 | HECHO VERIFICADO | Exportar | Exporta con avisos sin pedir confirmación; dice «pasarán a Exportada» | `ExportForm.tsx:340-366` |
| F-140 | 🟢 P3 | HECHO VERIFICADO | Facturas (admin) | «Pte. revisión» frente a «Por revisar»; «En analisis» sin tilde (**en curso**) | `admin/invoices/page.tsx:18-24` |
| F-149 | 🟢 P3 | HECHO VERIFICADO | Errores | Sin `global-error`: fuera del panel sale la página de Next en inglés | `src/app/dashboard/error.tsx` |

### 6.3 Accesibilidad medida (F-111, F-112)

| Par de colores | Contraste | Dónde |
|---|---|---|
| Blanco / green-600 | **3,22:1** | «Validar factura», el botón que más se pulsa |
| Blanco / amber-500 | **2,15:1** | «Resolver incidencias (N)» |
| slate-400 / blanco | **2,63:1** | 160 usos: CIF, fechas, subtítulos |
| Foco accent-500 / blanco | **1,81:1** | Borde de foco de todos los inputs |
| Borde slate-100 / blanco | 1,10:1 | Campos «seguros» de la revisión (F-052) |

jsx-a11y da 39 `label-has-associated-control`, 12 `click-events-have-key-events` y 15 `no-static-element-interactions`. Hay 8 usos de 9 px, 38 de 10 px y 166 de 11 px.

### 6.4 Lo que funciona y no hay que romper

- **Revisión**: la semántica de atajos (Enter solo fuera de campos, Ctrl+Enter siempre, desplegables tratados como campo). Cada regla viene de un incidente real.
- **`Select` propio**: no deja que las teclas lleguen a los atajos.
- **Fuente única de estados y formatos**: `STATUS_LABELS`, `formatEur`, `formatDateTimeEs` en hora de Madrid, `periodLabel`.
- **Listados**: paginación en servidor, estado en la URL, «Volver» que conserva el contexto, estados vacíos diferenciados y skeletons en 18 rutas.
- **Exportar**: vista previa con avisos enlazados y descarga por `fetch` con control de errores.
- **Interfaz**: `ConfirmDialog` con el foco en Cancelar y `ErrorBox` con código copiable.
- **Portal**: los estados se simplifican a «En proceso / Validada / Rechazada».

### 6.5 Orden de quick wins (≈1-2 semanas)

1. F-005: filtrar por asesoría en la subida del ADMIN (XS).
2. F-016: bloque de incidencias en la revisión y confirmación antes de validar un posible duplicado (S).
3. F-047: guarda de cambios sin guardar en toda navegación (S).
4. F-107, F-116, F-113 y F-109: mensaje de cuentas, visor en español, etiquetas de auditoría y `periodLabel` en todas partes (XS cada uno).
5. F-111: colores de CTA, texto secundario y foco (S).
6. F-110 y F-139: confirmaciones y quitar las preselecciones peligrosas (XS).
7. F-053, F-097, F-114 y F-063 (S).

Después: F-054/F-046 (alta), F-041 (exportación masiva, detrás de F-001), F-030 (agregados) y F-101 (cuentas).

---

## 7. Workflow de gestoría

**Veredicto.** Revisar una factura concreta está al nivel de un producto maduro: aprendizaje por tercero (cuentas por sentido, retención solo en persona física, «¿siempre o solo esta?»), ruteo multiempresa por CIF y corrección de validadas comparando la huella con el snapshot exportado. El flujo completo falla en los extremos, en la entrada y sobre todo en la salida hacia A3, y a escala todo es de uno en uno. A un administrativo con 1.000-3.000 facturas al mes le frustraría lo que rodea a la pantalla de revisión, no la pantalla en sí.

### 7.1 Flujo actual (9d4b10f)

| # | Etapa | Cómo funciona hoy | Dónde falla | Hallazgos |
|---|---|---|---|---|
| 1 | Entrada (cliente) | El portal propone el mes en curso, «Mensual» y «Recibidas». Deduplica por hash | El periodo por defecto casi nunca es el bueno. No hay «No lo sé». Se envía un correo por fichero a cada gestor | F-108, F-020, F-040 |
| 2 | Entrada (gestor) | Un cliente o «Clasificar entre varios» | Lo clasificado a mano no recibe el aprendizaje ni pasa por el detector. La regla de proveedor puede rutear a la empresa equivocada | F-065, F-021 |
| 3 | OCR | `after()` por fichero, 3 reintentos cortos | Sin cola ni límite. El PDF digital va por la vía multimodal porque pdfjs falla. Si se queda en ANALYZING no hay reproceso. El cron de rescate está roto | F-029, F-013, F-007 |
| 4 | Estado inicial | PENDING_REVIEW o NEEDS_ATTENTION | El dedupe funcional falla con CIF que llevan prefijo o guiones. Una mención a «rectificativa» en el texto invierte el signo | F-010, F-012 |
| 5 | Revisión | Visor, formulario, cola del lote | **La incidencia no se ve**. No hay historial ni notas. Se sustituye el destinatario sin comparar con lo leído | F-016, F-106, F-019 |
| 6 | Validación | La UI bloquea el descuadre, las cuentas vacías y emisor = receptor | El servidor no exige total, fecha, número ni líneas. Una línea incompleta se descarta. Se puede validar una dividida o una rechazada | F-009, F-014, F-015 |
| 7 | Corrección | La huella contra el snapshot decide si hay que reexportar | Bien resuelto. En la exportación no se distingue una reexportación | F-018 |
| 8 | Cierre | Botón en Lotes | Cierres no exige cero pendientes. El recordatorio se repite a diario | F-066, F-123 |
| 9 | Exportación | ADMIN, cliente a cliente, Excel A3 | **Marca antes de entregar y no permite volver a descargar** (P0). El periodo contable se ignora | F-001, F-011, F-041 |
| 10 | Importación en A3 | Manual, fuera de la app | Si A3 rechaza el fichero, no se puede regenerar | F-001, F-069 |

### 7.2 Flujo actual → flujo recomendado

| Paso | Actual | Recomendado | Hallazgo |
|---|---|---|---|
| Subir (cliente) | Mes, periodicidad y tipo en cada subida | Periodicidad guardada en el cliente. En los primeros días del mes, periodo anterior. «No lo sé» en el tipo | F-108, F-020 |
| Tipo recibida/emitida | Se fuerza el lado del cliente | Ejecutar siempre `detectInvoiceType`. Si contradice al usuario, crear una incidencia; no sobrescribir la contraparte | F-020 |
| OCR | Sin techo; los Error OCR se reprocesan a mano | Semáforo y backoff con Retry-After; «Reprocesar errores del lote»; cron arreglado | F-029, F-007 |
| Llegar a la factura | «Con incidencias» sin decir cuál | Bloque de incidencias con Resolver / Descartar y enlace a la original | F-016, F-057 |
| Validar | Ctrl+Enter una a una | Subbandeja «Verificadas» con criterios comprobables en servidor | F-055 |
| Validación incompleta | Se permite | Mínimos contables en servidor | F-009 |
| Periodo contable | Se guarda y no llega al Excel | Filtro del export y columna B según la regla del asesor, o quitar el campo | F-011 |
| Exportar | ADMIN elige cliente a cliente | Bandeja cliente × periodo, ZIP, botón en Lotes, permiso opcional al gestor | F-041 |
| Tras exportar | Marcado sin fichero | Primero el fichero, después el registro. «Volver a descargar» y «Anular lote» | F-001 |
| Avisos | Un correo por factura y por fichero | Resúmenes; solo el rechazo es inmediato | F-040 |

### 7.3 «Funciona, pero después de 8 horas lo odiaría»

- Entrar en una factura «Con incidencias» y no saber qué incidencia tiene (F-016).
- Volver a teclear nombre y NIF cuando el cliente subió una emitida como recibida (F-020).
- Pulsar Ctrl+Enter en cientos de facturas de proveedores recurrentes que ya cuadran (F-055).
- Cambiar el mes en cada subida y descubrir el error cuando ya hay 80 facturas en el lote equivocado (F-108).
- Reprocesar a mano, una a una, las que cayeron por un 429 (F-029).
- Pedir al admin cada fichero de A3 y que una descarga cortada deje facturas «exportadas» sin fichero (F-041, F-001).

---

## 8. Performance Audit

### 8.1 Resumen

Con una asesoría en producción la app responde bien. El tiempo lo marca Gemini, los listados paginan en BD y la sesión JWT no consulta la BD en cada petición. Los problemas son de **diseño que escala con el histórico**, no con el trabajo pendiente:
- Lotes y paneles agregan en memoria de Node (F-030).
- Los refrescos vuelven a lanzar el prefetch completo (F-081).
- El OCR no tiene cola (F-029).
- pdfjs falla siempre en el servidor (F-013).
- Faltan índices (F-031).

### 8.2 Método

- SQL real de Prisma 7.5 capturado con un driver adapter falso, sin BD.
- Coste en JS medido al materializar N filas.
- Reproducción de pdfjs con la misma versión que usa la app.
- Límites comprobados en `node_modules`: Prisma (maxWait 2 s y timeout 5 s en transacciones interactivas), `pg-protocol` (parámetros en Int16) y Next 16 (`router.refresh()` llama a `pingVisibleLinks`).

**No hay métricas de producción.** Los tiempos de JS están medidos; los de BD son estimaciones.

### 8.3 Tiempos del flujo principal

| Etapa | Hoy | Qué lo empeora |
|---|---|---|
| Subida (por fichero) | 0,1-0,5 s más transferencia; 3 en paralelo por navegador | Modo clasificar: 2 consultas por empresa candidata |
| OCR (por factura) | 3-8 s típico; hasta ~95 s con reintentos | Concurrencia sin techo (F-029), multimodal para todos los PDF (F-013), pool de 10 (F-080) |
| Abrir una revisión | 50-200 ms de servidor, ~9 consultas en serie | Seq scans en tablas hijas (F-031); 2 descargas del PDF (F-086) |
| Lotes / panel del gestor | 0,75 s con 10.000 facturas; 1,5 s con 30.000; 3,1-3,7 s y ~800 MB con 70.000; **falla por encima de 65.535** | Se repite cada 5 s mientras haya OCR (F-030) |
| Búsqueda | ~0,8 s con 60.000 facturas, más la BD | Sin mínimo de caracteres (F-083) |
| Exportar | Bien con pocos cientos por cliente | La auditoría va en una transacción de 5 s después de marcar (F-001) |

### 8.4 Hallazgos

| ID | Prio | Evidencia | Hallazgo | Ruta |
|---|---|---|---|---|
| F-001 | 🔴 P0 | HECHO VERIFICADO | La exportación marca antes de una auditoría O(N) con timeout de 5 s (ver P0) | `api/export/route.ts:179-185` |
| F-030 | 🟠 P1 | HECHO VERIFICADO | Lotes y paneles cargan todo el histórico. La consulta de `exportBatchItems` no se trocea: con 70.000 facturas envía 70.001 parámetros | `worker/batch/page.tsx:109-127`; `pg-protocol/dist/serializer.js:95` |
| F-013 | 🟠 P1 | HECHO VERIFICADO | `workerSrc = ""` rompe pdfjs: todos los PDF van por la vía multimodal y sin `rawText` | `src/lib/ocrLlm.ts:29,79` |
| F-029 | 🟠 P1 | RIESGO PROBABLE | OCR en `after()` sin semáforo; reintentos de 1,2/2,4 s | `api/uploads/route.ts:204-209`; `processInvoice.ts:87-130` |
| F-007 | 🟠 P1 | HECHO VERIFICADO | La recuperación de facturas atascadas está rota | `api/cron/retry-stuck/route.ts:50` |
| F-031 | 🟡 P2 | HECHO VERIFICADO | Faltan índices en las FK hijas y en las columnas calientes | `migrations/00000000000000_init/migration.sql:355-425` |
| F-080 | 🟡 P2 | RIESGO PROBABLE | Pool de 10, maxWait 2 s, sin `statement_timeout` | `src/lib/prisma.ts:9` |
| F-081 | 🟡 P2 | HECHO VERIFICADO | Los refrescos vuelven a lanzar todos los prefetch, también con la pestaña oculta | `AutoRefresh.tsx:23` |
| F-082 | 🟡 P2 | HECHO VERIFICADO | La ETA hace un aggregate de toda la tabla en cada refresco | `worker/batch/page.tsx:209` |
| F-083 | 🟡 P2 | HECHO VERIFICADO | La búsqueda filtra en JS sobre todo el histórico | `lib/invoiceListing.ts:21-40` |
| F-084 | 🟡 P2 | HECHO VERIFICADO | `distinct` de Auditoría resuelto en memoria | `admin/audit/page.tsx:81-102` |
| F-085 | 🟡 P2 | HECHO VERIFICADO | El panel admin carga el estado de todas las facturas | `admin/page.tsx:85-91` |
| F-086 | 🟡 P2 | HECHO VERIFICADO | El PDF se descarga dos veces; `/raw` lo guarda entero en memoria | `PdfViewer.tsx:155,200-204` |
| F-087 | 🟡 P2 | RIESGO PROBABLE | «Reprocesar todas»: una sola transacción y un `after()` que dura horas | `admin/invoices/actions.ts:37-87` |
| F-088 | 🟡 P2 | HECHO VERIFICADO | El plan de cuentas se importa con un upsert por fila | `accounts/actions.ts:54-56` |
| F-089 | 🟡 P2 | RIESGO PROBABLE | 20 MB de subida frente al límite inline de Gemini | `ocrLlm.ts:500` |
| F-133 | 🟢 P3 | HECHO VERIFICADO | Los listados no tienen periodo por defecto | `worker/invoices/page.tsx:111-152` |
| F-134 | 🟢 P3 | POSIBLE MEJORA | Consultas en serie que podrían ir en paralelo | `review/[id]/page.tsx:40` |
| F-135 | 🟢 P3 | HECHO VERIFICADO | Logo como data URL en cada render | `dashboard/layout.tsx:22-32` |
| F-132 | 🟢 P3 | RIESGO PROBABLE | Garage sin timeout y OCR sin plazo global | `storage.ts:33` |
| F-126 | 🟢 P3 | RIESGO PROBABLE | Trabajo de CPU en el único proceso web | `api/export/route.ts:211` |

### 8.5 Índices propuestos (F-031, migración nueva cuyo número hay que coordinar)

- `InvoiceExtraction`, `InvoiceIssue` e `InvoiceStatusHistory` por `(invoiceId, createdAt)` o `(invoiceId, status)`.
- `ExportBatchItem(invoiceId)`.
- `AuditLog(createdAt)` y `AuditLog(userId)`.
- `InvoiceStatusHistory(changedBy, toStatus, createdAt)`.
- `Invoice`: `(exportBatchId)`, `(splitFromId)`, `(documentId)` y `(clientId, periodYear, periodMonth, type)`.
- Quitar los redundantes `AccountEntry(clientId)` y `ProviderRoutingRule(advisoryFirmId)`.
- Validar con `EXPLAIN ANALYZE`.

### 8.6 Quick wins

1. F-013: precargar el worker de pdfjs, loguear el catch y añadir un test con un PDF demo (XS).
2. F-007: actor real en el cron y reproceso de las ANALYZING antiguas (S).
3. F-031: índices (S).
4. F-001: generar el Excel antes de marcar y trocear la auditoría (S como mínimo inmediato).
5. F-081 y F-082: quitar `prefetch`, pausar con `visibilitychange` y cachear la ETA (XS).
6. F-080, F-084, F-085 y F-087 (XS-S).

**Cualquier optimización de la auditoría debe producir exactamente los mismos hashes (`computeAuditHash`).**

---

## 9. Security Audit

### 9.1 Resumen

- **WORKER y CLIENT**: no se ha encontrado ningún camino hacia otra asesoría. Las acciones comprueban en servidor la asignación o el cliente propio (`canAccessClient`, `assertUploadClientAccess`, `getAccessibleClientIds`).
- **ADMIN**: no hay aislamiento. Siguen abiertos los 7 sitios aparcados (F-004) y hay un 8.º (F-005). El filtro de firma falla en abierto si falta `advisoryFirmId` (F-006).
- **P0 fuera del multitenancy**: un XML subido por un CLIENT se sirve inline en el mismo origen con una CSP que permite scripts (F-002). Es explotable **hoy** con una sola asesoría.

### 9.2 Hallazgos

| ID | Prio | Evidencia | Hallazgo | Ruta |
|---|---|---|---|---|
| F-002 | 🔴 P0 | HECHO VERIFICADO | XSS almacenado: cualquier «<x» cuenta como XML y `/raw` lo sirve inline con `unsafe-inline`. Con la sesión de un ADMIN, el script puede lanzar `GET /api/export` y marcar toda la asesoría | `fileValidation.ts:41,99`; `api/invoices/[id]/raw/route.ts:36-44`; `next.config.ts:10` |
| F-004 | 🔴 P0 | HECHO VERIFICADO | 7 accesos entre asesorías para ADMIN (conocidos, aparcados). La fuga de Exportar es **pasiva**: basta abrir la página | `invoiceAccess.ts:17`; `admin/export/page.tsx:30-35` |
| F-005 | 🔴 P0 | HECHO VERIFICADO | La subida del ADMIN lista clientes de todas las asesorías | `worker/upload/page.tsx:16-21` |
| F-006 | 🟠 P1 | HECHO VERIFICADO | `advisoryFirmId ?? undefined` en ~22 sitios (unos 11 fallan en abierto); FK con SET NULL; sin capa central | `admin/invoices/actions.ts:37`; `init/migration.sql:428` |
| F-026 | 🟠 P1 | HECHO VERIFICADO | `Client.cif` y `email` únicos globalmente: bloquea el alta y revela que existe en otra asesoría | `prisma/schema.prisma:185,188` |
| F-027 | 🟠 P1 | HECHO VERIFICADO | 0 tests de aislamiento sobre 50 puntos de entrada | `vitest.config.ts:7` |
| F-028 | 🟠 P1 | HECHO VERIFICADO | No se puede desactivar un usuario ni revocar sesiones. El JWT es **deslizante** (el comentario «8h absolute» es falso) | `auth.ts:22-38`; `@auth/core/lib/actions/session.js:33-50` |
| F-037 | 🟠 P1 | RIESGO PROBABLE | Gemini por AI Studio con endpoint global y la clave en la query string. El PDF entero solo se envía si es escaneado o imagen | `ocrLlm.ts:326,493-502` |
| F-017 | 🟠 P1 | HECHO VERIFICADO | `Content-Disposition` sin sanear: ’/€/emoji provocan TypeError después de marcar | `exportFormats.ts:186` |
| F-071 | 🟡 P2 | HECHO VERIFICADO | GET con efectos: sin parámetros consume todo lo pendiente | `api/export/route.ts:9-64` |
| F-091 | 🟡 P2 | HECHO VERIFICADO | El rate limit está solo en `loginAction`; `failedAttempts` no es atómico | `auth.ts:58-84` |
| F-092 | 🟡 P2 | HECHO VERIFICADO | Bloqueo a los 3 intentos, se muestra como «contraseña incorrecta» y no se puede desbloquear | `login/actions.ts:34-46` |
| F-093 | 🟡 P2 | HECHO VERIFICADO | «Demo1234!» por defecto, tokens de restablecimiento en claro, sin 2FA | `forgot-password/actions.ts:44-49` |
| F-094 | 🟡 P2 | RIESGO PROBABLE | Subidas sin límite de cuerpo previo ni cuota | `api/uploads/route.ts:45-72` |
| F-095 | 🟡 P2 | POSIBLE MEJORA | CSP permisiva y `X-Powered-By` | `next.config.ts:8-20` |
| F-090 | 🟡 P2 | RIESGO PROBABLE | xlsx 0.18.5 con CVE-2023-30533 y CVE-2024-22363 | `package.json:33` |
| F-096 | 🟡 P2 | POSIBLE MEJORA | Sin `npm audit` ni Dependabot | `package.json` |
| F-098 | 🟡 P2 | HECHO VERIFICADO | Logs con datos personales (NIF, importes, correos) | `ocrLlm.ts:366` |
| F-125 | 🟢 P3 | RIESGO PROBABLE | Las claves de storage pueden colisionar | `api/uploads/route.ts:157-163` |
| F-131 | 🟢 P3 | HECHO VERIFICADO | reset-demo borra los tokens de todas las asesorías (solo con `ALLOW_DEMO_RESET`) | `demoSeed.ts:118` |
| F-148 | 🟢 P3 | HECHO VERIFICADO | Los grupos solo comprueban la firma, no el acceso a los miembros | `worker/groups/actions.ts:50-83` |

**Orden:** F-002, F-005 y F-004 antes de la segunda asesoría o de abrir más el portal (F-002 cuanto antes, porque ya es explotable). Después F-017, F-006, F-027 y F-028.

### Tenant Isolation

Leyenda: OK* = correcto, pero falla en abierto si la sesión no trae firma (F-006).

| Punto de entrada | Control de tenant | Estado |
|---|---|---|
| `createClient`, plan de cuentas (6 acciones), ajustes (5), gestores (4) | Firma del usuario | OK (las del plan fallan cerrado aunque usen `?? undefined`) |
| `closePeriod` / `reopenPeriod` (`admin/closures/actions.ts:7-70`) | Ninguno | **FAIL** (F-004) |
| `reprocessAllOcrErrors` (`admin/invoices/actions.ts:37`) | Firma con `?? undefined` | **RISK** latente: hoy todos los ADMIN tienen firma (F-004, F-006) |
| `quickRejectDuplicate`, `dismissDuplicateIssue` (`worker/invoices/actions.ts:22`) | ADMIN sin filtro | **FAIL** (F-004); además envía el email al cliente ajeno |
| `resolveIssue`, `dismissIssue` (`worker/issues/actions.ts:10`) | Solo se comprueba el rol WORKER | **FAIL** (F-004), requiere conocer un cuid |
| `closePeriodFromBatch`, `rejectBatch`, `classifyInvoice`, `discardUnclassified` | `canAccessClient` / firma | OK |
| Grupos (3 acciones) | Firma | OK dentro de la asesoría; matiz F-148 |
| Acciones de revisión (7) | `canAccessClient` | OK |
| `reuploadInvoiceAction` | Cliente propio | OK |
| Login, olvido y restablecimiento | Previos a la sesión | N/A |
| `/api/uploads` | `assertUploadClientAccess` | OK |
| `/api/invoices/[id]/preview` y `/raw` | `canReadInvoice`: ADMIN = true | **FAIL** (F-004) |
| `/api/invoices/[id]/process` | `canAccessClient` | OK |
| `/api/search` | ADMIN sin filtro; sin consumidor en la UI | **FAIL** (F-004) |
| `/api/export` | Firma (`client.advisoryFirmId`) | OK (CSRF en F-071) |
| `/api/admin/reset-demo` | Variable de entorno + firma; tokens globales | RISK bajo (F-131) |
| `/api/admin/verify-audit`, crons | Firma / secreto en tiempo constante | OK |
| Páginas de admin (salvo Exportar) | Firma | OK* (F-006) |
| `admin/export` (página) | Sin filtro en clientes ni lotes | **FAIL** (F-004) |
| Páginas del gestor (salvo subida) | Asignación / `canAccessClient` | OK |
| `worker/upload` con rol ADMIN | Sin filtro | **FAIL** (F-005, nuevo) |
| Páginas del cliente | Cliente propio | OK |

**Conclusión: FAIL.** Con WORKER y CLIENT el resultado es PASS. Con ADMIN es FAIL en 11 puntos de entrada, y otros 2 quedan en RISK. No hay ninguna defensa estructural (extensión de Prisma o RLS) ni tests (F-027). Hoy no se puede explotar solo porque producción tiene una sola asesoría; es **bloqueante antes de dar de alta la segunda**.

---

## 10. Integridad contable

### 10.1 Resumen

La aritmética del total está bien vigilada. Base + IVA + Recargo − IRPF = Total con multi-IVA y recargo por línea. El Excel A3 lleva una fila por tipo y el IRPF una sola vez, y la reexportación se decide por huella contra el snapshot. El riesgo está en los datos que **parecen correctos pero no lo son contablemente** y casi nunca dejan rastro. Con 10-100 asesorías estos casos silenciosos llegarán al 303.

### 10.2 Hallazgos

| ID | Prio | Evidencia | Hallazgo | Ruta |
|---|---|---|---|---|
| F-001 | 🔴 P0 | HECHO VERIFICADO | Facturas «exportadas» que nunca llegaron a A3 (ver P0) | `api/export/route.ts:118-193` |
| F-009 | 🟠 P1 | HECHO VERIFICADO | Se valida sin total, líneas, fecha ni número. Las de total 0 o vacío se marcan pero no salen en el Excel | `review/[id]/actions.ts:433-435`; `exportFormats.ts:467-470` |
| F-011 | 🟠 P1 | HECHO VERIFICADO | El periodo contable no llega al export y la columna B es siempre la fecha de la factura. Además permite saltarse un cierre | `exportFormats.ts:245-258`; `actions.ts:179-180` |
| F-012 | 🟠 P1 | HECHO VERIFICADO | Una rectificativa se niega siempre, también al alza. Una mención en el texto invierte el signo de una factura ordinaria (hoy latente con Gemini por F-013) | `rectificative.ts:21,66-85`; `processInvoice.ts:488-519` |
| F-014 | 🟠 P1 | HECHO VERIFICADO | Una línea de IVA incompleta se descarta en silencio mientras el semáforo la cuenta | `actions.ts:135` |
| F-015 | 🟠 P1 | HECHO VERIFICADO | Se puede validar una SPLIT_SOURCE (doble asiento con sus hijas) y volver a dividir | `actions.ts:516-518,1027-1031` |
| F-010 | 🟠 P1 | HECHO VERIFICADO | Duplicados: se compara el CIF crudo con el normalizado. Con proveedores UE no detecta nunca | `issueDetector.ts:147-152` |
| F-019 | 🟠 P1 | HECHO VERIFICADO | Se fuerza el cliente como receptor sin comparar con el NIF leído (deducibilidad) | `processInvoice.ts:347-358` |
| F-022 | 🟠 P1 | HECHO VERIFICADO | No se comprueba cuota ≈ base × % por línea | `exportFormats.ts:394-405` |
| F-023 | 🟠 P1 | RIESGO PROBABLE | Intracomunitarias e ISP al 0 %: posible falta de autorrepercusión en el 303. **Hay que confirmarlo en A3** | `exportFormats.ts:258-259,315-321` |
| F-024 | 🟠 P1 | HECHO VERIFICADO | La auditoría no registra fecha, cuentas, periodo contable ni retención, ni los ajustes automáticos | `actions.ts:399-405` |
| F-018 | 🟠 P1 | HECHO VERIFICADO | La corregida se reexporta como una fila normal (hay aviso solo en la revisión) | `actions.ts:469-483` |
| F-025 | 🟠 P1 | HECHO VERIFICADO | Nada bloquea el export (moneda ≠ EUR, sin fecha…); los avisos se recortan a 20 | `api/export/route.ts:91` |
| F-008 | 🟠 P1 | HECHO VERIFICADO | El OCR sobrescribe lo validado, rechazado o dividido durante el análisis | `processInvoice.ts:571-631` |
| F-060 | 🟡 P2 | HECHO VERIFICADO | Gemini descarta las líneas al 0 % | `ocrLlm.ts:393` |
| F-059 | 🟡 P2 | HECHO VERIFICADO | Redondeos en coma flotante: 100,50 × 15 % da 15,07 | `ReviewForm.tsx:535-540` |
| F-072 | 🟡 P2 | HECHO VERIFICADO | Recargo propuesto a partir del total, indistinguible del leído | `equivalenceSurcharge.ts:134-185` |
| F-073 | 🟡 P2 | HECHO VERIFICADO | El IRPF impreso se sustituye por base × % aprendida | `processInvoice.ts:437-486` |
| F-074 | 🟡 P2 | RIESGO PROBABLE | Fuera de la UE siempre «Importación», también en servicios (art. 84.Uno.2º LIVA) | `validators.ts:79-90` |
| F-051 | 🟡 P2 | RIESGO PROBABLE | Cliente en recargo: compras exportadas como IVA deducible | `exportFormats.ts:232-234` |
| F-075 | 🟡 P2 | HECHO VERIFICADO | Sufijo «_R» sobre el número real de la rectificativa | `exportFormats.ts:249-260` |
| F-076 | 🟡 P2 | HECHO VERIFICADO | CIF con control «J» rechazado | `validators.ts:53-58` |
| F-077 | 🟡 P2 | HECHO VERIFICADO | El plan aprendido se sobrescribe con la última cuenta, incluida la genérica | `actions.ts:606-641` |
| F-058 | 🟡 P2 | HECHO VERIFICADO | Dos tolerancias de cuadre (0 y 2 céntimos) en cinco sitios | `invoiceBalance.ts:1` |
| F-066 | 🟡 P2 | HECHO VERIFICADO | Huecos en el bloqueo por periodo cerrado | `actions.ts:177-192` |
| F-142 | 🟢 P3 | HECHO VERIFICADO | Facturae: se pierde la serie y el IGIC se trata como IVA | `ocr.ts:526-533` |
| F-143 | 🟢 P3 | HECHO VERIFICADO | `fmtDate` en hora local y la huella en UTC | `exportFormats.ts:70-82` |
| F-144 | 🟢 P3 | HECHO VERIFICADO | El export mensual arrastra lo subido como trimestral | `api/export/route.ts:43-62` |

### 10.3 A verificar con el asesor o con una importación de prueba en A3 (no verificado)

1. Compras de tipo 3, 4 y 8 al 0 % y al 21 %, y su efecto en las casillas del 303 (F-023).
2. Reacción de A3 a un NIF + número repetidos al reexportar (F-018).
3. Compras de un minorista en recargo (F-051).
4. Qué fecha quiere el asesor en la columna B cuando el periodo contable difiere del de la factura (F-011).
5. Reparto del IRPF en facturas con varias filas (F-073).

**No tocar:** las cabeceras A3 (incluido «Cutoa»), `exportFingerprint` (solo a la vez que cualquier cambio de columnas), `foldSurchargeLines` y la simetría entre `accountEntryKey` y `taxIdWithCountry`.

---

## 11. Database Audit

### 11.1 Resumen

Para un piloto el esquema está bien planteado. Importes en `Decimal(12,2)`, `AdvisoryFirm` como raíz, unicidades útiles (`AccountEntry(clientId,nif)`, `PeriodClosure`, `replacesId @unique`) y FK RESTRICT que protegen el historial legal. Comparando a mano `schema.prisma` con el SQL acumulado no hay deriva. **La BD casi no garantiza invariantes de negocio**, y el código las comprueba leyendo y luego escribiendo, sin transacción.

### 11.2 Hallazgos

| ID | Prio | Evidencia | Hallazgo | Ruta |
|---|---|---|---|---|
| F-001 | 🔴 P0 | HECHO VERIFICADO | Exportación sin `$transaction`: `updateMany` sin `exportBatchId: null` y auditoría con el timeout por defecto de 5 s | `api/export/route.ts:179-185`; `lib/prisma.ts:8-15` |
| F-006 | 🟠 P1 | HECHO VERIFICADO | `User.advisoryFirmId` opcional con SET NULL y filtros que fallan en abierto | `schema.prisma:174`; `init/migration.sql:428` |
| F-026 | 🟠 P1 | HECHO VERIFICADO | `Client.cif`/`email` y `User.username`/`email` únicos globalmente | `schema.prisma:164-165,185,188` |
| F-036 | 🟠 P1 | RIESGO PROBABLE | `migrate deploy` en cada arranque sin copia automática. DEPLOY.md recomienda `migrate reset --force`, que **hoy borraría producción** | `docker-entrypoint.sh:8`; `DEPLOY.md:44-50` |
| F-033 | 🟠 P1 | HECHO VERIFICADO | Ningún test contra PostgreSQL | `vitest.config.ts:7` |
| F-031 | 🟡 P2 | HECHO VERIFICADO | FK hijas sin índice; compuestos desalineados; 2 índices redundantes | `schema.prisma:473-557` |
| F-048 | 🟡 P2 | HECHO VERIFICADO | Cadena de auditoría sin serializar, fuera de la transacción del cambio y sin ancla | `auditLog.ts:65-125` |
| F-050 | 🟡 P2 | RIESGO PROBABLE | Líneas de IVA duplicables: no hay `@@unique([invoiceId, position])` | `schema.prisma:454` |
| F-056 | 🟡 P2 | HECHO VERIFICADO | Transiciones sin condición sobre el estado previo; 14 escrituras de historial | `actions.ts:194-201` |
| F-061 | 🟡 P2 | RIESGO PROBABLE | `fileHash` sin unicidad; la deduplicación de subida no es atómica | `api/uploads/route.ts:127-141` |
| F-067 | 🟡 P2 | HECHO VERIFICADO | `AuditLog.invoiceId` obligatorio; el upsert de `PeriodClosure` pierde las reaperturas | `schema.prisma:569-604` |
| F-080 | 🟡 P2 | RIESGO PROBABLE | Pool y timeouts por defecto | `lib/prisma.ts:9` |
| F-155 | 🟢 P3 | HECHO VERIFICADO | Sin CHECK de rangos de periodo; ANALYZED y EXPORTED siguen en el enum | `schema.prisma:103,329` |
| F-154 | 🟢 P3 | POSIBLE MEJORA | La tabla `Document` solo se escribe y diverge de `Invoice` | `schema.prisma:289` |
| F-129 | 🟢 P3 | HECHO VERIFICADO | Cliente centinela «Sin clasificar» | `unclassifiedClient.ts:12-24` |

### 11.3 Multitenancy en el esquema

Solo `Client`, `User`, `ClientGroup` y `ProviderRoutingRule` llevan `advisoryFirmId`. **No hay FK compuestas**, así que nada en la BD impide que una fila apunte a un cliente de otra asesoría. `ExportBatch` no tiene asesoría ni FK (F-004). Tampoco tienen FK `InvoiceStatusHistory.changedBy` (puede valer «system»), `PeriodClosure.closedBy`, `Invoice.routingCandidateIds[]` ni `PasswordResetToken`.

**Recomendación:**
- **Corto plazo:** un helper `requireFirmSession()` y una regla ESLint.
- **En BD:** FK con RESTRICT, `CHECK (role = 'CLIENT' OR "advisoryFirmId" IS NOT NULL)` y `@@unique([advisoryFirmId, cif])`.
- **Medio plazo:** RLS o una extensión de Prisma.

### 11.4 Migraciones

- Hay que numerar las nuevas coordinando: la 10 la tiene reservada otro desarrollador, y hay datos contradictorios sobre si la 9 está aplicada en producción (F-036).
- Con volumen, usar `CREATE INDEX CONCURRENTLY` fuera de la transacción de Prisma.
- Los índices parciales hechos con SQL a mano no aparecen en `schema.prisma` y `migrate dev` propondrá borrarlos.
- Para cambios destructivos (la 8 hace `DROP COLUMN`), usar expand/contract.
- Hacer un `pg_dump` automático fuera del servidor antes de migrar (F-003).

### 11.5 Consultas de diagnóstico (solo lectura, antes de migrar)

```sql
-- F-048 bifurcaciones de la cadena
SELECT "prevId", count(*) FROM "AuditLog" WHERE "prevId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- F-050 líneas duplicadas
SELECT "invoiceId", position, count(*) FROM "InvoiceVatLine" GROUP BY 1,2 HAVING count(*) > 1;
-- F-061 ficheros repetidos
SELECT "clientId","fileHash",count(*) FROM "Invoice" WHERE status NOT IN ('REJECTED','SPLIT_SOURCE') AND "fileHash" IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
-- F-007 afectadas por el cron y atascadas
SELECT id FROM "Invoice" WHERE status='OCR_ERROR' AND "totalAmount" IS NOT NULL AND "lastOcrError" LIKE '[ERR-OCR-002]%';
SELECT id,status,"ocrAttempts" FROM "Invoice" WHERE status IN ('UPLOADED','ANALYZING') AND "updatedAt" < now() - interval '1 hour';
-- F-006 internos sin asesoría / F-155 rangos y estados legacy
SELECT id,role FROM "User" WHERE role IN ('ADMIN','WORKER') AND "advisoryFirmId" IS NULL;
SELECT status,count(*) FROM "Invoice" GROUP BY status;
```

**No tocar:**
- las migraciones aplicadas;
- `audit_log_immutable` y el formato de `computeAuditHash`;
- el bypass `app.allow_audit_mutation`, que debe quedar limitado a demoSeed;
- las FK RESTRICT;
- el formato de `ExportBatchItem.snapshot`;
- la convención `''` en `AccountEntry`;
- la transición `UPLOADED→ANALYZING`;
- el patrón de `rejectBatch`.

---

## 12. Export Audit

### 12.1 Veredicto

| Aspecto | Estado |
|---|---|
| Contenido de la fila A3 (IVA, recargo, IRPF en la primera fila, NIF con país, `_R`, celdas numéricas y de texto, sin inyección de fórmulas) | ✅ Sólido; comprobado leyendo de vuelta el xlsx |
| Aislamiento en `/api/export` | ✅ Filtra por `client.advisoryFirmId`. La **pantalla** no (F-004) |
| Detección de correcciones posteriores al export (huella contra snapshot) | ✅ Bien diseñada |
| Atomicidad y recuperación | ❌ Marca antes de entregar, sin reintento ni nueva descarga (🔴 F-001) |
| Nombre del fichero | ❌ ’ € Ł emoji provocan TypeError; `%` provoca URIError (🟠 F-017) |
| Coherencia entre fichero y lote | ❌ Las de total vacío o 0 se marcan pero no salen (🟠 F-009) |
| Reexportación en A3 | ⚠️ Se detecta, pero sale mezclada con el resto (🟠 F-018) |
| Periodo contable | ❌ No tiene efecto en el Excel (🟠 F-011) |
| Errores que bloquean | ❌ Todo son avisos (🟠 F-025) |
| Concurrencia | ⚠️ Dos exportaciones a la vez pueden duplicar (🟡 F-049) |
| Trazabilidad del fichero | ❌ No se guarda (🟡 F-069) |

### 12.2 Qué pasa si falla a mitad (F-001)

`GET /api/export`, sin transacción:
1. `exportBatch.create` (:118)
2. `exportBatchItem.createMany` (:132)
3. `invoice.updateMany` sin condición (:179)
4. `appendAuditLogs` fuera del try (:185)
5. `suggestFilename` (:207)
6. `generateA3Excel` y la respuesta (:209-218)

Un fallo en el paso 4 o posterior deja las facturas marcadas: la vista previa pasa a «0 · N ya exportadas» y el reintento da 404 aunque ERR-EXPORT-002 diga «Reintenta».

**Disparadores comprobados:**
- un nombre de cliente con cualquier carácter por encima de U+00FF (’ —) falla **siempre** en Node 22;
- una respuesta perdida (pestaña cerrada o red).

**Probable:** timeout de la auditoría con un cliente de más de ~1.000 facturas en el periodo. No está medido. El caso de «todos los clientes» no se puede lanzar desde la UI, porque siempre envía `clientId`.

Hoy la única recuperación es SQL manual.

### 12.3 ¿Quién exportó esta factura, cuándo, con qué valores y en qué fichero?

| Pregunta | Respuesta | Evidencia y límites |
|---|---|---|
| **Quién** | Sí | `ExportBatch.userId` (`route.ts:127`) y `AuditLog field="export"` por factura (`route.ts:185-193`), visibles en la ficha de admin. `userId` no tiene FK. Si la auditoría falla, no queda entrada (F-001) |
| **Cuándo** | Sí | `ExportBatch.createdAt` y `ExportBatchItem.createdAt`, un item por cada vez que se exporta |
| **Qué valores** | Sí, **solo en BD** | `ExportBatchItem.snapshot` (`route.ts:136-173`), hecho con los mismos objetos que el fichero. No se ve en ninguna pantalla. Los snapshots legacy del backfill (`scripts/backfill-hardening.ts:55-71`) no reflejan el momento del export. Los cambios de fecha y de cuentas no se auditan (F-024) |
| **Qué fichero** | **No** | El xlsx no se guarda: no hay nombre, hash, filas ni excluidas (F-069). Reconstruirlo desde los snapshots no coincide si hubo facturas de total 0 (F-009) |

Consulta de solo lectura disponible hoy:

```sql
SELECT eb.id, eb."createdAt", u.name, eb."periodType", eb."periodMonth", eb."periodYear", eb."invoiceCount", ebi.snapshot
FROM "ExportBatchItem" ebi JOIN "ExportBatch" eb ON eb.id = ebi."exportBatchId"
LEFT JOIN "User" u ON u.id = eb."userId" WHERE ebi."invoiceId" = $1 ORDER BY ebi."createdAt";
```

### 12.4 Otros hallazgos del área

| ID | Prio | Evidencia | Hallazgo |
|---|---|---|---|
| F-041 | 🟠 P1 | HECHO VERIFICADO | Solo ADMIN y cliente a cliente, sin aviso de facturas sin validar |
| F-071 | 🟡 P2 | HECHO VERIFICADO | Descarga por GET con efectos |
| F-070 | 🟡 P2 | HECHO VERIFICADO | Sin control de duplicados (sentido, NIF, número) en el export |
| F-079 | 🟡 P2 | RIESGO PROBABLE | Las ventas ISP y exentas no se pueden expresar |
| F-078 | 🟡 P2 | HECHO VERIFICADO | Cuentas fijas de 8 dígitos; `accountLength` no se usa |
| F-103 | 🟡 P2 | HECHO VERIFICADO | Los tests no fijan cabeceras, fechas, `_R`, IRPF ni la paridad entre huella y fila |
| F-127 | 🟢 P3 | RIESGO PROBABLE | El blob se revoca justo después de `a.click()` |
| F-145 | 🟢 P3 | HECHO VERIFICADO | Exportadores CSV muertos que el INFORME anuncia como disponibles |
| F-146 | 🟢 P3 | POSIBLE MEJORA | Sin validar longitudes frente a A3 |
| F-147 | 🟢 P3 | HECHO VERIFICADO | Una factura legacy EXPORTED corregida no vuelve a VALIDATED (**en curso**) |

### 12.5 Plan

1. **Esta semana:**
   - Sanear el nombre del fichero con `filename*` (F-017).
   - Trocear la auditoría como en `rejectBatch`.
   - Cambiar el texto de ERR-EXPORT-002.
   - Exigir el total al validar y no marcar las facturas excluidas (F-009).
   - Filtrar la pantalla por asesoría (F-004).
2. **Antes de la segunda asesoría:** F-001 completo.
   - Generar el fichero.
   - Una `$transaction` con reserva `exportBatchId IS NULL` y `count === N`.
   - Auditoría en bloque con el mismo hash.
   - «Volver a descargar» desde el snapshot y «Anular lote» auditado.
   - POST (F-071) y reserva atómica (F-049).
3. **Primeros clientes:** F-018 (bloque de reexportadas), F-025 (avisos que bloquean), F-011 (regla de la columna B acordada), F-069 y F-070.

---

## 13. Testing Gap Analysis

### 13.1 Estado medido

| Métrica | Valor |
|---|---|
| Tests unitarios (Vitest) | 19 ficheros, **370 tests en verde**, 2,5-9 s, sin red ni BD |
| `tsc --noEmit` | Verde (strict). `next build` bloquea con errores de tipos |
| ESLint | `src`: 54 problemas (45 errores). `src tests`: 197 (143 son `any` en un solo fichero de tests) (F-150) |
| Tests de integración con BD | **0**, aunque AGENTS.md exige BD real (F-033) |
| Server actions y route handlers probados | **0 / 50** |
| Módulos de `src/lib` con Prisma y tests | **0 / 12** |
| E2E | 5 tests de humo del login, **rotos** (buscan «email») y no se ejecutan en ningún sitio (F-104) |
| CI / gate antes de desplegar | **Ninguno** (F-032) |
| Regresiones no detectadas | 22 fallos confirmados en 9d4b10f, en arreglo |

### 13.2 Cobertura por área

| Área | Cubierto | Sin cubrir | Riesgo | Hallazgos |
|---|---|---|---|---|
| Lógica fiscal pura | Bien, ~150 tests con casos reales | Tolerancia única de cuadre | Datos incorrectos en A3 | F-058 |
| Constructor del Excel A3 | Recargo, prefijo de país, multi-IVA | Cabecera exacta de 16 columnas, IRPF en la primera fila, `_R`, exclusión por total 0 | 111/115 y asientos | F-103 |
| Ruta de exportación | Nada | Firma, atomicidad, concurrencia, reexportación | **Asientos perdidos o duplicados** | F-001, F-049 |
| Validación (`parseAndSave`) | Nada; está en un fichero `"use server"` | Parseo, cuadre, lado del cliente, auditoría, aprendizaje | Datos contables | F-102, F-009, F-014 |
| Multitenancy | Nada | Matriz rol × recurso ajeno | **Fuga entre asesorías** | F-027, F-004 |
| Subida y deduplicación | Magic bytes | Hash con concurrencia; CIF normalizado | Duplicados | F-061, F-010 |
| OCR (`processInvoice`) | Moneda | Estados, claim atómico, carrera final | Facturas atascadas o sobrescritas | F-008, F-013 |
| Auditoría | Nada | Concurrencia, triggers | Falsas manipulaciones | F-048 |
| Crons | Nada | Método HTTP, actor | Error OCR falso | F-007 |
| Migraciones | Nada | `migrate deploy` sobre BD vacía, diff | Producción no arranca | F-032, F-036 |
| UI de revisión | Nada | Atajos, cambios sin guardar | Validaciones involuntarias | F-104, F-047 |

### Tests obligatorios antes de comercializar

**Bloque 0: infraestructura (~3 días, sin paquetes nuevos).**
- `RUN npx vitest run` en el builder del Dockerfile.
- `tests/integration` con un `globalSetup` que aborte si `TEST_DATABASE_URL` no es local o `_test`, y que ejecute `migrate deploy`.
- `TRUNCATE ... CASCADE` teniendo en cuenta el trigger de auditoría.
- Factories de **dos asesorías**.
- Mocks solo de lo externo: auth, `next/cache`, `after` en línea, storage en memoria, OCR con fixture y email espía. **Nunca Prisma.**
- Los defectos conocidos se escriben como `it.fails`.

**Bloque P0: antes de la segunda asesoría (~5-6 días).**

| # | Test | Qué verifica | Cubre |
|---|---|---|---|
| T-01 | `tenant-matrix.int.test.ts` | Cada action o route con id: la firma B contra recursos de A devuelve error o 404 y **no cambia ninguna fila de A**. Un inventario falla si aparece una entrada fuera de la matriz | F-004, F-005, F-027 |
| T-02 | `tenant-listings.int.test.ts` | Listados, paneles, `/api/search`, la página de Exportar y Auditoría solo devuelven datos de la propia firma | F-004, F-005 |
| T-03 | `invoice-file-access.int.test.ts` | `/raw` y `/preview`: 404 para ADMIN de otra firma, WORKER sin asignación y CLIENT ajeno. Un XML se sirve como adjunto con `sandbox` | F-004, F-002 |
| T-04 | `a3Golden.test.ts` | Excel completo frente a un fixture versionado (cabecera con «Cutoa», IRPF solo en la primera fila, `_R`, intracomunitaria, recargo, exclusión por total 0) | F-103 |
| T-05 | `export-route.int.test.ts` | Solo VALIDATED con `exportBatchId` nulo de la firma; items con snapshot; la segunda llamada da 404 | F-001 |
| T-06 | `export-atomicity.int.test.ts` | Con un fallo simulado (nombre con «’», xlsx o auditoría) **ninguna factura queda marcada**; no se marca nada sin fila en el Excel | F-001, F-017, F-009 |
| T-07 | `export-concurrency.int.test.ts` | Dos exportaciones simultáneas: cada factura queda en un solo lote | F-049 |
| T-08 | `export-reexport-cycle.int.test.ts` | Exportar, corregir (vuelve a la cola), deshacer (vuelve al lote) y reexportar solo la corregida | F-018 |
| T-09 | `invoice-validation.test.ts` | Tras extraer `parseAndSave` a lib: líneas incompletas, mínimos contables, signos, lado del cliente, diff de auditoría | F-102, F-014, F-009, F-012 |
| T-10 | `validate-invoice.int.test.ts` | Transición a VALIDATED con historial y auditoría; rechazo desde SPLIT_SOURCE; periodo cerrado; bloqueo optimista atómico | F-015, F-066, F-050 |

**Bloque P1: primeros clientes (~5 días).**
- T-11 duplicados con CIF en varios formatos (F-010).
- T-12 deduplicación de subidas en paralelo (F-061).
- T-13 política única de cuadre (F-058).
- T-14 cadena de auditoría concurrente con 0 roturas (F-048).
- T-15 `processInvoice` con fixture: claim atómico y escritura final condicionada (F-008).
- T-16 cron `retry-stuck`: acaba en PENDING_REVIEW y usa el método documentado (F-007).
- T-17 cierres de periodo (F-066).
- T-18 atomicidad de la división (F-062).
- T-19 `migrate deploy` y `migrate diff` en CI (F-032).
- T-20 guarda de reset-demo (F-131).
- T-21 token de un solo uso y bloqueo de login (F-092).

**Bloque E2E: antes de promocionar a producción.** Camino feliz subir → validar → exportar, aislamiento con URLs ajenas, y atajos más cambios sin guardar en la revisión (F-104, F-047).

No hay que perseguir un porcentaje de cobertura global: el riesgo está en unos 10 flujos de servidor.

---

## 14. SaaS Readiness

**Veredicto.** Faktury está listo para seguir como **piloto acompañado** con MS Assessors, pero **no para cobrar a una segunda asesoría** sin que intervenga el desarrollador. Casi todo lo que bloquea es de esfuerzo XS o S. Con 2-3 semanas enfocadas se puede cobrar a las primeras 3-5 asesorías.

### 14.1 Obligatorio antes de cobrar

| Estado | Elemento | Situación | Ref. |
|---|---|---|---|
| ❌ | Copias fuera del servidor y restauración probada | BD, PDF, dev y builds en una sola máquina. Solo hay un `pg_dump` manual en `/root`. El backup del bucket está pendiente (`DEPLOY.md:114`). No se ha podido comprobar la configuración de Coolify ni de Hetzner | 🔴 F-003 |
| ❌ | XSS por ficheros subidos | Un XML de un cliente se ejecuta con la sesión del gestor | 🔴 F-002 |
| ❌ | Aislamiento completo entre asesorías | 7 sitios conocidos + la subida del ADMIN | 🔴 F-004, 🔴 F-005, 🟠 F-006 |
| ❌ | Exportación recuperable | Marca sin fichero y no permite volver a descargar | 🔴 F-001 |
| ❌ | CIF único por asesoría | Hoy es único en toda la plataforma | 🟠 F-026 |
| ❌ | Condiciones, contrato de encargado (DPA, art. 28) con subencargados, privacidad y aviso legal LSSI públicos | `/legal` genérico y tras el login | 🟠 F-038 |
| ⚠️ | OCR con garantías RGPD | Gemini con endpoint global; hay que verificar el nivel de pago o pasar a Vertex UE | 🟠 F-037 |
| ❌ | Recuperación de facturas atascadas | El cron está roto y ANALYZING no se puede reprocesar | 🟠 F-007 |
| ❌ | Tracking de errores, health check real y alertas | No hay nada; el health check apunta a `/login` | 🟠 F-034 |
| ⚠️ | Correo con control de errores y política de envío | Los errores de Resend no se miran; un correo por fichero y por factura | 🟠 F-039, 🟠 F-040 |
| ❌ | Baja de usuarios y revocación de sesiones | No existe | 🟠 F-028 |
| ❌ | Medición de uso y suspensión por asesoría | No existe | 🟠 F-043 |
| ❌ | Exportación y borrado de datos al terminar el contrato | Solo con SQL y el bypass de auditoría | 🟠 F-044 |
| ❌ | Migraciones con copia previa y guía de recuperación correcta | `reset --force` documentado | 🟠 F-036 |
| ❌ | CI con tests antes de desplegar | Redeploy manual sin tests | 🟠 F-032 |
| ⚠️ | Editar cliente y darle acceso al portal (conocido) | Un email mal escrito solo se arregla en la BD | 🟠 F-046 |

### 14.2 Debería hacerse pronto (3-10 asesorías)

| Estado | Elemento | Ref. |
|---|---|---|
| ⚠️ | Decidir el modelo de despliegue (instancia compartida con dominio neutro o una por asesoría) | 🟡 F-045 |
| ⚠️ | Alta de asesoría sin chocar por username, sin «Demo1234!» y sin reutilizar CIF | 🟡 F-042 |
| ⚠️ | Gestión de cuentas: «Mi cuenta», invitación de gestores, segundo ADMIN | 🟡 F-101 |
| ❌ | Alta masiva de clientes y asignaciones | 🟡 F-054 |
| ❌ | Canal de soporte y ayuda | 🟡 F-121 |
| ⚠️ | Correos con la marca de la asesoría y Reply-To | 🟡 F-120 |
| ⚠️ | Auditoría de acciones de administración y cierres | 🟡 F-067 |
| ❌ | Cola de OCR con reparto por asesoría | 🟠 F-029 |
| ⚠️ | Bloqueo de login usable y desbloqueo por el admin | 🟡 F-092 |
| ❌ | 2FA para ADMIN | 🟡 F-093 |
| ⚠️ | Configuración contable por asesoría (longitud de cuenta) | 🟡 F-078 |

### 14.3 Puede esperar

| Estado | Elemento | Ref. |
|---|---|---|
| ❌ | Facturación automática (hasta unas 10 asesorías basta con facturar a mano a partir del informe de uso) | F-043 |
| ❌ | Panel de operador de plataforma | 🟡 F-100 |
| ⚠️ | Páginas de error global en español | 🟢 F-149 |
| ❌ | Marca blanca completa (dominio y remitente propios) | F-120 |
| ❌ | SSO con Google o Microsoft | No evaluado como hallazgo |

### 14.4 Ya está bien (no rehacer)

- Restablecimiento de contraseña: no revela cuentas, token de un solo uso con 1 h de caducidad, rate limit.
- Cabeceras HSTS, frame-ancestors y nosniff, y cookies `__Host-`/`__Secure-` (comprobado en dev).
- Solo cookies técnicas, así que no hace falta banner.
- Auditoría inmutable con cadena de hash.
- Catálogo de códigos de error.
- Docker sin root.
- Reset de demo protegido con `ALLOW_DEMO_RESET`.
- 370 tests unitarios.

---

## 15. Deuda técnica

Solo se incluye la deuda que **provoca fallos**, **impide escalar** o **frena el desarrollo y el soporte**. La base de dominio es sólida: `tsc` strict limpio, lógica fiscal en módulos puros con tests y comentarios que explican el porqué sin ningún TODO. El problema está en la **orquestación**: 249 de las 310 llamadas `prisma.*` están en páginas, actions y routes, y cada una resuelve a su manera la asesoría, los estados, la auditoría y los errores.

### 15.1 Deuda que ya provoca fallos

| ID | Prio | Deuda | Consecuencia |
|---|---|---|---|
| F-001 | 🔴 P0 | Exportación no atómica | Facturas «exportadas» sin fichero |
| F-007 | 🟠 P1 | Rescate roto (actor «system», GET/POST, ANALYZING sin reproceso) | Error OCR falso o facturas que no salen de ANALYZING |
| F-008 | 🟠 P1 | El OCR escribe el estado sin condición | Rechazos y divisiones deshechos; doble contabilización |
| F-058 | 🟡 P2 | Dos tolerancias de cuadre | Facturas «listas» que la UI no deja validar |
| F-064 | 🟡 P2 | Alta de facturas duplicada en 4 sitios | periodType, cierre y deduplicación divergen |
| F-057 | 🟡 P2 | Incidencias que nunca se cierran | Facturas atascadas en «Con incidencias» |
| F-097 | 🟡 P2 | 37 `.catch(() => …)` sin log; actions que lanzan excepciones | Paneles a cero; cambios perdidos |

### 15.2 Deuda que impide escalar

| ID | Prio | Deuda | Bloquea |
|---|---|---|---|
| F-006 | 🟠 P1 | No hay capa de aislamiento; `?? undefined` | Cada consulta nueva es una fuga potencial |
| F-026 | 🟠 P1 | Unicidades globales | Clientes que cambian de asesoría |
| F-029 | 🟠 P1 | OCR en el proceso web sin cola | Cierres de trimestre con varias asesorías |
| F-030 | 🟠 P1 | Pantallas O(histórico) | Lotes deja de funcionar por encima de 65.535 facturas |
| F-031 | 🟡 P2 | Índices ausentes | Seq scans en cada revisión |
| F-129, F-123 | 🟢 P3 / 🟡 P2 | Cliente centinela; crons en serie y no idempotentes | Reglas que hay que recordar; correos masivos |

### 15.3 Deuda que frena el desarrollo y el soporte

| ID | Prio | Deuda | Efecto |
|---|---|---|---|
| F-032, F-033 | 🟠 P1 | Sin CI ni tests de integración | Las regresiones llegan a dev (22 fallos en curso) |
| F-056 | 🟡 P2 | Máquina de estados dispersa | Cada acción nueva repite reglas |
| F-048 | 🟡 P2 | Auditoría fuera de la transacción | Cambios sin rastro; falsas «cadenas rotas» |
| F-102 | 🟡 P2 | `ReviewForm.tsx` (2.674 líneas, 44 `useState`), actions de revisión (1.333), `processInvoice` (~600 líneas) | 9 de los 22 fallos en curso caen aquí |
| F-065 | 🟡 P2 | La clasificación manual reimplementa el pipeline | La misma factura sale distinta según el camino |
| F-124 | 🟡 P2 | ARCHITECTURE y DEPLOY desfasados | AGENTS.md obliga a leerlos y llevan a error |
| F-128, F-125, F-130, F-150 | 🟢 P3 | Configuración sin validar, claves que colisionan, scripts peligrosos, lint en rojo | Errores de configuración y ruido |

### 15.4 Orden de pago

1. **Arreglos de horas:** F-007, F-008, F-057, F-031, F-058 y el paso 1 de F-006 (`requireFirmSession()` que falla cerrado).
2. **Red de seguridad:** F-032 y F-033.
3. **Antes de la segunda asesoría:** F-006 completo, F-026 y F-001.
4. **Antes de 10 asesorías:** F-029, F-030 y F-097.
5. **De forma continua, detrás de los tests:** F-056 y F-048 (`transitionInvoice` y auditoría en la misma transacción), F-064 y F-065 (servicios únicos), F-102 (extraer por secciones, después de cerrar los fixes en curso).

**No es deuda y no se toca:**
- el formato del hash y los triggers;
- los módulos fiscales puros;
- `exportFormats.ts` (incluido «Cutoa Rec. Equiv.»);
- la reexportación por snapshot;
- el orden de la cola, recién estabilizado;
- `storage.ts` (Garage);
- `trustHost`;
- el Dockerfile.

`rejectBatch`, `assertUploadClientAccess` y `requireAdminFirm` son el patrón que hay que generalizar.

---

## 16. Funcionalidades que faltan

### Obligatorias antes de comercializar

| Funcionalidad | Por qué | Hallazgo | Esfuerzo |
|---|---|---|---|
| Exportación recuperable: primero el fichero, «Volver a descargar», «Anular lote» | Un fallo de descarga no puede ser irreversible | F-001 | M |
| Incidencias visibles y resolubles en la revisión | «Con incidencias» no sirve si no se ve cuál es | F-016, F-057 | S |
| Mínimos contables al validar, en servidor | Hoy se valida una factura vacía que luego desaparece del Excel | F-009, F-014 | S |
| Máquina de estados mínima (no validar SPLIT_SOURCE, OCR condicionado) | Doble contabilización | F-015, F-008 | S |
| Deduplicación con CIF normalizado y repetida al validar | Es el único control de duplicados funcionales | F-010 | S |
| Periodo contable efectivo o eliminado | Hoy el campo engaña | F-011 | S |
| Reprocesar atascadas + cron que funcione | Un redeploy puede bloquear un cierre | F-007 | S |
| Bajas de usuario, «Editar cliente» y reenviar invitación | Operación básica de una asesoría | F-028, F-046 | M |
| Notificaciones agrupadas y control de errores de envío | Sin esto, activar el correo es spam y pérdida de correos críticos | F-039, F-040 | S |

### Muy recomendables (primeros clientes)

| Funcionalidad | Hallazgo | Esfuerzo |
|---|---|---|
| Bandeja de exportación cliente × periodo, ZIP y permiso para gestores | F-041 | M |
| Validación asistida de «Verificadas» con criterios auditables | F-055 | M |
| Periodicidad por cliente y periodo por defecto inteligente | F-108 | M |
| Cola de OCR y «Reprocesar errores del lote» | F-029 | M |
| Lotes y paneles agregados en BD | F-030 | M |
| Aviso de destinatario distinto y de tipo invertido | F-019, F-020 | S |
| Plan de cuentas accesible al gestor con autocompletado | F-105 | M |
| Historial y notas en la revisión | F-106 | M |
| Alta masiva de clientes y asignaciones | F-054 | L |
| Aprendizaje completo tras «Por clasificar» | F-065 | S |

### Futuras (sin feature creep)

- «Pendiente del cliente»: una pregunta desde la revisión que llega al portal, en vez del rechazo como único canal (F-106).
- Buzón de correo por cliente para reenviar facturas.
- Importar el libro de emitidas desde el software de facturación del cliente.
- Facturas recurrentes esperadas: avisar de proveedores mensuales que faltan.
- Acciones masivas seguras en los listados (F-117).
- Estado de importación en A3, si A3 permite leerlo.

---

## 17. Automatizaciones / reducción de trabajo humano

Supuestos: asesoría mediana, 30 clientes, unas 3.000 facturas al mes y 3 gestores. **Son estimaciones sin telemetría**; hay que validarlas con métricas reales.

| Acción actual | Automatización propuesta | Ahorro estimado | Hallazgo |
|---|---|---|---|
| Abrir y validar una a una las facturas de proveedores recurrentes que cuadran | Subbandeja «Verificadas» (tercero con cuentas, cuadre exacto, sin incidencias, EUR, interior, fecha en periodo) y validación de la selección con auditoría | ~15 s × ~50 % del volumen ≈ **6 h/mes** | F-055 |
| Volver a teclear la contraparte cuando el tipo venía mal | `detectInvoiceType` siempre y relleno con los datos del OCR | ~1-2 min por factura; 3-5 % de las subidas ≈ **2-4 h/mes** | F-020 |
| Buscar qué incidencia tiene una factura | Bloque en la revisión y cierre automático al validar o rechazar | ~20-30 s por factura con incidencia | F-016, F-057 |
| Reprocesar a mano los Error OCR por 429 | Cola, backoff con Retry-After y reintento automático de los transitorios | ~30-45 s por factura; decenas al día en picos | F-029 |
| Elegir cliente y periodo en Exportar 30-60 veces al mes | Bandeja y ZIP, con periodo anterior por defecto | De **1-2 h/mes a ~10 min** | F-041 |
| Rehacer una exportación perdida con SQL | «Volver a descargar» y «Anular lote» | Horas de soporte por incidente | F-001 |
| Corregir en el Excel las facturas atrasadas | Columna B según el periodo contable | ~1 min por factura atrasada | F-011 |
| Cambiar mes y periodicidad en cada subida | Periodicidad en el cliente | ~10 s por subida y menos lotes rehechos | F-108 |
| Buscar en A3 la siguiente subcuenta libre | Autocompletado y propuesta de la siguiente 400/410/430 libre | ~30-60 s por tercero nuevo | F-105 |
| Corregir lo aprendido en las facturas clasificadas a mano | Aplicar el contexto del cliente tras clasificar | ~20-40 s por factura | F-065 |
| Investigar duplicados que rechaza A3 | Deduplicación con CIF y número normalizados en el OCR, al validar y al exportar | 5-15 min por duplicado | F-010, F-070 |
| Filtrar miles de correos de «validada» o «nueva factura» | Resúmenes; solo el rechazo es inmediato | De miles al mes a ~1 por cliente activo y día | F-040, F-123 |
| Diagnosticar un Error OCR en los logs de Coolify | Detalle técnico guardado y panel de diagnóstico | De 10-30 min a 1-2 min | F-035, F-053 |

---

## 18. Escalabilidad

### 18.1 Supuestos

- Por asesoría: ~2.000 facturas al mes, 5-10 usuarios y 50-150 clientes.
- Pico en los días previos a las declaraciones trimestrales.
- Unas 15-20 filas de BD y ~0,5 MB de fichero por factura.
- Un servidor Hetzner con un contenedor Next y Postgres y Garage en la misma máquina.

**Todo son proyecciones, no mediciones de producción.**

### 18.2 Proyección

| | 1 asesoría (hoy) | 10 | 50 | 100 |
|---|---|---|---|---|
| Facturas al año | ~24.000 | ~240.000 | ~1,2 M | ~2,4 M |
| Crecimiento de la BD al año | ~0,3 GB | ~3 GB | ~15 GB | ~35 GB |
| Ficheros en Garage al año | ~12 GB | ~120 GB | ~600 GB | ~1,2 TB |
| OCR simultáneos en el pico | 10-30 | 50-150 | 200-600 | 400-1.000+ |
| Correos al mes con el diseño actual | ~2.500-3.100 | ~31.000 | ~157.000 | ~314.000 |
| Lotes y panel (F-030) | 1-3 s a los 6-15 meses | Contención de CPU entre asesorías | Las asesorías grandes fallan (>65.535) | Inviable |
| Revisión sin índices (F-031) | Imperceptible | +50-300 ms | Segundos | BD saturada |
| Auditoría y panel admin (F-084, F-085) | Bien | 100-500 ms | Segundos | Inviable |
| Proceso Node único (F-126) | Bien | Picos de memoria y de pool | Saturado | Escalado horizontal obligatorio |

### 18.3 Dónde aparecen los primeros problemas

- **1 asesoría:**
  - exportaciones sin recuperación (F-001);
  - facturas atascadas tras cada Redeploy (F-007);
  - todos los PDF por la vía multimodal (F-013);
  - Lotes se vuelve lento con el histórico (F-030);
  - sin copias externas (F-003).
- **10 asesorías:**
  - aislamiento obligatorio (F-004, F-005, F-006, F-026);
  - seq scans (F-031);
  - picos de OCR sin techo con 429 y pool agotado (F-029, F-080);
  - plan de Resend y agrupación de avisos (F-040);
  - el onboarding manual pasa a ser el cuello de botella (F-054).
- **50 asesorías:**
  - AuditLog pasa de ~10 M filas al año (F-048, F-084);
  - la búsqueda y los listados sin periodo pesan (F-083, F-133);
  - hace falta un worker separado y varias instancias web, lo que rompe el rate limiter en memoria, los `after()` no durables y las cachés en memoria;
  - Garage en el mismo disco es un riesgo (ya llegó al 100 %).
- **100 asesorías:**
  - lo que es O(histórico) no se puede usar;
  - hay que desnormalizar `firmId`, particionar AuditLog e historial, repartir OCR por asesoría con cuotas (F-043) y usar S3 externo.

### 18.4 Cambios de arquitectura por umbral

| Antes de… | Imprescindible |
|---|---|
| Seguir con 1 asesoría | F-001, F-002, F-003, F-007, F-013; F-031 como higiene |
| La 2.ª asesoría / 10 asesorías | F-004/F-005/F-006/F-026/F-027; F-030; F-029 (semáforo y backoff); F-080; F-040; F-045 decidido |
| 50 asesorías | Worker separado (OCR, exportaciones, crons); multiinstancia (rate limiter en Redis o Postgres); pg_trgm (F-083); `firmId` desnormalizado; almacenamiento fuera del servidor |
| 100 asesorías | Particionado o archivado del historial; Postgres dedicado con réplica de lectura; cuotas por asesoría |

---

## 19. Observabilidad y soporte

**Veredicto.** Se registra bien el **negocio**: `InvoiceStatusHistory`, `AuditLog` inmutable, una fila de `InvoiceExtraction` por pasada, snapshot por export y códigos de error copiables. De la parte **técnica** casi nada: no hay `instrumentation.ts`, ni tracking, ni alertas, ni `/api/health`, y hay 19 `console.*` sin `invoiceId` (F-034, F-098).

Los dos mecanismos de recuperación automática están rotos (F-007) y la clasificación de errores puede dar un diagnóstico falso (F-035). Con una asesoría esto se aguanta porque el desarrollador mira los logs de Coolify; con 10-100 no escala.

### 19.1 «Esta factura no ha funcionado»: qué podemos saber hoy

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Qué ocurrió? | **Sí**, a nivel de estado, en la ficha del admin, pero sin quién hizo cada transición. El gestor no tiene ficha | `admin/invoices/[id]/page.tsx:103-113` (F-053, F-151) |
| ¿Dónde falló? | **Parcial.** Se sabe que fue «en el OCR», pero no si fue el proveedor, el storage, la BD o el código. Un fallo de auditoría posterior también aparece como Error OCR | `processInvoice.ts:642-657` (F-007) |
| ¿Por qué falló? | **No**, desde la app. Solo se guarda el mensaje amable, a veces falso: una API key inválida o un error de Prisma aparecen como «documento ilegible». La causa real está en stdout sin id de factura | `processInvoice.ts:651-656,666` (F-035) |
| ¿Qué datos entraron? | El fichero original sí. El texto enviado a la IA no. Los ficheros rechazados en la subida tampoco | `api/uploads/route.ts` (F-099) |
| ¿Qué resultado salió? | Con Document AI y Facturae, la respuesta cruda. Con **Gemini (el principal)**, solo la cabecera: sin líneas, sin modelo y sin `finishReason` | `ocrLlm.ts:485,507` (F-068) |
| ¿Qué se mandó a A3? | El snapshot sí, solo en BD. El Excel no, y no se puede volver a descargar | `api/export/route.ts:131-175` (F-069, F-001) |
| ¿Cuánto tardó? | `ocrDurationMs` de las pasadas con éxito. Ni fallos ni tiempo en cola. La métrica del banner está mal calculada | `processInvoice.ts:159-171` (F-152) |

### 19.2 Tiempo de diagnóstico estimado

| Incidencia | Hoy | Tras los quick wins |
|---|---|---|
| Factura en Error OCR | 10-30 min con acceso a Coolify, y solo si no ha habido un redeploy | 1-2 min en la ficha |
| Factura «En análisis» para siempre | No se puede reprocesar desde la UI; 15-60 min de un desarrollador con BD | Botón «Reprocesar» y alerta |
| Importe mal en A3 | 30-90 min con la BD; con Gemini y multi-IVA no se puede reconstruir | 5-10 min con extracción, valores finales y exportados en la ficha |
| «El Excel no se descargó» | UPDATE manual en la BD | Volver a descargar o anular el lote |
| «No me llega el correo» | Sin rastro: Resend devuelve `{ error }` y no se lee | Log con el error y el destinatario enmascarado |
| «He subido 30 y veo 27» | Sin rastro | Evento `upload_rejected` con su código |
| «No puedo entrar» | Se dice «contraseña incorrecta» aunque esté bloqueada | Mensaje correcto y desbloqueo por el admin |

### 19.3 Hallazgos

| ID | Prio | Evidencia | Hallazgo |
|---|---|---|---|
| F-007 | 🟠 P1 | HECHO VERIFICADO | Cron con «system» → Error OCR; GET frente a POST; ANALYZING sin reproceso; sin traza |
| F-034 | 🟠 P1 | HECHO VERIFICADO | Sin tracking, alertas ni health check real (`/login` responde 200 aunque la BD esté caída) |
| F-039 | 🟠 P1 | HECHO VERIFICADO | Errores de Resend invisibles (`lib/email.ts:30-34`) |
| F-035 | 🟡 P2 | HECHO VERIFICADO | Causa del error no guardada; clasificación por subcadenas |
| F-068 | 🟡 P2 | HECHO VERIFICADO | Sin respuesta, modelo ni `finishReason` de Gemini |
| F-053 | 🟡 P2 | HECHO VERIFICADO | La ficha del admin no sirve para diagnosticar |
| F-097 | 🟡 P2 | HECHO VERIFICADO | Errores que se tragan y se muestran como «sin datos» |
| F-098 | 🟡 P2 | HECHO VERIFICADO | Logs sin estructura, con datos personales y sin retención |
| F-099 | 🟡 P2 | HECHO VERIFICADO | Sin rastro de las subidas rechazadas |
| F-092 | 🟡 P2 | HECHO VERIFICADO | Un bloqueo se muestra como contraseña incorrecta |
| F-067 | 🟡 P2 | HECHO VERIFICADO | La auditoría solo cubre facturas |
| F-100 | 🟡 P2 | POSIBLE MEJORA | Sin vista de operador de plataforma |
| F-151 | 🟢 P3 | HECHO VERIFICADO | Huecos en el historial y actor invisible |
| F-152 | 🟢 P3 | HECHO VERIFICADO | Métricas de tiempo de OCR mal calculadas |
| F-153 | 🟢 P3 | HECHO VERIFICADO | Filtros de fecha de Auditoría por día UTC (**en curso**) |

### 19.4 Plan

**Fase 0 (≈2 días, sin dependencias nuevas):**
- actor real en el cron y fallo de auditoría que no reescriba el estado (F-007);
- reprocesar las facturas en ANALYZING con más de 5 min y corregir DEPLOY;
- `invoiceId` en los logs y detalle técnico saneado (F-035);
- respuesta de Gemini en `rawResponse` sin migración (F-068);
- leer `{ error }` de Resend (F-039);
- registrar los rechazos de subida (F-099).

**Fase 1 (antes del 2.º al 5.º cliente):**
- `/api/health` con `SELECT 1` y `HeadBucket`, `instrumentation.ts` con `onRequestError` hacia GlitchTip, Sentry o un webhook, y monitor externo;
- alertas por OCR_ERROR por hora, facturas atascadas más de 15 min y disco por encima del 80 % (F-034);
- panel «Diagnóstico» en la ficha (F-053);
- log JSON con rotación (F-098).

**Fase 2:** auditoría de eventos de asesoría (F-067), verificación nocturna de la cadena (F-048) y vista de operador (F-100).

**No tocar:**
- el formato del hash de `AuditLog`;
- el prefijo `[ERR-OCR-XXX]`, que la revisión parsea;
- los códigos ERR-* ya publicados;
- el JSON del snapshot;
- la clave `boundingBoxes`.

Todo lo nuevo va en columnas o tablas nuevas. OpenTelemetry y colas externas todavía no hacen falta.

---

## 20. Roadmap pre-comercialización

Las duraciones son estimaciones de los especialistas, no medidas. Las fases se solapan: la pista legal (F-038, F-037) empieza el primer día y va en paralelo.

### FASE 0: bloqueantes
**Objetivo:** que el piloto actual deje de estar expuesto y que sea aceptable firmar con una asesoría nueva.
**Criterio de salida:** los 5 P0 cerrados, una restauración de backup hecha en limpio y el contrato de encargado listo para firmar.
**Duración orientativa:** 1 a 2 semanas.

| Hallazgo | Acción | Esfuerzo |
|---|---|---|
| 🔴 F-003 (+F-036 §3) | Backups externos de BD y bucket, restauración probada, alertas; reescribir `DEPLOY.md` §3 | S |
| 🔴 F-002 | Servir `/raw` en lista blanca con `attachment` y `sandbox`; validar Facturae al subir | XS |
| 🔴 F-001 + 🟠 F-017 (+F-049, F-071, parte export de F-009) | Primero el mínimo inmediato; después la exportación atómica con reserva, re-descarga, anulación y POST | XS → M |
| 🔴 F-005 | Filtro por asesoría en «Subir facturas» | XS |
| 🔴 F-004 + 🟠 F-006 + 🟠 F-026 (decisión F-045) | Cerrar los 7 accesos, cortar `?? undefined`, CIF único por asesoría. Obligatorio antes de la segunda asesoría en la misma instancia | S–M |
| 🟠 F-038 + F-037 | Condiciones, contrato de encargado, subencargados, privacidad; verificar la facturación de Gemini | S (legal) |

### FASE 1: antes de los primeros clientes externos
**Objetivo:** que los datos contables que salgan hacia A3 sean fiables sin depender de la atención del gestor, y que el equipo se entere cuando algo falla.
**Criterio de salida:** todos los P1 cerrados o con una excepción aceptada por escrito.
**Duración orientativa:** 2 a 3 semanas.

- **Red de seguridad primero:** F-033 (harness de integración), F-027 (matriz de aislamiento entre asesorías), F-032 (vitest en el build y pipeline).
- **Integridad de estados:** F-008, F-015 (y F-050 como quick win P2).
- **Precisión contable:**
  - validación y exportación: F-009, F-014, F-022, F-025 (con F-058);
  - OCR y enrutado: F-012 → F-013, F-019, F-021, F-060;
  - duplicados: F-010 (con F-057);
  - periodos y régimen: F-011 y F-023, que exigen antes una sesión con el asesor y una importación de prueba en A3;
  - trazabilidad y reexportación: F-018, F-024.
- **Revisión:** F-016, F-047.
- **Operación:** F-007, F-034, F-036, F-039, F-040.
- **Usuarios y datos:** F-028, F-046, F-044, F-042, F-043 (informe mínimo de uso y `status`).
- **Exportación (parte P1):** F-041.
- **Rendimiento mínimo:** F-030 (año por defecto, `select` mínimo) y F-031 (índices).

### FASE 2: primeras semanas comercializando
**Objetivo:** aguantar varias asesorías a la vez sin soporte diario del desarrollador.

- **Escala y robustez:** F-029 (semáforo, backoff, reintentos), F-080, F-081, F-082, F-084, F-085, F-086, F-087, F-132.
- **Transacciones y modelo:** F-048, F-056, F-061, F-062, F-063, F-064, F-065, F-066, F-067, F-069, F-070, F-129 (`realClientWhere`), F-155.
- **Observabilidad y soporte:** F-035, F-053, F-068, F-097, F-098, F-099, F-121, F-123, F-149, F-151, F-152.
- **Seguridad:** F-090, F-091, F-092, F-093, F-094, F-096, F-131.
- **Contable (con el asesor):** F-051, F-059, F-072, F-073, F-074, F-075, F-076, F-077, F-079.
- **UX y productividad:** F-020, F-041 (bandeja y ZIP), F-052, F-054, F-101, F-107, F-108, F-109, F-110, F-111, F-112, F-113, F-114, F-115, F-116, F-120, F-122.
- **Documentación e higiene:** F-124, F-130, F-138, F-145, F-150.

### FASE 3: escalado a 10-100 asesorías
- Cola persistente y proceso worker separado del web (F-029, F-126).
- Capa central de aislamiento con `$extends` o RLS, y `advisoryFirmId` desnormalizado en `Invoice` y `AuditLog` (F-006, F-027, F-031).
- Agregados y búsqueda en BD con `pg_trgm` (F-083, F-133).
- Planes, límites, facturación y suspensión (F-043). Panel de operador (F-100). Alta en autoservicio (F-042, F-054).
- Dominio neutro y marca por asesoría (F-045, F-120).
- Refactor incremental de `ReviewForm` y `parseAndSave` hacia `src/lib`, precedido de tests de caracterización (F-102).
- Validación asistida con criterios verificables (F-055), acciones masivas (F-117), paneles accionables (F-118), plan de cuentas para el gestor (F-105), notas e historial (F-106), longitud de cuenta configurable (F-078).
- Infraestructura separada de dev y producción, e imagen construida fuera del servidor.
- CSP con nonces (F-095), limpieza de componentes duplicados (F-137) y el resto de P3.

---

## 21. Plan de ejecución recomendado

El orden tiene en cuenta dependencias y exposición actual. Los pasos 1 a 13 cierran la Fase 0. El paso 6 corre en paralelo desde el primer día.

1. [P0] **F-003**: hoy mismo, comprobar qué hay activado en Coolify y Hetzner; activar Hetzner Backups, backup diario de Postgres a S3 externo en la UE, sync nocturno versionado del bucket `facturas` y alertas de fallo. Va primero porque todos los pasos siguientes tocan producción.
2. [P0] **F-002**: servir `/raw` con lista blanca inline, `attachment` para el resto y `Content-Security-Policy: sandbox`. Neutraliza también los XML maliciosos que ya estén guardados.
3. [Quick Win] **F-017 + mínimo de F-001**: nombre de fichero ASCII más `filename*`, `appendAuditLogs` en tandas de 25 dentro de `try` y texto de ERR-EXPORT-002. Corta hoy la pérdida determinista.
4. [P0] **F-005**: `getAccessibleClientIds` en «Subir facturas».
5. [Quick Win] **F-032 (parte inmediata)**: `RUN npx vitest run` en el builder del Dockerfile; arreglar o borrar el smoke E2E; quitar `clear-invoices`. Así los cambios siguientes ya pasan por una barrera.
6. [P1] **F-038 + F-037**, pista legal en paralelo: encargar condiciones, contrato de encargado, anexo de subencargados y privacidad; verificar la facturación de la clave de Gemini; hacer `/legal` pública con los datos de la LSSI.
7. [Quick Win] **F-007**: crons con GET y POST y documentación corregida; actor real o sin `AuditLog`; historial y auditoría fuera del `try`; reprocesar `ANALYZING` > 10 min; `exec node …` y gracia de al menos 120 s.
8. [Quick Win] **F-039**: leer `{ error }` de Resend. Tiene que estar antes de activar el correo.
9. [P1] **Sesión con el asesor e importación de prueba en el A3 del piloto**: regla de la columna B (F-011); códigos 3, 4 y 8 al 0 % y al 21 % (F-023); recargo en compras (F-051); ventas con ISP o exentas (F-079); sufijo `_R` (F-075). Desbloquea los pasos 22 y siguientes.
10. [P1] **F-033**: harness de integración con BD real, con guarda de entorno, factorías de dos asesorías y mocks solo de lo externo. Es prerrequisito de los pasos 11, 12 y 26.
11. [P0] **F-001 completo** (+F-049, parte export de F-009, F-071, F-127): generar antes de escribir; `$transaction` con timeout explícito; `updateMany` con `exportBatchId: null` y comprobación de `count`; auditoría en bloque con el mismo `computeAuditHash`; no marcar las excluidas; re-descarga desde el snapshot; anular lote; POST; tests de fallo simulado y de concurrencia.
12. [P0] **F-004 + F-006 + F-027**: decidir antes el modelo de despliegue (F-045). Después, `canAccessClient` en los 7 sitios, borrar `/api/search`, `requireFirmSession()`, matriz de tests con dos asesorías y migración con `ExportBatch.advisoryFirmId` (número acordado con Zuhir).
13. [P1] **F-026**: migración `@@unique([advisoryFirmId, cif])`, adaptar a la vez `getOrCreateUnclassifiedClient`, mensajes neutros y decisión sobre el login. **Aquí termina la Fase 0.**
14. [Quick Win] **F-008 + F-015**: fencing token en `processInvoice`, estados de origen permitidos, bloqueo de acciones en `UPLOADED`/`ANALYZING`, `SPLIT_SOURCE` en solo lectura. Es la base de F-056.
15. [Quick Win] **F-009 + F-014 + F-022 + F-025** (+F-058): reglas de validación en servidor con una sola tolerancia de cuadre, control por línea y severidad de los avisos.
16. [Quick Win] **F-012**: no invertir el signo por texto; Abono, Al alza o Sustitución de forma explícita; auditar. Tiene que ir antes del paso 17.
17. [Quick Win] **F-013**: worker de pdfjs validado con `next build`, log del `catch`, test. Reactiva heurísticas, así que hay que revisar F-021 y F-073.
18. [Quick Win] **F-010 + F-057**: normalizar NIF y número, repetir la comprobación al validar, cerrar incidencias en validar, rechazar y reprocesar, y que el listado de admin lea `InvoiceIssue`.
19. [Quick Win] **F-016**: bloque de incidencias en la revisión con acciones, y confirmación al validar con un duplicado abierto.
20. [Quick Win] **F-047**: `isDirty`, navegación con guarda y `beforeunload`.
21. [Quick Win] **F-019 + F-021**: aviso de receptor distinto; regla de proveedor solo con `no_cif`/`invalid_cif` y después del texto; rastro del enrutado.
22. [P1] **F-011**: implementar la regla acordada en el paso 9 (columna B, filtro, huella sin reexportación masiva, cierre coherente), o quitar el campo.
23. [Quick Win] **F-024**: completar `trackedFields` y las entradas `auto:*`, sin tocar el hash.
24. [P1] **F-018**: reexportadas en la vista previa, con diferencias, confirmación y recuento global.
25. [Quick Win] **F-034**: `/api/health`, `instrumentation.ts` con `onRequestError`, monitor externo y alertas.
26. [Quick Win] **F-036**: `pg_dump` externo automático antes de cada Redeploy con migraciones, runbook de restauración y health check en Coolify.
27. [Quick Win] **F-040**: agrupar avisos y resumen al cliente. Después, activar Resend con el dominio verificado.
28. [P1] **F-028**: `disabledAt`, `sessionVersion`, «Dar de baja» y restablecimiento de contraseña por el admin.
29. [P1] **F-046**: editar cliente y reenviar la invitación. Depende de los pasos 8 y 27.
30. [P1] **F-044**: borrado de lo no validado, exportación completa por cliente o asesoría, procedimiento de baja y retención.
31. [P1] **F-043**: informe mensual de uso con los datos que ya existen y `AdvisoryFirm.status`.
32. [Quick Win] **F-042**: script de alta transaccional y sin valores por defecto.
33. [P1] **F-041 (parte P1)**: aviso de facturas sin validar, periodo anterior por defecto, botón Exportar en Lotes y Cierres, «T3» en el nombre.
34. [P1] **F-029 (corto plazo)**: semáforo global, backoff con jitter y `Retry-After`, reintento de errores transitorios.
35. [P1] **F-030 + F-031**: índices en migración nueva, lotes y paneles agregados en BD, `AutoRefresh` con back-off.
36. [P1] **F-032 completo**: pipeline con vitest, eslint con baseline, `migrate deploy` sobre BD vacía e imagen construida fuera de producción. **Aquí termina la Fase 1.**
37. [P2] Fase 2 en bloque según la sección 20, empezando por F-048 (auditoría serializada y en la misma transacción) y F-056 (`transitionInvoice` común), que aprovechan el trabajo de los pasos 11 y 14.

---

## 22. Lo que NO tocaría

### Funciona: construir alrededor, no dentro

| Qué | Por qué | Condición para tocarlo |
|---|---|---|
| `computeAuditHash` (campos, separador `\|`, ISO con ms y `Z`), cadena por factura y triggers de `00000000000001_audit_immutability` | Cualquier cambio invalida la verificación de todas las filas existentes, que no se pueden reescribir | Nunca. F-001 y F-048 añaden bloqueo, secuencia y transacción alrededor |
| `A3_HEADERS`: orden, **«Cutoa Rec. Equiv.»**, «Fecha de Contabilizacion» sin tilde, «Nif» | A3 las empareja por nombre según su plantilla oficial (AGENTS.md) | Nunca |
| `buildA3Row`: una fila por tipo, IRPF en la primera, recargo por línea, `_R`, NIF con prefijo del tercero, importes numéricos y NIF, cuentas y número como texto | Está validado con el asesor y con importaciones reales, y la huella depende de ello | Solo cambios de valor acordados (F-011, F-075), con plan para la huella |
| `exportFingerprint` y claves JSON de `ExportBatchItem.snapshot` | Deciden si una corrección obliga a reexportar, comparando con snapshots históricos | Solo **añadir** claves a sabiendas; nunca renombrar ni quitar |
| Criterio exportada / por reexportar (historial más puntero) y bloqueos de rechazar, dividir o mover exportadas | Es coherente en todas las pantallas y protege lo que ya está en A3 | No hacerlo |
| Módulos puros con tests: `equivalenceSurcharge`, `intracomGoods`, `accountingAccount`, `supplierMatching` (`accountEntryKey`, `cleanKey`, `entryNameMatches`) con `taxIdWithCountry`, `invoiceNumbering`, `reviewNavigation`, `routeByCif`/`routeByText`/`detectInvoiceType` | Recogen casos fiscales reales (Parlem, Farmacia Aguacate, NIF compartidos) y están cubiertos | Refactorizar alrededor. F-060 solo cambia la entrada de `equivalenceSurcharge`; F-021 se arregla en la orquestación |
| Claim atómico `UPLOADED→ANALYZING` en `processInvoice` | Evita pagar dos OCR por la misma factura | Cualquier cola (F-029) o reproceso (F-007) tiene que pasar por él |
| `rejectBatch`, `assertUploadClientAccess`, `canAccessClient`/`getAccessibleClientIds`, `requireAdminFirm` | Son los patrones correctos: transacción con filtro repetido y fallo cerrado | Generalizarlos, no reescribirlos |
| Parte del cliente forzada en servidor (`processInvoice`, `parseAndSave`) y `parseAndSave` como único paso a `VALIDATED` | Garantía de integridad frente a manipulación | F-019, F-020 y F-009 **añaden** avisos y reglas ahí; no se quita el forzado |
| Flujo de restablecimiento de contraseña | Bien diseñado: no revela cuentas, token de un solo uso, transacción | Reutilizarlo para invitaciones; solo guardar el token con hash (F-093) |
| Deduplicación por hash, validación por magic bytes y pool de 3 subidas en el navegador | Funcionan y dan mensajes útiles | F-061 añade atomicidad; no subir la concurrencia |
| Catálogo `errorCodes.ts`, prefijo `[ERR-OCR-XXX]` (lo parsea `ReviewForm.tsx:1376`), filas de `InvoiceExtraction` y clave `boundingBoxes` | Los usuarios copian esos códigos a soporte, y la extracción de cajas depende del formato | Añadir códigos y claves; no renumerar ni borrar |

### Peligroso de tocar ahora

| Qué | Por qué | Hasta cuándo |
|---|---|---|
| Migraciones aplicadas `00000000000000` a `00000000000009` | AGENTS.md; están en producción | Nunca editarlas. Las nuevas llevan el número acordado con Zuhir (la 10 es suya) |
| Bypass `app.allow_audit_mutation` con `SET LOCAL` en `demoSeed` y `ALLOW_DEMO_RESET` | Es el único agujero legítimo del trigger, y el reset borra tokens de todas las asesorías (F-131) | No reutilizarlo para F-007, migraciones ni bajas RGPD (F-044 va con su propio procedimiento). Nunca activarlo en producción |
| `ReviewForm.tsx` (2.674 líneas) y `review/[id]/actions.ts` como refactor de golpe | Concentran 9 de los 22 arreglos en curso y no hay E2E | Después de F-033 y de tests de caracterización (F-102), sección a sección |
| Cola de revisión (`QUEUE_ORDER`, `nextPendingAfter`, `getQueuePosition`) y paginación de listados (`invoicePageIds`, `invoiceOrderBy`) | Arreglos en curso (fix #0 Posponer, #11 paginación) | Hasta integrar esos arreglos; F-083 y F-133 se coordinan con el #11 |
| Semántica de `useReviewShortcuts` (Enter solo fuera de campos, Ctrl+Enter siempre) y teclado del `Select` propio | Cada regla viene de una validación accidental en producción | F-047 añade la guarda de navegación y nada más |
| `clientStatus.ts` / `CLIENT_STATUS_BADGE` | El usuario lo está moviendo en el árbol de trabajo (`D clientStatus.ts`) | Hasta que termine esa tarea |
| `getOrCreateUnclassifiedClient` (upsert por CIF global) | Depende del `@unique` global | Solo a la vez que F-026 |
| Decisión de no ofrecer «Validar en bloque» a ciegas (`admin/invoices/actions.ts:11-18`) | Validar sin abrir es justo lo que el producto debe impedir | Solo con criterios verificables y auditados (F-055) |
| FK `RESTRICT` del historial legal, convención `''` en `AccountEntry`, valores `ANALYZED`/`EXPORTED` del enum | Protegen el historial; la migración 9 depende de la convención; PostgreSQL no deja quitar valores de un enum | Bajas lógicas (F-028); `CHECK` en lugar de borrar valores (F-155) |

### Deuda aceptable por ahora

| Qué | Por qué se acepta |
|---|---|
| Rate limiter en memoria (`rateLimit.ts`) | Es correcto con una sola instancia. Redis solo si se escala a varias réplicas |
| `storage.ts` (`WHEN_REQUIRED`, `forcePathStyle`) y `auth.ts` (`trustHost: true`) | Son necesarios para Garage y para el proxy de Coolify. «Limpiarlos» rompe subidas y login |
| Dockerfile con `node_modules` de producción completos y `migrate deploy` al arrancar | Es la forma que funciona para tener el CLI de Prisma. `standalone` es frágil y no aporta nada ahora |
| Escala `blue-*` redefinida en `globals.css` | Todo el producto hereda la marca de ahí. F-111 cambia pares concretos |
| Valores guardados en `AuditLog` | Son inmutables. F-113 corrige solo la presentación |
| Tabla `Document` que solo se escribe (F-154) y cliente centinela «Sin clasificar» (F-129) | Son incómodos pero no rompen nada. Primero `realClientWhere`; el rediseño va en Fase 3 |
| Sin OpenTelemetry, colas gestionadas ni servicio de logs como requisito | Es un solo servidor y un equipo pequeño. Los quick wins de F-034 cubren la mayor parte. AGENTS.md pide justificar cada paquete |
| Los 19 ficheros de `tests/unit` y la regla «no mockear Prisma» | Están en verde, son rápidos y codifican reglas fiscales. Se amplían, no se reescriben. No hay que perseguir un porcentaje de cobertura global |

---

## 23. Resultado del Devil's Advocate

El abogado del diablo presentó 22 argumentos contra comercializar y cada uno se verificó de forma independiente sobre la copia del commit. **Resultado: 11 argumentos válidos, 8 riesgos aceptables y 3 falsos positivos.** Los falsos positivos no figuran como problemas en este informe.

**DA-01 · La exportación marca antes de entregar y un carácter del nombre la rompe siempre.** → **Argumento válido** (F-001, F-017).
Se reprodujo con Node 22.14 y el `next/server` del proyecto: `’`, `–` y `€` dan TypeError y `%` da URIError. No hay vía de recuperación en la UI. Matices: los caracteres problemáticos son poco frecuentes, el timeout solo afecta a lotes grandes, y exportar «todos los clientes» no se puede hacer desde la UI. Aun así, el diseño convierte cualquier fallo en pérdida irrecuperable, y el arreglo es barato.

**DA-02 · XSS almacenado desde el portal del cliente.** → **Argumento válido** (F-002).
Cada eslabón se comprobó en el código. Hace falta un clic del gestor, y hoy puede que haya pocos clientes con acceso al portal. Incluso dentro de una sola asesoría el daño es grave. Además convierte los agujeros aparcados en explotables por un externo. La mitigación es XS, así que no tiene sentido asumir el riesgo.

**DA-03 · La recuperación de facturas atascadas está rota por dos caminos.** → **Argumento válido** (F-007).
Confirmados el 405 y la FK. Agravante: la clasificación como «ilegible» es falsa. Matices: sí existe una salida manual (rechazar y volver a subir); el cron, si se configura con GET, deja las facturas en un estado reprocesable; y con el volumen actual los atascos serán casos sueltos. El impacto real es medio, no medio-alto.

**DA-04 · La detección de duplicados no funciona con proveedores europeos ni con NIF con prefijo.** → **Argumento válido** (F-010).
Simulado con el `parseTaxId` real. Matices: los NIF españoles sin prefijo sí casan. En las compras intracomunitarias con inversión del sujeto pasivo el efecto en el 303 es neutro y el daño está en el gasto y en el 349. En emitidas también hace falta normalizar. El esfuerzo es S, no «una línea».

**DA-05 · El «Periodo contable» es decorativo y rompe el cierre.** → **Argumento válido** (F-011).
Todo lo que el abogado da por hecho está en el código. La frecuencia está inflada: afecta a una minoría de compras tardías, en ventas la fecha de la factura es correcta y existe el aviso «Fecha fuera del periodo del lote». El verificador lo bajaría a P2. Se mantiene en P1 porque la pantalla promete algo que no hace.

**DA-06 · No se puede dar de baja a un gestor.** → **Riesgo aceptable** (F-028, que se mantiene en P1).
Los hechos se confirman. Pero desasignar los clientes corta el acceso a los datos fiscales, porque los permisos del gestor se consultan en vivo. Queda el remedio manual (`lockedUntil`, `bootstrap-admin` para un segundo ADMIN). Hay que resolverlo antes de la primera baja real o de la segunda asesoría.

**DA-07 · Cualquiera puede bloquear cuentas y enumerar usuarios.** → **Argumento válido** (F-092, F-091).
El bloqueo por terceros es real: 3 intentos, contador que no se reinicia y unas 4 peticiones por hora bastan. La enumeración por el mensaje `ACCOUNT_LOCKED` es **falsa**, porque Auth.js envuelve el error y el aviso de bloqueo nunca llega a la pantalla. Solo queda una enumeración débil por tiempo de respuesta. Consecuencia añadida: un usuario legítimo bloqueado ve «contraseña incorrecta» durante 15 minutos.

**DA-08 · El aislamiento depende de la disciplina de cada consulta y ya falla.** → **Argumento válido** (F-004, F-006, F-026, F-027).
Confirmado el ataque encadenado: `/api/search`, luego `/raw`, luego el PDF de otra asesoría. Los 22 `?? undefined` no son una fuga activa, porque todas las altas asignan asesoría. Un usuario CLIENT no puede aprovechar los agujeros por sí solo (aunque sí con DA-02). La frase del informe interno sobre tests de aislamiento es falsa. Es asumible mientras solo exista MS Assessors.

**DA-09 · Todo en un servidor, sin copia externa documentada.** → **Argumento válido** (F-003, F-036).
Confirmado con la documentación y las notas del equipo; el propio equipo reconoce que no hay backups definidos. Exageraciones: la instrucción `migrate reset` estaba atada al primer despliegue (aun así es una trampa); el bucle de reinicios es un fallo seguro; existe un health check `/login`, aunque débil. La configuración real de Coolify no se ha visto. Como el impacto no depende del volumen y el arreglo es barato, es un argumento válido.

**DA-10 · Las pantallas principales cargan todo el histórico y el OCR no tiene cola.** → **Riesgo aceptable** (F-030, F-029, que se mantienen en P1).
Los hechos se confirman. Pero el panel del admin solo selecciona el estado, el inicio del gestor filtra por sus clientes, el OCR no retiene conexiones de BD y un fallo de auditoría acaba en `OCR_ERROR` visible y recuperable. La degradación es gradual. No bloquea vender al volumen actual.

**DA-11 · La exportación no bloquea nada y oculta avisos.** → **Riesgo aceptable** (F-025, que se mantiene en P1).
El recorte a 20 cuenta facturas con todos sus avisos, y como se exporta por cliente y periodo rara vez se supera. La fecha vacía y el NIF sin prefijo los rechaza A3 de forma visible. La moneda extranjera ya tiene dos avisos. El único error de verdad silencioso exige ignorarlos todos. No avisar de los bloqueantes es una decisión documentada.

**DA-12 · La exportación es un GET con efectos y sin `clientId` obligatorio.** → **Argumento válido** (F-071).
Confirmado: sin parámetros marca todas las facturas pendientes de la asesoría y genera un único Excel que mezcla empresas, con el nombre del primer cliente. La cookie `SameSite=Lax` viaja en la navegación. El daño se queda dentro de la asesoría y la probabilidad es baja. Pero es la clase de hallazgo que un pentest marca, deja entradas «Exportada» falsas e imborrables en la auditoría y se arregla en esfuerzo XS.

**DA-13 · La «auditoría inmutable» es más débil de lo que se dice.** → **Riesgo aceptable** (F-048, F-067).
Confirmado: hash sin secreto, el rol de la app es dueño del esquema, solo se auditan facturas y las reaperturas se pierden. Es **falso** que los lotes de exportación no dejen rastro: cada factura exportada tiene su entrada. Para su uso real, que es saber quién cambió qué en una factura, funciona. Pasaría a argumento válido si se vendiera como «inmutable» ante auditores técnicos.

**DA-14 · No hay marco legal para cobrar.** → **Argumento válido** (F-038, F-037, F-044).
El art. 28.3 RGPD aplica con un solo cliente de pago. Matices: Vertex en la UE no es obligatorio (sí verificar la facturación de la clave), la devolución y supresión pueden ser un procedimiento manual descrito en el contrato, y la falta de cifrado por campo no es bloqueante. El remedio es sobre todo documental y el usuario ya tiene preparada la base técnica.

**DA-15 · No hay producto SaaS alrededor de la app.** → **Argumento válido**, sobre todo por el correo (F-039, F-040, F-046, F-042).
Sin Resend, las invitaciones y los resets desaparecen sin aviso y no se pueden reenviar. `admin` choca como username en una segunda alta. La parte de superadmin, planes y cobro es un riesgo aceptable con 10 asesorías. El esfuerzo real es S-M, menor de lo que dice el argumento.

**DA-16 · No hay red de seguridad contra regresiones.** → **Riesgo aceptable** (F-032, F-033, que se mantienen en P1).
Confirmado: sin CI, sin tests de BD, E2E roto en 2 de 5 y documentación falsa sobre los tests. Exagerado: los «22 fallos» son 21 distintos, en su mayoría de interacción, y se detectaron en dev antes de llegar a `main`. El núcleo fiscal sí está cubierto. Se puede asumir si se hace CI con vitest, se arregla el smoke y se escriben unos pocos tests de integración.

**DA-17 · Cobertura parcial de regímenes de IVA.** → **Riesgo aceptable** (F-079, F-060).
En ventas solo hay Interior, Entrega intracomunitaria y Exportación. Prorrata, criterio de caja, REBU y bienes de inversión no corresponden a una herramienta de captura. Es aceptable **solo si se vende con alcance explícito**: pymes de comercio y servicios en régimen general o recargo. Venderlo como genérico lo convertiría en argumento válido.

**DA-18 · La resubida del cliente no comprueba el cierre y pierde el `periodType`.** → **Riesgo aceptable** (F-063).
Es real y frecuente. Pero la factura no se puede validar en un periodo cerrado y la exportación trimestral la recoge por rango de meses. El daño es confusión en la interfaz y una factura atascada. El arreglo son dos líneas, y el mismo cambio sirve para las hijas de una división.

**DA-19 · La factura electrónica B2B obligatoria desplaza el OCR.** → **Riesgo aceptable** (estratégico).
Las citas del documento interno son exactas, pero es una nota de trabajo y no una hoja de ruta. La lectura de Facturae XML ya existe. Verifactu no aplica a una herramienta de recepción, y tickets y facturas extranjeras siguen necesitando OCR. Mitigación: contratos mensuales, precio por cliente gestionado y posicionarse como «captura, revisión y exportación» en lugar de «OCR».

**DA-20 · El middleware no aplica los roles.** → **Falso positivo.**
`ROLE_ROUTES` es inefectivo, pero 13 de las 15 páginas de admin y las 18 server actions comprueban el rol, y las dos páginas restantes solo pintan formularios cuyas acciones están protegidas. Se pierde una capa de defensa en profundidad, no hay fuga.

**DA-21 · Las fechas del Excel salen con la hora local del servidor.** → **Falso positivo** como riesgo real.
Las fechas se guardan a medianoche UTC y el contenedor corre en UTC; incluso con hora de Madrid el día no cambia. Queda solo como robustez menor en F-143 (P3).

**DA-22 · `parseAndSave` dividiría por mil los importes con formato español.** → **Falso positivo.**
Ninguna ruta de la UI envía «1.234,56»: los campos son `type="number"` y el pegado desde el PDF ya normaliza el formato. Solo se reproduce llamando a la acción a mano, y solo con datos de la propia asesoría.

### Alegato final del abogado del diablo (resumido)

> Faktury funciona hoy porque tiene un único cliente amigo y a su desarrollador al lado; eso no es lo mismo que estar listo para cobrar a desconocidos. Lo más grave no son detalles de interfaz, sino fallos en lo que el producto promete. La exportación a A3 marca antes de generar y un simple apóstrofo en el nombre del cliente se come cada exportación. Un cliente del portal puede ejecutar código en la sesión del gestor. La detección de duplicados no funciona con proveedores europeos. El periodo contable no llega al Excel. La recuperación de facturas atascadas está rota. No se puede dar de baja a un exempleado. Y los PDF, que hay que conservar entre 4 y 6 años, viven en un solo servidor sin copia externa documentada. La conclusión no es «nunca», sino «todavía no»: casi todo lo bloqueante es barato, son días y no meses. Firmar con un segundo cliente antes de cerrar al menos DA-01, DA-02, DA-08 y DA-09 sería vender un sistema que puede perder en silencio el trabajo del asesor, filtrar datos entre despachos y desaparecer con un disco. Y los informes internos afirman que el aislamiento está cubierto por tests, cuando ningún test toca la base de datos.

**Posición de la auditoría.** Estamos de acuerdo con el alegato. Los cuatro argumentos que cita como condición mínima (DA-01, DA-02, DA-08, DA-09) coinciden con los P0 de la sección 3. Los riesgos aceptables no son motivo para retrasar la venta, pero todos tienen un hallazgo asociado en el roadmap.

---

## 24. Conclusión final

### «Si mañana llega una gestoría dispuesta a pagar por Faktury, ¿la aceptarías como cliente?»

**Solo como piloto. Y no mañana: cuando esté cerrada la Fase 0.**

Condiciones para aceptarla:
1. **Los 5 P0 cerrados:**
   - exportación atómica con re-descarga (F-001, F-017);
   - `/raw` con `sandbox` (F-002);
   - backups externos con una restauración probada (F-003);
   - filtro en «Subir facturas» (F-005);
   - los 7 accesos entre asesorías cerrados (F-004) junto con F-006 y F-026, si va a compartir instancia. Si no, instancia y BD separadas mientras tanto (F-045).
2. **Contrato firmado:** condiciones del servicio y contrato de encargado con anexo de subencargados (Hetzner, Google, Resend), y la clave de Gemini con facturación activa comprobada (F-038, F-037).
3. **Alcance fiscal por escrito:** pymes de comercio y servicios en régimen general o recargo de equivalencia. Sin ISP emitida ni ventas exentas hasta confirmar los códigos con el asesor (F-079, DA-17).
4. **Régimen de piloto:**
   - onboarding hecho por el equipo (F-054), incluidos el plan de cuentas y las asignaciones;
   - contrato mensual y sin permanencia (DA-19);
   - revisión humana de cada factura, sin validación en bloque;
   - canal directo con el desarrollador;
   - volumen acotado mientras no estén F-029 y F-030.
5. **Compromiso de Fase 1 con fecha:** las correcciones de integridad y precisión contable (F-008, F-009, F-010, F-012, F-014, F-015, F-011) cerradas antes de su primer cierre trimestral en Faktury.

Con estas condiciones es razonable aceptar unas pocas asesorías más. Sin la Fase 0 cerrada, la respuesta es **no**.

### «¿Qué 5 cosas harías esta misma semana para acercar Faktury al estado comercial?»

1. **Asegurar los datos (F-003).** Comprobar qué tienen activado Coolify y Hetzner. Activar backups diarios de Postgres a S3 externo en la UE y la sincronización versionada del bucket `facturas`. Hacer una restauración de prueba en limpio. Reescribir `DEPLOY.md` §3 para que `migrate reset` no se pueda aplicar contra producción. Es lo único cuya ausencia puede acabar con el negocio de un golpe.
2. **Cerrar las dos fugas XS (F-002 y F-005).** Servir `/raw` con lista blanca, `attachment` y `Content-Security-Policy: sandbox`, y filtrar por asesoría la lista de clientes de «Subir facturas». Con eso se cierra lo que hoy puede explotar un cliente del portal y la fuga que aparecería sola con la segunda asesoría.
3. **Parar la pérdida en la exportación (F-017 y mínimo de F-001).** Nombre de fichero ASCII más `filename*`, auditoría en tandas de 25 y mensaje de error que no invite a reintentar. Empezar el rediseño completo: generar primero y escribir después, en una transacción con reserva atómica y re-descarga.
4. **Poner una red mínima de operación (F-032, F-007, F-039).**
   - `vitest` en el Dockerfile para que un test roto no llegue a desplegarse;
   - crons con el método correcto y un actor real para que el rescate de facturas atascadas funcione;
   - leer los errores de Resend antes de activar el correo.
5. **Arrancar la pista legal (F-038, F-037).** Encargar las condiciones del servicio, el contrato de encargado y la política de privacidad a partir de `docs/RGPD_REALIDAD_TECNICA.md`, verificar la facturación de la clave de Gemini y hacer `/legal` pública con los datos del titular. Sin esto no se puede cobrar, aunque el código esté perfecto.

Faktury está más cerca de lo que parece. La lógica difícil está bien hecha y probada, y lo que falta es la parte que protege ese trabajo: transacciones, aislamiento, copias, alertas y contratos. Son semanas de trabajo enfocado, no meses. Lo importante es no confundir que funcione para un cliente amigo con estar preparado para clientes que pagan y exigirán responsabilidades por cada factura que falte en su 303.

---

## Anexo A. Matriz de casos límite

Borrador del agente de bugs e integridad de datos. Los ids de área (`BUG-xx`) corresponden a los hallazgos `F-xxx` del catálogo (columna «Origen» del anexo B).

### Matriz de casos límite (integridad de datos)

**Método.** He leído los flujos completos en la copia de 9d4b10f y he simulado la lógica pura con las funciones reales (`validators`, `exportFormats`, `rectificative`, `invoiceRouting`, `equivalenceSurcharge`) en scripts aislados fuera del repositorio. No se ha ejecutado nada contra la BD ni contra ningún entorno. **OK**: comportamiento correcto verificado. **Fallo**: defecto verificado en el código o en la simulación. **Riesgo**: depende de la concurrencia o de los datos reales.

### Subida y duplicados

| Escenario | Comportamiento actual | Resultado | Ref. |
|---|---|---|---|
| Doble clic / mismo fichero arrastrado dos veces | Dedupe en cliente por nombre + tamaño; en servidor por hash (findFirst) | **OK** en secuencial | — |
| Mismo PDF con otro nombre en el mismo lote (pool de 3) | Las dos pasan el findFirst antes de que exista la otra; los OCR paralelos no se ven entre sí | **Riesgo**: 2 facturas sin aviso de duplicado | BUG-09 (P1) |
| Mismo PDF subido de nuevo días después | «duplicado de factura X · subida el … · periodo · estado» | **OK** (salvo que la anterior esté rechazada) | — |
| Misma factura re-escaneada (otro hash) | Dedupe funcional por CIF + nº, pero compara el CIF crudo del OCR con el normalizado | **Fallo** si el OCR trae «ESB…» o «B-…» | BUG-08 (P1) |
| Subida en modo «clasificar» repetida | Sin dedupe por hash; tras enrutar solo CIF + nº | **Riesgo** de duplicado | BUG-09 |
| Refresh en mitad de un lote | Lo que llegó al servidor queda; al repetir, el hash lo marca como duplicado | **OK** (sin aviso beforeunload) | — |
| Fichero > 20 MB, extensión falsa o cabecera corrupta | 413 / 415 por magic bytes; PDF con cabecera válida y cuerpo roto → Error OCR con Reprocesar | **OK** | — |
| Foto HEIC de iPhone | Se acepta y se anuncia; en Chrome/Edge no se ve ni se puede dividir | **Riesgo** | BUG-27 (P2) |
| XML con XHTML y `<script>` subido por un CLIENTE | Se sirve inline en el mismo origen; la CSP permite scripts inline | **Riesgo** de XSS almacenado | BUG-14 (P1) |
| PDF con varias facturas | El OCR extrae una; no avisa de que es multipágina; depende de que el gestor use «Dividir» | **Riesgo** (mejora) | — |
| Periodo 13/2026 o 0 por API | Se acepta | **Fallo** menor | BUG-29 (P3) |
| Garage cae al subir / la BD cae después de subir | 500 sin filas / Document y objeto huérfanos | **OK** / huérfanos sin impacto contable | — |

### OCR y reprocesado

| Escenario | Comportamiento actual | Resultado | Ref. |
|---|---|---|---|
| Redeploy de Coolify durante el OCR (after()) | La factura queda en UPLOADED/ANALYZING; retry-stuck solo acepta GET y DEPLOY.md dice POST; la UI solo ofrece Reprocesar en OCR_ERROR | **Fallo**: limbo que además bloquea el cierre | BUG-13 (P1) |
| Gemini devuelve 429 o timeout | 3 intentos con backoff y luego Error OCR con Reprocesar | **OK** con una factura; con ráfagas, Error OCR en masa | BUG-23 (P2) |
| Reprocesar una factura ya revisada | No se permite (solo UPLOADED / OCR_ERROR / ANALYZED); lo guardado en OCR_ERROR pasa a Por revisar | **OK**: no se pierde revisión | — |
| Rechazar o dividir mientras está «En análisis» | Al terminar, el OCR reescribe el estado sin condición | **Fallo**: se deshace el rechazo o la división | BUG-07 (P1) |
| Pie «se emitirá factura rectificativa» en una factura normal | Importes en negativo sin marcar rectificativa; cuadra, así que no hay aviso | **Riesgo** de abono falso | BUG-11 (P1) |
| Línea exenta al 0 % (Gemini) | Se descarta; sale «descuadre» | **Fallo** (visible) | BUG-24 (P2) |
| Recargo leído como línea al 5,2 % | Se pliega sobre su IVA | **OK** | — |
| Grupo de empresas con proveedor compartido (modo clasificar) | La regla aprendida se reactiva y se impone a no_match, ambiguous y al texto | **Fallo**: factura en la empresa equivocada | BUG-10 (P1) |

### Revisión y estados

| Escenario | Comportamiento actual | Resultado | Ref. |
|---|---|---|---|
| Doble Enter / doble clic en Validar | isPending en cliente; en servidor, bloqueo no atómico | **Riesgo** menor (historial y emails duplicados) | BUG-18 (P2) |
| Dos gestores sobre la misma factura | Guardar/validar comparan updatedAt en memoria; rechazar no controla nada | **Riesgo**: gana la última escritura | BUG-18 |
| Volver con «<» a una rechazada y pulsar Enter | Se valida y vuelve al Excel | **Fallo** | BUG-06 (P1) |
| Botón Atrás tras «Dividir» | La original (SPLIT_SOURCE) sigue ofreciendo Validar y Dividir, sin distintivo | **Fallo**: doble contabilización o doble juego de hijas | BUG-06 (P1) |
| Añadir una línea con base y cuota sin % | Semáforo verde; el servidor descarta la línea y valida | **Fallo** (simulado) | BUG-05 (P1) |
| Validar sin total | Permitido; la exportación la excluye del Excel pero la marca | **Fallo** (simulado) | BUG-04 (P1) |
| Fallo a mitad de «Dividir» | Hijas parciales sin OCR; al reintentar, duplicados | **Fallo** | BUG-16 (P2) |
| Sesión caducada al validar | «No autorizado»; el formulario conserva lo tecleado | **OK** | — |
| Proveedor nuevo sin cuentas | Validar se bloquea hasta rellenarlas; aprende al validar | **OK** | — |

### Importes

| Escenario | Comportamiento actual | Resultado | Ref. |
|---|---|---|---|
| IRPF 15 % sobre 100,50 € | 15,07 (debería ser 15,08) y pisa el importe leído | **Fallo** de 1 céntimo | BUG-28 (P3) |
| Abono con cuota autocalculada (−10,50 × 21 %) | −2,20 frente a 2,21 en positivo | **Fallo** de 1 céntimo | BUG-28 |
| Multi-IVA | N filas en A3; IRPF solo en la primera | **OK** | — |
| Recargo por línea en abono | El signo se aplica también a la cuota de recargo | **OK** | — |

### Exportación

| Escenario | Comportamiento actual | Resultado | Ref. |
|---|---|---|---|
| Doble clic en Descargar | Freno en el cliente | **OK** | — |
| Dos pestañas o dos admins a la vez | Sin guarda en servidor: dos lotes con las mismas facturas | **Riesgo** | BUG-17 (P2) |
| Fallo al generar el Excel / corte al descargar | Facturas ya marcadas, sin fichero, sin re-descarga ni anulación | **Fallo**: exportada sin llegar a A3 | BUG-01 (P0) |
| Trimestre grande (> ~1.000 facturas) | Auditoría en una transacción de 5 s, después de marcar | **Riesgo** alto: falla y dispara BUG-01 | BUG-03 (P1) |
| Factura con total vacío o 0 | Fuera del Excel, pero con lote, snapshot y auditoría «Exportada» | **Fallo** (simulado) | BUG-04 (P1) |
| Corregir una factura ya exportada | Vuelve a la cola (huella frente a snapshot); si se deshace la corrección, vuelve a su lote | **OK**; el Excel no indica que es una corrección | BUG-25 (P2) |
| Rechazar o dividir una exportada | Bloqueado en servidor | **OK** | — |

### Cierres de periodo

| Escenario | Comportamiento actual | Resultado | Ref. |
|---|---|---|---|
| Guardar con el periodo cerrado | Bloqueado en UI y servidor | **OK** | — |
| Petición que cambia el «periodo contable» a un mes abierto | El servidor mira el periodo enviado, no el guardado | **Fallo** (saca la factura del cierre) | BUG-20 (P2) |
| Cerrar desde «Cierres» con facturas pendientes | Se permite (desde Lotes no) | **Fallo** | BUG-20 |
| Re-subida del cliente a un periodo cerrado | Se acepta | **Fallo** | BUG-26 (P2) |
| Rechazar o Dividir con el periodo cerrado | El servidor no lo comprueba | **En curso** (fixes.json #1/#5) | — |

### Permisos, modelo y operación

| Escenario | Comportamiento actual | Resultado | Ref. |
|---|---|---|---|
| ADMIN de otra asesoría con ids sacados de /api/search | Lee PDFs, rechaza facturas, cierra y reabre periodos | **Fallo** (conocido) | BUG-02 (P0) |
| Segunda asesoría da de alta un cliente ya existente en otra | «Ya existe un cliente con ese CIF» | **Fallo**: bloqueo y fuga de información | BUG-15 (P1) |
| Cambio de fecha o cuentas en una factura exportada | Se guarda sin entrada de auditoría | **Fallo** | BUG-12 (P1) |
| Auditoría concurrente sobre la misma factura | Sin bloqueo; se ordena por createdAt | **Riesgo** de «cadena rota» falsa | BUG-19 (P2) |
| Cron de recordatorios diario | Un email diario a cada cliente | **Fallo** | BUG-22 (P2) |
| Resend devuelve 429 | El error se ignora sin log | **Fallo** silencioso | BUG-21 (P2) |

### Lectura para las secciones P0/P1

1. **La exportación no es transaccional** (BUG-01, 03, 04, 17): se marca antes de entregar el fichero y no hay forma de deshacerlo. Es el P0 de integridad: una factura puede constar como «Exportada» sin estar en A3.
2. **No hay máquina de estados en servidor** (BUG-06, 07, 18): validar, dividir y rechazar aceptan casi cualquier estado, y el OCR escribe el estado sin condición. Así se llega a la doble contabilización y a rechazos que se deshacen solos.
3. **Duplicados** (BUG-08, 09, 26): el dedupe por hash falla bajo concurrencia y el dedupe funcional falla por la normalización del CIF.
4. **Datos contables mal asignados** (BUG-05, 10, 11): líneas descartadas en silencio, enrutado a la empresa equivocada y abonos falsos.
5. **Operación y trazabilidad** (BUG-12, 13): crons que no se disparan como dice DEPLOY.md y una auditoría que no cubre fecha ni cuentas.

### Arreglos rápidos (≤ 1 día cada uno)

| Ref. | Cambio | Esfuerzo |
|---|---|---|
| BUG-07 | Escritura final del OCR con `updateMany where status = 'ANALYZING'` | XS |
| BUG-08 | `parseTaxId(extraction.issuerCif).clean` en detectIssues | XS |
| BUG-13 | `export const POST = GET` en los crons y Reprocesar en facturas atascadas > 10 min | XS |
| BUG-14 | `/raw`: XML como `text/plain` o adjunto, y `CSP: sandbox` | XS |
| BUG-03 | Trocear la auditoría del export como en rejectBatch | XS |
| BUG-24 | Conservar las líneas al 0 % con base distinta de 0 | XS |
| BUG-21 | Comprobar el `error` que devuelve Resend | XS |
| BUG-22 | Enviar el recordatorio una sola vez por cliente y periodo | XS |
| BUG-18 | `updateMany` condicionado en rechazar, clasificar y rechazo rápido | XS |
| BUG-05 | Error en líneas incompletas y validar solo si `isValid !== false` | S |
| BUG-06 | Transiciones permitidas en servidor y solo lectura para SPLIT_SOURCE / REJECTED | S |
| BUG-04 | Campos mínimos al validar; no marcar lo que no sale en el Excel | S |
| BUG-10 | Regla de proveedor solo con `no_cif` / `invalid_cif`, y el texto antes que la regla | S |
| BUG-11 | Indicio textual de rectificativa → incidencia, no inversión de signo | S |
| BUG-12 | Ampliar trackedFields (fecha, cuentas, periodo contable, retención) | S |

---

## Anexo B. Catálogo completo de hallazgos

P0: 5, P1: 37, P2: 82, P3: 31. Los P0 y P1 pasaron verificación adversarial; los P2 y P3, no. «QW» marca los quick wins. «Origen» son los ids de cada especialista antes de fusionar duplicados.

| ID | Prioridad | Evidencia | Hallazgo | Área | Impacto | Esfuerzo | QW | Rutas principales | Origen |
|---|---|---|---|---|---|---|---|---|---|
| F-001 | 🔴 P0 | HECHO VERIFICADO | La exportación a A3 marca las facturas como exportadas antes de generar y entregar el Excel, sin transacción, reintento, nueva descarga ni anulación | Exportación A3, Transacciones, Auditoría | Crítico | M | ✔ | `src/app/api/export/route.ts:118`, `src/app/api/export/route.ts:132` | BUG-01, DB-01, EXP-01, QA-02, ARQ-04, PERF-03, CONT-03, FLOW-05, OBS-05, BUG-03, EXP-08 |
| F-002 | 🔴 P0 | HECHO VERIFICADO | Un XML subido por un cliente se sirve inline en el mismo origen con una CSP que permite scripts inline (XSS almacenado) | Seguridad de ficheros / XSS | Crítico | XS | ✔ | `src/app/api/invoices/[id]/raw/route.ts:36-44`, `src/lib/fileValidation.ts:30-42` | SEC-03, BUG-14 |
| F-003 | 🔴 P0 | RIESGO PROBABLE | Sin copia de seguridad externa ni plan de recuperación: BD, PDF originales, dev y builds en un único servidor | Infraestructura y continuidad | Crítico | S | ✔ | `DEPLOY.md:114`, `DEPLOY.md:45-55` | SAAS-01 |
| F-004 | 🔴 P0 | HECHO VERIFICADO | Los 7 accesos entre asesorías conocidos para ADMIN (aparcados): lectura y escritura de datos de otra asesoría | Multitenancy, Exportación | Crítico | S | ✔ | `src/lib/invoiceAccess.ts:17`, `src/app/api/search/route.ts:37-89` | BUG-02, SEC-02, SAAS-02, EXP-02, DB-13 |
| F-005 | 🔴 P0 | HECHO VERIFICADO | «Subir facturas» del ADMIN lista clientes (nombre y CIF) de todas las asesorías y preselecciona el primero (8.º sitio, no aparcado) | Multitenancy, Subida | Alto | XS | ✔ | `src/app/dashboard/worker/upload/page.tsx:16-21`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:74` | UX-01, SEC-01 |
| F-006 | 🟠 P1 | HECHO VERIFICADO | El filtro de asesoría falla en abierto (`advisoryFirmId ?? undefined`, User.advisoryFirmId anulable con SET NULL) y no hay capa central de aislamiento | Multitenancy, Arquitectura | Crítico | M | ✔ | `src/app/dashboard/admin/batch/page.tsx:60`, `src/app/dashboard/admin/invoices/page.tsx:48` | ARQ-01, SEC-12, DB-05 |
| F-007 | 🟠 P1 | HECHO VERIFICADO | La recuperación de facturas atascadas no funciona: el cron (userId «system») deja en «Error OCR» lo que rescata, está documentado como POST y ANALYZING no tiene salida desde la UI | Procesado OCR, Crons, Operación | Alto | S | ✔ | `src/app/api/cron/retry-stuck/route.ts:14`, `src/app/api/cron/retry-stuck/route.ts:26-50` | ARQ-02, PERF-05, SEC-19, DB-04, QA-06, OBS-01, SAAS-09, BUG-13, FLOW-11, OBS-02, OBS-09 |
| F-008 | 🟠 P1 | HECHO VERIFICADO | El final del OCR sobrescribe sin condición: deshace rechazos, divisiones y validaciones hechos mientras analizaba | Concurrencia, Estados, OCR | Alto | S | ✔ | `src/lib/processInvoice.ts:571-641`, `src/lib/processInvoice.ts:651-654` | ARQ-03, BUG-07, CONT-19 |
| F-009 | 🟠 P1 | HECHO VERIFICADO | Se puede validar sin total, líneas, fecha ni número, y el export marca como exportadas las facturas que excluye del Excel | Validación, Exportación A3 | Alto | S | ✔ | `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:713-722`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:934-955` | BUG-04, EXP-04, CONT-04, FLOW-04 |
| F-010 | 🟠 P1 | HECHO VERIFICADO | La detección de duplicados compara el CIF crudo del OCR con el CIF normalizado guardado: con prefijo, guiones o VAT europeo no detecta nada | Duplicados, OCR | Alto | S | ✔ | `src/lib/issueDetector.ts:147-197`, `src/lib/processInvoice.ts:268` | FLOW-02, BUG-08, CONT-05, QA-05, DB-03 |
| F-011 | 🟠 P1 | HECHO VERIFICADO | El «Periodo contable» de la revisión no llega al export: se filtra por el periodo de subida y la Fecha de Contabilización es siempre la de la factura | Periodos, Exportación A3 | Alto | S |  | `src/app/api/export/route.ts:43-64`, `src/lib/exportFormats.ts:245-258` | FLOW-03, CONT-02, EXP-06, QA-14, DB-15 |
| F-012 | 🟠 P1 | HECHO VERIFICADO | Las rectificativas se niegan siempre (también al alza y por sustitución) y el OCR invierte el signo de facturas ordinarias por una mención en el texto | Rectificativas, Importes | Alto | S | ✔ | `src/lib/rectificative.ts:21-32`, `src/lib/rectificative.ts:60-85` | CONT-01, BUG-11 |
| F-013 | 🟠 P1 | HECHO VERIFICADO | La extracción de texto de PDF con pdfjs falla siempre en el servidor: todos los PDF van por Gemini multimodal y las detecciones por texto quedan desactivadas | OCR | Alto | XS | ✔ | `src/lib/ocrLlm.ts:29`, `src/lib/ocrLlm.ts:79` | PERF-02 |
| F-014 | 🟠 P1 | HECHO VERIFICADO | Una línea de IVA incompleta se descarta en silencio al guardar y la factura se valida descuadrada | Revisión, Importes | Alto | S | ✔ | `src/app/dashboard/worker/review/[id]/actions.ts:117-150`, `src/app/dashboard/worker/review/[id]/actions.ts:433` | BUG-05 |
| F-015 | 🟠 P1 | HECHO VERIFICADO | Se puede validar una factura dividida o rechazada y volver a dividir una ya dividida | Máquina de estados | Alto | S | ✔ | `src/app/dashboard/worker/review/[id]/actions.ts:441`, `src/app/dashboard/worker/review/[id]/actions.ts:516` | BUG-06 |
| F-016 | 🟠 P1 | HECHO VERIFICADO | La revisión no muestra las incidencias de la factura: los posibles duplicados se validan a ciegas | Revisión, Incidencias | Alto | S | ✔ | `src/app/dashboard/worker/review/[id]/page.tsx:64-68`, `src/app/dashboard/worker/review/[id]/page.tsx:184-190` | FLOW-01, UX-02, OBS-12 |
| F-017 | 🟠 P1 | HECHO VERIFICADO | El nombre del fichero del export sale del cliente sin sanear: con ’, €, Ł o emojis la respuesta revienta después de marcar las facturas | Exportación A3 | Alto | XS | ✔ | `src/lib/exportFormats.ts:180-190`, `src/app/api/export/route.ts:207-226` | SEC-09, EXP-03 |
| F-018 | 🟠 P1 | HECHO VERIFICADO | Una factura corregida tras exportarse vuelve a salir como una fila normal: ni la vista previa ni el fichero la distinguen | Re-exportación, Exportación A3 | Alto | M |  | `src/app/dashboard/worker/review/[id]/actions.ts:450-484`, `src/app/api/export/route.ts:54-93` | EXP-05, CONT-10, BUG-25 |
| F-019 | 🟠 P1 | HECHO VERIFICADO | Se fuerza al cliente como receptor (compras) o emisor (ventas) sin comparar con el NIF leído: una factura a nombre de otro se registra como del cliente | Identidad del destinatario, Deducibilidad | Alto | S | ✔ | `src/lib/processInvoice.ts:347-358`, `src/app/dashboard/worker/review/[id]/actions.ts:245-255` | CONT-07 |
| F-020 | 🟡 P2 | HECHO VERIFICADO | Un tipo recibida/emitida equivocado sobrescribe la contraparte con los datos del cliente y no se detecta aunque su CIF salga en el otro lado | Entrada, OCR, Revisión | Alto | S | ✔ | `src/lib/processInvoice.ts:328-358`, `src/app/dashboard/client/upload/UploadForm.tsx:57` | FLOW-06 |
| F-021 | 🟠 P1 | HECHO VERIFICADO | La regla aprendida de proveedor enruta facturas a la empresa equivocada del grupo | Enrutado multicliente | Alto | S | ✔ | `src/lib/providerRouting.ts:63-74`, `src/lib/processInvoice.ts:219-227` | BUG-10 |
| F-022 | 🟠 P1 | HECHO VERIFICADO | No se comprueba que cada cuota sea base × %: cuotas cruzadas entre tipos pasan el cuadre, la revisión y el export | Validación por línea | Alto | XS | ✔ | `src/lib/exportFormats.ts:392-405`, `src/app/dashboard/worker/review/[id]/actions.ts:385-396` | CONT-09 |
| F-023 | 🟠 P1 | RIESGO PROBABLE | Intracomunitarias e ISP se exportan con 0 % y cuota 0 y el sistema avisa si llevan IVA: si A3 autorrepercute desde la fila, el 303 sale sin devengo ni deducción | Clasificación fiscal, Exportación A3 | Alto | S |  | `src/lib/exportFormats.ts:311-321`, `src/lib/issueDetector.ts:125-142` | CONT-08 |
| F-024 | 🟠 P1 | HECHO VERIFICADO | La auditoría no registra fecha, cuentas, periodo contable, retención ni países, ni los ajustes automáticos del OCR | Auditoría, Trazabilidad | Alto | S | ✔ | `src/app/dashboard/worker/review/[id]/actions.ts:398-416`, `src/lib/invoiceStatuses.ts:105-130` | BUG-12, CONT-11, EXP-14 |
| F-025 | 🟠 P1 | HECHO VERIFICADO | Ningún error bloquea el export (sin fecha/número/NIF, descuadre, moneda extranjera, sin cuentas): avisos sin severidad recortados a 20 | Exportación A3, Validación | Alto | S | ✔ | `src/lib/exportFormats.ts:283-454`, `src/lib/exportFormats.ts:364-366` | EXP-07, CONT-20 |
| F-026 | 🟠 P1 | HECHO VERIFICADO | Client.cif, Client.email y User.username/email son únicos en toda la plataforma: una asesoría no puede dar de alta un cliente de otra y el error lo delata | Multitenancy, Modelo de datos | Alto | S |  | `prisma/schema.prisma:164-165`, `prisma/schema.prisma:185` | ARQ-06, BUG-15, SEC-04, DB-06, SAAS-04 |
| F-027 | 🟠 P1 | HECHO VERIFICADO | Sin tests ni defensa estructural del aislamiento entre asesorías: 0 tests sobre 50 puntos de entrada | QA, Multitenancy | Alto | M |  | `tests/e2e/smoke.spec.ts`, `src/lib/prisma.ts:8-15` | QA-01, SEC-13 |
| F-028 | 🟠 P1 | HECHO VERIFICADO | No se puede desactivar a un usuario ni revocar sus sesiones | Usuarios, Sesiones | Alto | M |  | `prisma/schema.prisma:161-180`, `prisma/schema.prisma:213` | ARQ-19, SEC-07, DB-16 |
| F-029 | 🟠 P1 | RIESGO PROBABLE | El OCR no tiene cola ni límite de concurrencia: corre con after() en el proceso web, se pierde en cada redeploy y no reintenta Error OCR | OCR, Escalabilidad, Resiliencia | Alto | M |  | `src/app/api/uploads/route.ts:204-209`, `src/lib/uploadDirectClient.ts:88-116` | ARQ-05, PERF-04, BUG-23, FLOW-13, SAAS-21 |
| F-030 | 🟠 P1 | HECHO VERIFICADO | Lotes y paneles cargan todo el histórico en cada visita y cada 5 s con OCR en curso; por encima de 65.535 facturas Lotes falla | Consultas, Escalabilidad, Rendimiento percibido | Alto | M |  | `src/app/dashboard/worker/batch/page.tsx:109-127`, `src/app/dashboard/worker/batch/page.tsx:330` | ARQ-07, PERF-01, UX-07, FLOW-10, DB-08 |
| F-031 | 🟡 P2 | HECHO VERIFICADO | Faltan índices en claves foráneas y en las columnas de las consultas frecuentes (incidencias, extracciones, historial, auditoría, exportaciones, dedupe, asesoría) | Base de datos, Índices | Alto | S | ✔ | `prisma/migrations/00000000000000_init/migration.sql:355-425`, `prisma/schema.prisma:440-442` | ARQ-09, PERF-06, DB-02, EXP-12, OBS-20, DB-12 |
| F-032 | 🟠 P1 | HECHO VERIFICADO | No hay CI ni gate: los tests no se ejecutan antes de desplegar, el despliegue es manual y las migraciones se aplican al arrancar | CI/CD, Despliegue | Alto | S | ✔ | `Dockerfile:26`, `docker-entrypoint.sh:7-11` | ARQ-08, QA-03, SAAS-19 |
| F-033 | 🟠 P1 | HECHO VERIFICADO | No existe infraestructura de tests de integración con BD real pese a que AGENTS.md la exige | QA, Base de datos | Alto | M |  | `AGENTS.md:47`, `ARCHITECTURE.md:254` | QA-04, DB-19 |
| F-034 | 🟠 P1 | HECHO VERIFICADO | No hay seguimiento de errores, alertas ni health check real: los fallos los descubre el cliente | Observabilidad, Operación | Alto | S | ✔ | `Dockerfile:1-66`, `DEPLOY.md:12` | OBS-04, SAAS-12 |
| F-035 | 🟡 P2 | HECHO VERIFICADO | La causa real de un Error OCR no se guarda en ningún sitio consultable y la clasificación diagnostica mal | Observabilidad, OCR | Alto | S | ✔ | `src/lib/processInvoice.ts:642-690`, `src/lib/ocrLlm.ts:343-366` | OBS-03 |
| F-036 | 🟠 P1 | RIESGO PROBABLE | Migraciones automáticas al arrancar el contenedor, sin copia previa ni despliegue en dos fases | Migraciones, Despliegue | Alto | S | ✔ | `docker-entrypoint.sh:8`, `DEPLOY.md` | DB-09 |
| F-037 | 🟠 P1 | RIESGO PROBABLE | Las facturas se envían a la API de Gemini (AI Studio, endpoint global) sin región garantizada ni condiciones documentadas, con la clave en la query string | Protección de datos, Proveedores | Alto | S |  | `src/lib/ocrLlm.ts:6`, `src/lib/ocrLlm.ts:323-338` | SEC-11, SAAS-06 |
| F-038 | 🟠 P1 | HECHO VERIFICADO | Textos legales insuficientes y detrás del login: sin política de privacidad, condiciones ni DPA, y aviso legal sin datos del titular | Legal, RGPD | Alto | S | ✔ | `src/app/legal/page.tsx:16-59`, `src/proxy.ts:40-44` | SAAS-05, UX-28 |
| F-039 | 🟠 P1 | HECHO VERIFICADO | Los fallos de envío de correo son invisibles: Resend devuelve { error } y el código no lo mira | Correo transaccional, Observabilidad | Alto | XS | ✔ | `src/lib/email.ts:10`, `src/lib/email.ts:24-35` | SAAS-07, OBS-08, BUG-21, PERF-15 |
| F-040 | 🟠 P1 | HECHO VERIFICADO | Un correo por fichero subido y por factura validada, sin resumen, límite de ritmo ni preferencias | Correo transaccional, Notificaciones | Alto | S | ✔ | `src/app/api/uploads/route.ts:211-234`, `src/lib/uploadDirectClient.ts:72` | FLOW-07, SAAS-10, PERF-15, BUG-21 |
| F-041 | 🟠 P1 | HECHO VERIFICADO | Exportar es solo del ADMIN y cliente a cliente, sin bandeja de pendientes, aviso de facturas sin validar ni enlace desde Lotes o Cierres | Exportación, Roles | Alto | M |  | `src/app/api/export/route.ts:11-13`, `src/app/dashboard/admin/export/page.tsx:24` | FLOW-08, UX-06 |
| F-042 | 🟡 P2 | HECHO VERIFICADO | Dar de alta una asesoría exige un script en la terminal del contenedor que choca por username y deja «Demo1234!» por defecto | Onboarding de asesorías | Alto | S | ✔ | `scripts/bootstrap-admin.mjs:18-51`, `DEPLOY.md:64-77` | SAAS-03 |
| F-043 | 🟠 P1 | HECHO VERIFICADO | Sin planes, límites, medición de uso ni suspensión por asesoría | Modelo de negocio | Alto | M |  | `prisma/schema.prisma:144-159`, `src/app/api/uploads/route.ts:33-237` | SAAS-13 |
| F-044 | 🟠 P1 | HECHO VERIFICADO | No se pueden exportar ni borrar los datos de un cliente o de una asesoría | RGPD, Baja de asesorías | Alto | M |  | `prisma/schema.prisma:508`, `prisma/schema.prisma:537-549` | SAAS-14 |
| F-045 | 🟡 P2 | RIESGO PROBABLE | Modelo de despliegue sin decidir: dominio con el nombre de la asesoría y una app multi-tenant con una sola NEXTAUTH_URL | Arquitectura SaaS | Alto | S | ✔ | `src/lib/email.ts:11`, `src/app/login/forgot-password/actions.ts:13-17` | SAAS-23 |
| F-046 | 🟠 P1 | HECHO VERIFICADO | No se puede editar un cliente ni darle o reenviarle el acceso al portal (conocido, aparcado) | Clientes (admin) | Alto | M |  | `src/app/dashboard/admin/clients/[id]/page.tsx:52-107`, `src/app/dashboard/admin/clients/actions.ts:65-167` | UX-05, SAAS-16 |
| F-047 | 🟠 P1 | HECHO VERIFICADO | Sin protección de cambios sin guardar en la revisión (flechas, Volver, Alt+←/→ dentro de un campo, Posponer) | Revisión | Alto | S | ✔ | `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:980-993`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1058-1059` | UX-03 |
| F-048 | 🟡 P2 | HECHO VERIFICADO | Cadena de auditoría sin serializar por factura, escrita fuera de la transacción del cambio, sin ancla externa y con una verificación que nadie usa y no escala | Auditoría | Alto | M |  | `src/lib/auditLog.ts:65-125`, `src/lib/auditLog.ts:151-154` | ARQ-11, BUG-19, DB-07, QA-10, SEC-17, OBS-17, PERF-22 |
| F-049 | 🟡 P2 | RIESGO PROBABLE | Dos exportaciones a la vez meten las mismas facturas en dos ficheros, y una corrección simultánea al export puede perderse | Exportación A3, Concurrencia | Alto | S |  | `src/app/api/export/route.ts:97-182`, `src/app/dashboard/admin/export/ExportForm.tsx:95-97` | BUG-17, EXP-09 |
| F-050 | 🟡 P2 | RIESGO PROBABLE | Guardar y validar a la vez puede duplicar las líneas de IVA: bloqueo optimista no atómico y sin unicidad (invoiceId, position) | Concurrencia, Integridad contable | Alto | S | ✔ | `src/app/dashboard/worker/review/[id]/actions.ts:195-201`, `src/app/dashboard/worker/review/[id]/actions.ts:488-503` | DB-10 |
| F-051 | 🟡 P2 | RIESGO PROBABLE | Las compras de un cliente en recargo se exportan como «Interior (IVA deducible)» y la marca mezcla minorista y mayorista | Recargo de equivalencia, Deducibilidad | Alto | XS |  | `prisma/schema.prisma:196-202`, `src/lib/validators.ts:118-127` | CONT-22 |
| F-052 | 🟡 P2 | RIESGO PROBABLE | La confianza autodeclarada por Gemini guía la revisión: número, fecha y total pueden salir apagados y fuera del Tab, y el resto casi siempre en amarillo | Revisión, OCR | Alto | S | ✔ | `src/components/ui/SmartField.tsx:23-53`, `src/components/ui/SmartField.tsx:367-396` | UX-10, FLOW-18 |
| F-053 | 🟡 P2 | HECHO VERIFICADO | La ficha de factura del admin es un callejón sin salida y no sirve para diagnosticar | Facturas (admin), Soporte | Alto | S | ✔ | `src/app/dashboard/admin/invoices/InvoicesTable.tsx:43-51`, `src/app/dashboard/admin/invoices/InvoicesTable.tsx:217-228` | UX-12, OBS-07 |
| F-054 | 🟡 P2 | HECHO VERIFICADO | El alta de una asesoría no escala: clientes uno a uno, plan de cuentas por cliente sin guía, asignaciones una a una y sin checklist | Onboarding | Alto | L |  | `src/app/dashboard/admin/clients/ClientForm.tsx:14-137`, `src/app/dashboard/admin/clients/actions.ts:65-167` | UX-04, SAAS-15 |
| F-055 | 🟡 P2 | POSIBLE MEJORA | No existe validación asistida en bloque de facturas «verificadas»: cada una se abre y valida a mano | Productividad de revisión | Alto | M |  | `src/app/dashboard/admin/invoices/actions.ts:11-14`, `src/lib/reviewConstants.ts:20-27` | FLOW-09 |
| F-056 | 🟡 P2 | HECHO VERIFICADO | Las transiciones de estado comprueban y escriben en pasos separados, sin condición sobre el estado previo ni transacción común | Máquina de estados, Transacciones | Medio | M |  | `src/app/dashboard/worker/review/[id]/actions.ts:194-201`, `src/app/dashboard/worker/review/[id]/actions.ts:503` | ARQ-10, BUG-18, DB-11 |
| F-057 | 🟡 P2 | HECHO VERIFICADO | Las incidencias no se cierran al validar, rechazar ni reprocesar, y cada reproceso crea otras nuevas | Incidencias | Medio | XS | ✔ | `src/lib/issueDetector.ts:199-209`, `src/lib/processInvoice.ts:298` | ARQ-15, FLOW-12, OBS-12 |
| F-058 | 🟡 P2 | HECHO VERIFICADO | El cuadre tiene dos tolerancias en cinco sitios y el servidor permite validar descuadradas | Reglas de negocio, Cálculos | Medio | S | ✔ | `src/lib/invoiceBalance.ts:1`, `src/lib/processInvoice.ts:150-156` | ARQ-12, QA-09 |
| F-059 | 🟡 P2 | HECHO VERIFICADO | Redondeos en coma flotante fallan un céntimo (IRPF con toFixed, cuota negativa) y, con cuadre exacto y cuota de retención de solo lectura, obligan a retocar importes | Redondeos, Retenciones | Medio | S | ✔ | `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:535-540`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:592-661` | CONT-14, BUG-28 |
| F-060 | 🟡 P2 | HECHO VERIFICADO | La extracción con Gemini descarta todas las líneas de IVA al 0 %: en facturas mixtas se pierden exentos y suplidos | OCR, Desglose de IVA | Medio | XS | ✔ | `src/lib/ocrLlm.ts:385-393`, `src/lib/processInvoice.ts:148-156` | BUG-24, CONT-06 |
| F-061 | 🟡 P2 | RIESGO PROBABLE | La deduplicación por hash en la subida no es atómica: copias del mismo PDF en un lote entran dos veces sin aviso | Subida, Duplicados | Medio | S |  | `src/app/api/uploads/route.ts:127-141`, `src/app/api/uploads/route.ts:163` | BUG-09, QA-11, DB-03 |
| F-062 | 🟡 P2 | HECHO VERIFICADO | Dividir una factura no es atómico y las hijas pierden datos de la original | División | Medio | S |  | `src/app/dashboard/worker/review/[id]/actions.ts:1027-1112`, `src/app/dashboard/worker/review/[id]/actions.ts:1171-1281` | BUG-16, QA-12 |
| F-063 | 🟡 P2 | HECHO VERIFICADO | La re-subida del cliente no comprueba cierre ni hash, pierde periodType, repite el periodo equivocado y la fila sigue «Rechazada» | Portal cliente, Re-subida | Medio | S | ✔ | `src/app/dashboard/client/invoices/reupload-actions.ts:45`, `src/app/dashboard/client/invoices/reupload-actions.ts:64-67` | UX-17, BUG-26, DB-21, FLOW-20 |
| F-064 | 🟡 P2 | HECHO VERIFICADO | El alta de facturas está duplicada en cuatro sitios con reglas distintas | Duplicación de código, Integridad | Medio | M |  | `src/app/api/uploads/route.ts:175-202`, `src/app/dashboard/worker/review/[id]/actions.ts:1055-1083` | ARQ-13 |
| F-065 | 🟡 P2 | HECHO VERIFICADO | Las facturas clasificadas a mano desde «Por clasificar» no reciben lo aprendido del tercero ni el detector de incidencias completo | Clasificación multiempresa, Aprendizaje | Medio | S |  | `src/app/dashboard/worker/clasificar/actions.ts:56-118`, `src/lib/processInvoice.ts:275-298` | ARQ-14, FLOW-14, CONT-16 |
| F-066 | 🟡 P2 | HECHO VERIFICADO | Huecos en el bloqueo por periodo cerrado: el servidor comprueba el periodo contable que envía el formulario y otras vías no miran el cierre | Cierres de periodo | Medio | S | ✔ | `src/app/dashboard/worker/review/[id]/actions.ts:177-192`, `src/app/dashboard/admin/closures/actions.ts:7-49` | CONT-18, BUG-20 |
| F-067 | 🟡 P2 | HECHO VERIFICADO | La auditoría solo cubre facturas: cierres/reaperturas se sobrescriben y no se registran accesos ni acciones de administración | Auditoría, Cierres | Medio | M |  | `prisma/schema.prisma:569-604`, `src/app/dashboard/admin/closures/actions.ts:31-66` | DB-14, OBS-14, SAAS-18, BUG-12 |
| F-068 | 🟡 P2 | HECHO VERIFICADO | Con Gemini no se guarda lo que respondió la IA, ni con qué modelo, ni por qué se fue a multimodal | Observabilidad, OCR | Medio | XS | ✔ | `src/lib/ocrLlm.ts:79-81`, `src/lib/ocrLlm.ts:337-350` | OBS-06, CONT-11 |
| F-069 | 🟡 P2 | HECHO VERIFICADO | El Excel exportado no se guarda y el lote no registra nombre, hash, filas, excluidas ni asesoría; el snapshot no se ve en ninguna pantalla | Trazabilidad, Exportación A3 | Medio | S |  | `prisma/schema.prisma:518-544`, `src/app/api/export/route.ts:118-175` | EXP-10 |
| F-070 | 🟡 P2 | HECHO VERIFICADO | El export no controla duplicados (sentido, NIF del tercero y número) ni en el lote ni frente a lo ya exportado | Exportación A3, Duplicados | Medio | S | ✔ | `src/lib/exportFormats.ts:283-454`, `src/lib/issueDetector.ts:144-196` | EXP-11 |
| F-071 | 🟡 P2 | HECHO VERIFICADO | La descarga del export es un GET con efectos que, sin parámetros, consume todo lo pendiente de la asesoría | Seguridad, API de export | Medio | XS | ✔ | `src/app/api/export/route.ts:9-64`, `src/app/api/export/route.ts:117-193` | SEC-08, EXP-13 |
| F-072 | 🟡 P2 | HECHO VERIFICADO | El recargo propuesto a partir del total no se distingue de uno leído, puede explicar un descuadre que no es recargo y reparte el céntimo por su cuenta | Recargo de equivalencia | Medio | S |  | `src/lib/equivalenceSurcharge.ts:134-185`, `src/lib/processInvoice.ts:282-293` | CONT-12 |
| F-073 | 🟡 P2 | HECHO VERIFICADO | Retención IRPF: el importe leído se sustituye por base × %, solo se aprende en compras a personas físicas, la cuota no es editable y en A3 va solo en la primera fila | Retenciones | Medio | M |  | `src/lib/processInvoice.ts:437-486`, `src/app/dashboard/worker/review/[id]/actions.ts:567-573` | CONT-13 |
| F-074 | 🟡 P2 | RIESGO PROBABLE | Tipo de operación por defecto discutible: fuera de la UE siempre «Importación» (también servicios), extranjero sin prefijo como Interior, GR/XI no reconocidos | Clasificación fiscal | Medio | S |  | `src/lib/validators.ts:79-90`, `src/lib/validators.ts:247-271` | CONT-15 |
| F-075 | 🟡 P2 | HECHO VERIFICADO | El Excel añade «_R» al número real de una rectificativa y no lleva la referencia a la rectificada | Rectificativas, Exportación A3 | Medio | XS | ✔ | `src/lib/exportFormats.ts:249-260`, `src/lib/exportFingerprint.ts:114-116` | CONT-17 |
| F-076 | 🟡 P2 | HECHO VERIFICADO | Los CIF con dígito de control 0 y letra «J» se dan por inválidos | NIF/CIF | Medio | XS | ✔ | `src/lib/validators.ts:53-58`, `src/app/dashboard/admin/clients/actions.ts:18` | CONT-21 |
| F-077 | 🟡 P2 | HECHO VERIFICADO | El plan de cuentas aprendido se sobrescribe con la cuenta de la última factura validada, incluida la genérica de tickets, sin rastro | Cuentas contables aprendidas | Medio | S |  | `src/app/dashboard/worker/review/[id]/actions.ts:558-563`, `src/app/dashboard/worker/review/[id]/actions.ts:606-641` | CONT-23 |
| F-078 | 🟡 P2 | HECHO VERIFICADO | Longitud de cuenta fija en 8 dígitos; exportConfig.accountLength no se usa ni tiene interfaz | Cuentas contables, Configuración | Medio | M |  | `src/lib/accountingAccount.ts:1-45`, `src/lib/accountingAccount.ts:87-90` | CONT-24, EXP-16, SAAS-20 |
| F-079 | 🟡 P2 | RIESGO PROBABLE | Las ventas con inversión del sujeto pasivo o exentas/no sujetas no se pueden expresar y salen como Interior 0 % | Formato A3, Tipo de operación | Medio | M |  | `src/lib/validators.ts:108-116`, `src/lib/validators.ts:160-178` | EXP-15 |
| F-080 | 🟡 P2 | RIESGO PROBABLE | Pool y timeouts de BD por defecto: 10 conexiones, maxWait 2 s, sin statement_timeout ni métricas | Base de datos, Infraestructura | Medio | XS | ✔ | `src/lib/prisma.ts:9`, `src/lib/auditLog.ts:76` | PERF-13 |
| F-081 | 🟡 P2 | HECHO VERIFICADO | Prefetch completo de revisiones y refrescos periódicos que relanzan todos los prefetch, también con la pestaña oculta | Frontend, Polling | Medio | XS | ✔ | `src/app/dashboard/worker/batch/page.tsx:448-458`, `src/app/dashboard/worker/page.tsx:441` | PERF-07 |
| F-082 | 🟡 P2 | HECHO VERIFICADO | La ETA del OCR recalcula la media de todas las extracciones de la asesoría en cada refresco | Base de datos, Polling | Medio | XS | ✔ | `src/app/dashboard/worker/batch/page.tsx:209`, `src/app/dashboard/admin/batch/page.tsx:193` | PERF-08 |
| F-083 | 🟡 P2 | HECHO VERIFICADO | La búsqueda de texto trae todas las facturas del filtro y filtra en JavaScript | Consultas, Listados | Medio | M |  | `src/lib/invoiceListing.ts:21-40`, `src/app/dashboard/worker/invoices/page.tsx:106` | PERF-09 |
| F-084 | 🟡 P2 | HECHO VERIFICADO | El desplegable de campos de Auditoría carga todas las filas de auditoría de la asesoría | Base de datos, Auditoría | Medio | XS | ✔ | `src/app/dashboard/admin/audit/page.tsx:81-102` | PERF-10 |
| F-085 | 🟡 P2 | HECHO VERIFICADO | El panel del admin carga el estado de todas las facturas para 4 clientes y ordena toda la auditoría para 5 filas | Base de datos, Panel admin | Medio | S | ✔ | `src/app/dashboard/admin/page.tsx:79`, `src/app/dashboard/admin/page.tsx:85-91` | PERF-11 |
| F-086 | 🟡 P2 | HECHO VERIFICADO | El visor descarga el PDF dos veces por revisión y /raw lo carga entero en memoria con varias copias | Almacenamiento, Visor | Medio | S | ✔ | `src/components/ui/PdfViewer.tsx:155`, `src/components/ui/PdfViewer.tsx:200-204` | PERF-12 |
| F-087 | 🟡 P2 | RIESGO PROBABLE | «Reprocesar todas» las Error OCR: auditoría de todas en una transacción, OCR en serie en un after() de horas, errores tragados y sin progreso | Reprocesado | Medio | XS | ✔ | `src/app/dashboard/admin/invoices/actions.ts:37-46`, `src/app/dashboard/admin/invoices/actions.ts:62-87` | PERF-14, OBS-21 |
| F-088 | 🟡 P2 | HECHO VERIFICADO | Importar el plan de cuentas hace un upsert por fila en serie y la tabla pagina en el navegador | Operaciones masivas, Plan de cuentas | Medio | S |  | `src/app/dashboard/admin/clients/[id]/accounts/actions.ts:54-56`, `src/app/dashboard/admin/clients/[id]/accounts/page.tsx:21` | PERF-16 |
| F-089 | 🟡 P2 | RIESGO PROBABLE | El límite de subida de 20 MB no cabe en el envío inline a Gemini: ficheros de más de ~15 MB fallan siempre | OCR | Medio | S |  | `src/app/api/uploads/route.ts:29`, `src/lib/ocrLlm.ts:500` | PERF-17 |
| F-090 | 🟡 P2 | RIESGO PROBABLE | xlsx 0.18.5 con CVE conocidos (prototype pollution y ReDoS) al leer el plan de cuentas subido | Dependencias | Medio | XS | ✔ | `package.json:33`, `src/app/dashboard/admin/clients/[id]/accounts/actions.ts:28-37` | SEC-10, EXP-17 |
| F-091 | 🟡 P2 | HECHO VERIFICADO | Control de fuerza bruta incompleto: rate limit solo en loginAction y contador de fallos no atómico | Autenticación | Medio | S | ✔ | `src/lib/auth.ts:58-84`, `src/app/login/actions.ts:21-26` | SEC-05, DB-23 |
| F-092 | 🟡 P2 | HECHO VERIFICADO | El bloqueo a los 3 intentos es fácil de provocar por terceros, se muestra como «contraseña incorrecta» y no se puede ver ni desbloquear | Autenticación, Soporte | Medio | S | ✔ | `src/lib/auth.ts:13-14`, `src/lib/auth.ts:62-83` | SEC-06, SAAS-22, OBS-11 |
| F-093 | 🟡 P2 | HECHO VERIFICADO | Higiene de credenciales: contraseña por defecto en scripts, mínimo de 8 caracteres, sin 2FA y tokens de restablecimiento en claro sin FK ni limpieza | Autenticación, Seguridad de datos | Medio | S | ✔ | `scripts/bootstrap-admin.mjs:18-23`, `src/app/login/forgot-password/actions.ts:44-49` | SEC-18, DB-17 |
| F-094 | 🟡 P2 | RIESGO PROBABLE | Subidas sin límite de cuerpo previo, rate limit ni cuota | Disponibilidad, Coste | Medio | S |  | `src/app/api/uploads/route.ts:45-72` | SEC-14 |
| F-095 | 🟡 P2 | POSIBLE MEJORA | CSP permisiva ('unsafe-inline', 'unsafe-eval', connect-src https:) y cabecera X-Powered-By | Cabeceras | Medio | M |  | `next.config.ts:8-20` | SEC-16 |
| F-096 | 🟡 P2 | POSIBLE MEJORA | Sin vigilancia automática de dependencias (next-auth en beta, sin npm audit ni Dependabot) | Dependencias | Medio | XS | ✔ | `package.json:15-35` | SEC-23 |
| F-097 | 🟡 P2 | HECHO VERIFICADO | Errores tragados que se muestran como «no hay datos» o como una causa falsa, y server actions que lanzan a la UI | Manejo de errores | Medio | S |  | `src/app/dashboard/admin/page.tsx:92`, `src/app/dashboard/layout.tsx:23` | ARQ-16, OBS-10, UX-15 |
| F-098 | 🟡 P2 | HECHO VERIFICADO | Logs sin estructura ni correlación, con datos personales y sin retención definida | Observabilidad, Logging, RGPD | Medio | S | ✔ | `src/lib/processInvoice.ts:656`, `src/app/api/uploads/route.ts:207` | OBS-16, SEC-21 |
| F-099 | 🟡 P2 | HECHO VERIFICADO | No queda rastro de las subidas rechazadas ni de los errores de almacenamiento | Observabilidad, Subida | Medio | XS | ✔ | `src/app/api/uploads/route.ts:70-202`, `src/app/api/invoices/[id]/raw/route.ts:45-50` | OBS-13 |
| F-100 | 🟡 P2 | POSIBLE MEJORA | No hay vista de operador de plataforma ni métricas de salud entre asesorías | Soporte, Operación | Medio | M |  | `prisma/schema.prisma:9-13`, `src/app/dashboard/admin/page.tsx:64-92` | OBS-19 |
| F-101 | 🟡 P2 | HECHO VERIFICADO | Gestión de cuentas mínima: gestor y cliente sin «Mi cuenta», contraseña del gestor fijada por el admin, sin reset por el admin ni segundo ADMIN, login «Usuario» cuando es el email | Usuarios, Identidad y acceso | Medio | M |  | `src/app/dashboard/admin/settings/actions.ts:111-113`, `src/proxy.ts:7-11` | SAAS-08, UX-20 |
| F-102 | 🟡 P2 | HECHO VERIFICADO | Ficheros-dios en el flujo crítico: ReviewForm (2.674 líneas), actions de revisión (1.333, parseAndSave no testable) y processInvoice | Mantenibilidad, Testabilidad | Medio | L |  | `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:321`, `src/app/dashboard/worker/review/[id]/actions.ts:1` | ARQ-17, QA-07 |
| F-103 | 🟡 P2 | HECHO VERIFICADO | Los tests del Excel A3 no fijan cabeceras («Cutoa»), fechas, _R, IRPF en la primera fila, exclusión por total ni la paridad huella↔fila | Tests, Exportación A3 | Medio | S | ✔ | `tests/unit/exportFormats.test.ts:24`, `tests/unit/exportFormats.test.ts:392-500` | QA-08, EXP-18 |
| F-104 | 🟡 P2 | HECHO VERIFICADO | El E2E son 5 tests de humo del login, está roto (busca «email») y usa el servidor de desarrollo con el .env local | QA, E2E | Medio | M |  | `tests/e2e/smoke.spec.ts:1-34`, `playwright.config.ts:24-30` | QA-13 |
| F-105 | 🟡 P2 | HECHO VERIFICADO | El gestor no puede ver ni corregir el plan de cuentas de sus clientes y las cuentas se teclean sin autocompletar | Plan de cuentas, Roles | Medio | M |  | `src/app/dashboard/admin/clients/[id]/accounts/page.tsx:14`, `src/app/dashboard/admin/clients/[id]/accounts/actions.ts:21` | FLOW-16 |
| F-106 | 🟡 P2 | HECHO VERIFICADO | Sin historial ni notas en la revisión y sin forma de preguntar al cliente sin rechazar | Revisión, Colaboración | Medio | M |  | `src/app/dashboard/worker/review/[id]/page.tsx:40-51`, `src/app/dashboard/admin/invoices/[id]/page.tsx:37-40` | FLOW-17 |
| F-107 | 🟡 P2 | HECHO VERIFICADO | Validar con cuentas vacías solo hace temblar campos que suelen estar fuera de pantalla | Revisión | Medio | XS | ✔ | `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:950-953`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2275-2287` | UX-11 |
| F-108 | 🟡 P2 | HECHO VERIFICADO | Periodo por defecto equivocado, periodicidad elegida en cada subida (también por el cliente final) y fecha fuera de periodo sin incidencia | Entrada, Periodificación | Medio | M |  | `src/app/dashboard/client/upload/UploadForm.tsx:53-56`, `src/app/dashboard/client/upload/UploadForm.tsx:162-229` | FLOW-15, UX-21 |
| F-109 | 🟡 P2 | HECHO VERIFICADO | El mismo periodo se escribe de tres formas y los trimestrales aparecen como mes | Consistencia | Medio | XS | ✔ | `src/app/dashboard/admin/invoices/InvoicesTable.tsx:182`, `src/app/dashboard/worker/invoices/page.tsx:288` | UX-13 |
| F-110 | 🟡 P2 | HECHO VERIFICADO | Acciones de alto impacto sin confirmación (cerrar, reabrir) y cliente y mes preseleccionados por defecto | Lotes, Cierres, Subida, Exportar | Medio | XS | ✔ | `src/app/dashboard/worker/batch/BatchActions.tsx:98-117`, `src/app/dashboard/admin/closures/ClosuresClient.tsx:22-44` | UX-18 |
| F-111 | 🟡 P2 | HECHO VERIFICADO | Contraste por debajo de WCAG AA en los CTA principales, el texto secundario y el foco, con tipografía muy pequeña | Sistema visual, Accesibilidad | Medio | S | ✔ | `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2433-2438`, `src/app/dashboard/worker/batch/page.tsx:449` | UX-08 |
| F-112 | 🟡 P2 | HECHO VERIFICADO | Formularios y controles no accesibles por teclado ni lector: zona de subida, 39 labels sin asociar y modales sin semántica | Accesibilidad | Medio | M |  | `src/app/dashboard/client/upload/UploadForm.tsx:234-254`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:361-375` | UX-09 |
| F-113 | 🟡 P2 | HECHO VERIFICADO | Texto técnico en Auditoría y Actividad reciente: nombres de campo crudos e ids internos | Auditoría, Panel admin | Medio | XS | ✔ | `src/app/dashboard/admin/page.tsx:137-143`, `src/app/dashboard/admin/page.tsx:320` | UX-14 |
| F-114 | 🟡 P2 | HECHO VERIFICADO | Portal del cliente y pantallas de admin sin adaptar a móvil: las tablas recortan columnas | Responsive | Medio | S | ✔ | `src/components/layout/DashboardShell.tsx:135`, `src/app/dashboard/client/invoices/page.tsx:229` | UX-16 |
| F-115 | 🟡 P2 | HECHO VERIFICADO | Listado del gestor sin importe ni ordenación, rechazadas sin enlace y solo se explica el duplicado | Facturas (gestor) | Medio | S | ✔ | `src/app/dashboard/worker/invoices/page.tsx:184-189`, `src/app/dashboard/worker/invoices/page.tsx:276-365` | UX-19 |
| F-116 | 🟡 P2 | HECHO VERIFICADO | Visor PDF sin manejo de errores: textos en inglés de react-pdf, spinner infinito y sin «Reintentar» | Visor de documentos | Medio | XS | ✔ | `src/components/ui/PdfViewer.tsx:344-366`, `node_modules/react-pdf/dist/Document.js:41` | UX-22 |
| F-117 | 🟡 P2 | POSIBLE MEJORA | No hay acciones masivas en los listados (duplicadas, reprocesar selección, mover de periodo o cliente, asignar varios clientes) | Productividad | Medio | M |  | `src/app/dashboard/admin/invoices/InvoicesTable.tsx:53-60`, `src/app/dashboard/worker/invoices/page.tsx:340-365` | UX-24 |
| F-118 | 🟡 P2 | POSIBLE MEJORA | Paneles poco accionables: KPIs históricos no clicables, sin foco en el periodo en curso ni señales de problemas | Paneles | Medio | M |  | `src/app/dashboard/admin/page.tsx:98-159`, `src/app/dashboard/worker/page.tsx:218-278` | UX-25 |
| F-119 | 🟡 P2 | HECHO VERIFICADO | Los toasts, arriba a la derecha, tapan la navegación de la revisión | Revisión | Medio | XS | ✔ | `src/components/ui/Toast.tsx:124-127` | UX-30 |
| F-120 | 🟡 P2 | HECHO VERIFICADO | Los correos llevan la marca Faktury (y un remitente facturocr.com por defecto) y no nombran a la asesoría | Correo transaccional, Marca | Medio | S |  | `src/lib/email.ts:10`, `src/lib/email.ts:136-206` | SAAS-11 |
| F-121 | 🟡 P2 | HECHO VERIFICADO | Sin canal de soporte, ayuda ni avisos de mantenimiento dentro del producto | Soporte | Medio | XS | ✔ | `src/app/dashboard/error.tsx:19`, `src/lib/errorCodes.ts:70` | SAAS-17 |
| F-122 | 🟡 P2 | RIESGO PROBABLE | Se aceptan fotos HEIC, pero no se ven ni se pueden dividir en Chrome/Edge | Subida, Visor | Medio | S |  | `src/lib/fileValidation.ts:25`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:390` | BUG-27 |
| F-123 | 🟡 P2 | HECHO VERIFICADO | El recordatorio de cierre no se deduplica (reminderSent nunca se escribe), ignora la periodicidad y recorre en serie todos los clientes de todas las asesorías | Notificaciones, Crons | Medio | XS | ✔ | `src/app/api/cron/closure-reminders/route.ts:31-61`, `prisma/schema.prisma:604` | FLOW-19, BUG-22, DB-18, ARQ-23, PERF-22 |
| F-124 | 🟡 P2 | HECHO VERIFICADO | ARCHITECTURE.md y DEPLOY.md no coinciden con el código (Supabase/Vercel, rutas, migraciones, crons POST, fallback de OCR, cobertura de tests) | Documentación | Medio | S | ✔ | `ARCHITECTURE.md:27`, `ARCHITECTURE.md:87` | ARQ-18, QA-17 |
| F-125 | 🟢 P3 | RIESGO PROBABLE | Las claves de almacenamiento pueden colisionar y sobrescribir un PDF | Almacenamiento | Medio | XS | ✔ | `src/app/api/uploads/route.ts:157-163`, `src/lib/storage.ts:122` | ARQ-22, SEC-15 |
| F-126 | 🟢 P3 | RIESGO PROBABLE | Trabajo de CPU en el hilo del único proceso web (xlsx, pdf-lib, pdfjs, miles de filas) | Arquitectura de ejecución | Medio | M |  | `src/app/api/export/route.ts:211`, `src/app/dashboard/worker/review/[id]/actions.ts:1189` | PERF-23 |
| F-127 | 🟢 P3 | RIESGO PROBABLE | La descarga revoca el blob URL justo después de a.click() con el enlace fuera del DOM | Exportación, UI | Medio | XS | ✔ | `src/app/dashboard/admin/export/ExportForm.tsx:127-133` | EXP-19 |
| F-128 | 🟢 P3 | HECHO VERIFICADO | Configuración leída en cada fichero sin validar al arrancar y con valores por defecto peligrosos | Configuración | Bajo | S |  | `src/lib/email.ts:10-11`, `src/app/dashboard/admin/clients/actions.ts:154` | ARQ-20 |
| F-129 | 🟢 P3 | HECHO VERIFICADO | El cliente técnico «Sin clasificar» es una fila centinela que hay que excluir a mano en cada consulta | Modelo de datos | Bajo | M |  | `src/lib/unclassifiedClient.ts:12-24`, `src/app/api/export/route.ts:57` | ARQ-21 |
| F-130 | 🟢 P3 | HECHO VERIFICADO | Scripts y artefactos obsoletos o peligrosos en el repositorio | Higiene del repositorio | Bajo | XS | ✔ | `scripts/seed-demo.ts:101`, `scripts/seed-demo.ts:123` | ARQ-24 |
| F-131 | 🟢 P3 | HECHO VERIFICADO | reset-demo borra los tokens de restablecimiento e invitación de todas las asesorías | Operación, Multitenancy | Bajo | XS | ✔ | `src/lib/demoSeed.ts:96`, `src/lib/demoSeed.ts:118` | BUG-30, SEC-22 |
| F-132 | 🟢 P3 | RIESGO PROBABLE | Las llamadas a Garage no tienen timeout y el OCR no tiene tiempo máximo global | Almacenamiento, Tareas de fondo | Bajo | XS |  | `src/lib/storage.ts:33`, `src/lib/processInvoice.ts:92-95` | PERF-21 |
| F-133 | 🟢 P3 | HECHO VERIFICADO | Listados sin periodo por defecto: cada carga cuenta y ordena todo el histórico (4-6 consultas) | Consultas, Listados | Bajo | S |  | `src/app/dashboard/worker/invoices/page.tsx:111-152`, `src/app/dashboard/admin/invoices/page.tsx:92-114` | PERF-18 |
| F-134 | 🟢 P3 | POSIBLE MEJORA | La revisión y la validación encadenan consultas en serie que podrían ir en paralelo o en bloque | Consultas, Revisión | Bajo | S |  | `src/app/dashboard/worker/review/[id]/page.tsx:40`, `src/app/dashboard/worker/review/[id]/actions.ts:152` | PERF-19 |
| F-135 | 🟢 P3 | HECHO VERIFICADO | El logo de la asesoría viaja como data URL en cada render del layout, incluidos los refrescos de 3-5 s | Frontend, Payload | Bajo | S |  | `src/app/dashboard/layout.tsx:22-32`, `src/app/dashboard/admin/settings/actions.ts:55` | PERF-20 |
| F-136 | 🟢 P3 | HECHO VERIFICADO | Todas las pestañas del navegador se llaman igual y las de login duplican la marca | Navegación | Bajo | S | ✔ | `src/app/layout.tsx:15-19`, `src/app/login/forgot-password/page.tsx:6-8` | UX-23 |
| F-137 | 🟢 P3 | HECHO VERIFICADO | Estructura inconsistente y componentes duplicados que ya divergen (dobles h1, tres sistemas de aviso, dos formularios de subida, dos páginas de Lotes) | Consistencia | Bajo | M |  | `src/components/layout/Topbar.tsx:239-241`, `src/components/ui/PageHeader.tsx:10` | UX-26 |
| F-138 | 🟢 P3 | HECHO VERIFICADO | Pantallas y endpoints huérfanos o desfasados: Incidencias sin enlace, /api/search sin UI (y sin buscar receptor ni normalizar CIF) y capturas antiguas | Arquitectura de información, Búsqueda | Bajo | S | ✔ | `src/app/dashboard/worker/issues/page.tsx`, `src/components/layout/Topbar.tsx:33` | UX-27, FLOW-22 |
| F-139 | 🟢 P3 | HECHO VERIFICADO | Exportar con avisos sin confirmar y detalles que confunden (selector de una opción, enlaces sin back, texto «Exportada») | Exportar | Bajo | XS | ✔ | `src/app/dashboard/admin/export/ExportForm.tsx:252-282`, `src/app/dashboard/admin/export/ExportForm.tsx:340-366` | UX-29 |
| F-140 | 🟢 P3 | HECHO VERIFICADO | Etiquetas de estado distintas en Facturas (admin): «Pte. revisión» frente a «Por revisar» y «En analisis» sin tilde | Consistencia | Bajo | XS | ✔ | `src/app/dashboard/admin/invoices/page.tsx:18`, `src/app/dashboard/admin/invoices/page.tsx:24` | UX-31 |
| F-141 | 🟢 P3 | HECHO VERIFICADO | El aviso de duplicado no enlaza a la original y rechazar por duplicado pide al cliente que vuelva a subirla | Duplicados, Comunicación | Bajo | S | ✔ | `src/lib/issueDetector.ts:29-40`, `src/app/dashboard/worker/invoices/actions.ts:59-120` | FLOW-21 |
| F-142 | 🟢 P3 | HECHO VERIFICADO | Facturae XML: se pierde la serie, IGIC/IPSI se trata como IVA y no se mapea el recargo | OCR XML | Bajo | S |  | `src/lib/ocr.ts:526-533`, `src/lib/ocr.ts:551-552` | CONT-25 |
| F-143 | 🟢 P3 | HECHO VERIFICADO | fmtDate usa la hora local y la huella usa UTC: con una zona al oeste de UTC las fechas salen un día antes y fallan 2 tests | Formato A3, Determinismo | Bajo | XS | ✔ | `src/lib/exportFormats.ts:70-82`, `src/lib/exportFingerprint.ts:77-83` | EXP-20, QA-15, CONT-26 |
| F-144 | 🟢 P3 | HECHO VERIFICADO | El export mensual de enero, abril, julio y octubre arrastra las subidas trimestrales del trimestre | Exportación, Filtros | Bajo | XS | ✔ | `src/app/api/export/route.ts:43-62`, `src/app/dashboard/worker/batch/actions.ts:146-147` | EXP-22, CONT-26 |
| F-145 | 🟢 P3 | HECHO VERIFICADO | Código muerto de exportadores CSV (sage50, contasol, a3con) y exportConfig sin rellenar, anunciados como disponibles | Mantenibilidad | Bajo | XS | ✔ | `src/lib/exportFormats.ts:18-24`, `src/lib/exportFormats.ts:95-178` | EXP-21 |
| F-146 | 🟢 P3 | POSIBLE MEJORA | No se validan longitudes ni formatos contra los límites de A3 (nombre, número, concepto) | Formato A3 | Bajo | S |  | `src/lib/exportFormats.ts:256-273` | EXP-23 |
| F-147 | 🟢 P3 | HECHO VERIFICADO | Una factura legacy EXPORTED corregida sale del lote pero no vuelve a VALIDATED y no llega al Excel | Re-exportación, Datos legacy | Bajo | XS | ✔ | `src/app/dashboard/worker/review/[id]/actions.ts:441`, `src/app/api/export/route.ts:55-56` | EXP-24 |
| F-148 | 🟢 P3 | HECHO VERIFICADO | Editar o borrar un grupo de empresas solo comprueba la firma del grupo | Autorización | Bajo | S |  | `src/app/dashboard/worker/groups/actions.ts:50-83`, `src/lib/invoiceAccess.ts:24-29` | SEC-20 |
| F-149 | 🟢 P3 | HECHO VERIFICADO | No hay error global ni de raíz: un fallo fuera del panel muestra la página genérica de Next en inglés | Errores, Experiencia | Bajo | XS |  | `src/app/dashboard/error.tsx`, `src/app/layout.tsx` | SAAS-24 |
| F-150 | 🟢 P3 | HECHO VERIFICADO | `npm run lint` está en rojo (188 errores, 143 en un fichero de tests) y no sirve como gate | CI/CD, Lint | Bajo | XS |  | `tests/unit/exportFormats.test.ts:24`, `eslint.config.mjs:1` | QA-16 |
| F-151 | 🟢 P3 | HECHO VERIFICADO | Huecos en el historial de estados y actor invisible | Trazabilidad | Bajo | XS | ✔ | `src/app/api/cron/retry-stuck/route.ts:41-46`, `src/app/dashboard/worker/review/[id]/actions.ts:444-447` | OBS-15 |
| F-152 | 🟢 P3 | HECHO VERIFICADO | Las métricas de tiempo de OCR en pantalla están mal calculadas | Métricas | Bajo | XS | ✔ | `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1365-1369`, `src/components/ui/OcrProcessingBanner.tsx:26-61` | OBS-18 |
| F-153 | 🟢 P3 | HECHO VERIFICADO | Auditoría: la fecha se muestra en hora de Madrid pero los filtros cortan por día UTC | Auditoría | Bajo | XS | ✔ | `src/app/dashboard/admin/audit/page.tsx:61-66` | OBS-22 |
| F-154 | 🟢 P3 | POSIBLE MEJORA | La tabla Document solo se escribe, duplica datos de Invoice y se queda con el cliente del buzón al rutear | Modelo de datos | Bajo | S |  | `prisma/schema.prisma:289`, `src/app/api/uploads/route.ts:175` | DB-22 |
| F-155 | 🟢 P3 | HECHO VERIFICADO | Sin validación ni CHECK de rangos de periodo: son posibles meses 0 o 13 y los estados legacy siguen vivos | Subida, Restricciones | Bajo | S |  | `src/app/api/uploads/route.ts:59-69`, `src/app/dashboard/worker/review/[id]/actions.ts:336` | BUG-29, DB-20 |

---

## Anexo C. Detalle de los P2 y P3

### 🟡 P2 F-020 · Un tipo recibida/emitida equivocado sobrescribe la contraparte con los datos del cliente y no se detecta aunque su CIF salga en el otro lado · HECHO VERIFICADO

- **Rutas:** `src/lib/processInvoice.ts:328-358`, `src/app/dashboard/client/upload/UploadForm.tsx:57`, `src/app/dashboard/client/upload/UploadForm.tsx:221-228`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:87`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:466-471`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1449-1453`
- **Evidencia:** detectInvoiceType solo corre con typeUnconfirmed; con el tipo declarado se fuerza el lado del cliente aunque el OCR lo lea en el lado contrario. El portal solo ofrece recibidas (por defecto) o emitidas. Al cambiar el tipo en revisión, el lado editable se rellena con los datos del cliente y se pierde lo que leyó el OCR.
- **Por qué importa:** Error de entrada muy frecuente de clientes finales: el gestor reescribe a mano cada contraparte y no se sugieren cuentas.
- **Recomendación:** Ejecutar siempre detectInvoiceType y marcar/corregir si contradice; opción «No lo sé» en el portal; al cambiar el tipo, rellenar con los valores de la extracción y recalcular cuentas. Probar con facturas intragrupo.
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-031 · Faltan índices en claves foráneas y en las columnas de las consultas frecuentes (incidencias, extracciones, historial, auditoría, exportaciones, dedupe, asesoría) · HECHO VERIFICADO

- **Rutas:** `prisma/migrations/00000000000000_init/migration.sql:355-425`, `prisma/schema.prisma:440-442`, `prisma/schema.prisma:473`, `prisma/schema.prisma:505`, `prisma/schema.prisma:534-557`, `prisma/schema.prisma:569-590`, `prisma/schema.prisma:244`, `src/app/dashboard/worker/review/[id]/page.tsx:59-65`, `src/lib/reviewQueue.ts:71-124`, `src/app/dashboard/worker/page.tsx:148`, `src/app/dashboard/admin/page.tsx:79`, `src/app/api/uploads/route.ts:130`, `src/lib/invoiceListing.ts:71`, `src/app/dashboard/admin/audit/page.tsx:81`
- **Evidencia:** Solo hay Invoice(clientId,status), (issuerCif), (periodMonth,periodYear), InvoiceVatLine(invoiceId), AuditLog(invoiceId,createdAt)/(prevId) y uniques; ExportBatchItem empieza por exportBatchId. Sin índice: InvoiceIssue/InvoiceExtraction/InvoiceStatusHistory/ExportBatchItem.invoiceId, Invoice.fileHash/exportBatchId/splitFromId/createdAt, Client/User.advisoryFirmId, WorkerClientAssignment.clientId, Document.clientId, AuditLog.createdAt/userId. (periodMonth,periodYear) no incluye cliente; AccountEntry(clientId) y ProviderRoutingRule(advisoryFirmId) redundantes; filtrar por asesoría exige join con Client.
- **Por qué importa:** Cada apertura de revisión y sus prefetch recorren tablas de todas las asesorías; crear los índices ahora cuesta milisegundos, con millones de filas bloquea escrituras.
- **Recomendación:** Una migración nueva (número a coordinar: la 10 es de Zuhir) con los @@index por invoiceId (+createdAt/status), (changedBy,toStatus,createdAt), AuditLog(createdAt)/(userId), Invoice (clientId,periodYear,periodMonth,type), (clientId,createdAt), (clientId,fileHash), (clientId,issuerCif,invoiceNumber), (exportBatchId), (splitFromId), (status,updatedAt), Client/User(advisoryFirmId) y WorkerClientAssignment(clientId); CONCURRENTLY si ya hay volumen; verificar con EXPLAIN. A medio plazo advisoryFirmId desnormalizado en Invoice/AuditLog.
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-035 · La causa real de un Error OCR no se guarda en ningún sitio consultable y la clasificación diagnostica mal · HECHO VERIFICADO

- **Rutas:** `src/lib/processInvoice.ts:642-690`, `src/lib/ocrLlm.ts:343-366`, `src/lib/storage.ts:67-74`, `src/app/dashboard/admin/invoices/actions.ts:85`
- **Evidencia:** Solo se guarda «[ERR-OCR-00X] mensaje amable»; el error técnico va a console.error sin invoiceId. classifyOcrError/isTransientOcrError usan includes/regex: API key inválida y errores de Prisma → ERR-OCR-002 «ilegible» sin reintento; ECONNREFUSED no se reintenta; un JSON con «1500.00» se toma por 5xx; NoSuchKey no da ERR-OCR-004. «Reprocesar todas» traga errores con .catch(() => {}).
- **Por qué importa:** Un fallo de configuración aparece como «documento ilegible» factura a factura y manda a teclear a mano en vez de avisar al equipo.
- **Recomendación:** Log con invoiceId, fuente, intento y duración; guardar detalle técnico saneado (extracción fallida o columna nueva); OcrError estructurado con provider/httpStatus/kind y nuevo código para configuración/cuota; mostrarlo en la ficha y alertar. Mantener el prefijo [ERR-OCR-XXX].
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-042 · Dar de alta una asesoría exige un script en la terminal del contenedor que choca por username y deja «Demo1234!» por defecto · HECHO VERIFICADO

- **Rutas:** `scripts/bootstrap-admin.mjs:18-51`, `DEPLOY.md:64-77`, `prisma/schema.prisma:164`, `src/app/dashboard/admin/workers/actions.ts:41-52`
- **Evidencia:** Sin panel de operador; ADMIN_USERNAME por defecto es la parte local del email («admin» ya existe, único global): se crea la firma y falla el usuario (P2002), dejando una asesoría sin admin; sin ADMIN_PASSWORD, «Demo1234!».
- **Por qué importa:** Cada alta depende de root en el servidor, deja datos a medias y una contraseña pública.
- **Recomendación:** Script transaccional que exija username único, genere contraseña aleatoria o enlace de invitación y falle claro; más adelante panel de operador.
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-045 · Modelo de despliegue sin decidir: dominio con el nombre de la asesoría y una app multi-tenant con una sola NEXTAUTH_URL · RIESGO PROBABLE

- **Rutas:** `src/lib/email.ts:11`, `src/app/login/forgot-password/actions.ts:13-17`, `src/app/dashboard/admin/clients/actions.ts:154`, `DEPLOY.md:22`
- **Evidencia:** Producción en msassessors.faktury.es; todos los enlaces de correo apuntan a un único host.
- **Por qué importa:** La decisión (instancia única o una por asesoría) fija coste, capacidad, migraciones y urgencia de F-004/F-026.
- **Recomendación:** Decidir antes de la segunda asesoría; recomendado dominio neutro multi-tenant con marca por logo y alias.
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-048 · Cadena de auditoría sin serializar por factura, escrita fuera de la transacción del cambio, sin ancla externa y con una verificación que nadie usa y no escala · HECHO VERIFICADO

- **Rutas:** `src/lib/auditLog.ts:65-125`, `src/lib/auditLog.ts:151-154`, `src/lib/auditLog.ts:213-246`, `src/app/dashboard/worker/review/[id]/actions.ts:488-521`, `src/app/dashboard/worker/review/[id]/actions.ts:644-654`, `src/lib/processInvoice.ts:571`, `src/lib/processInvoice.ts:635`, `src/app/api/admin/verify-audit/route.ts:15-25`, `prisma/migrations/00000000000001_audit_immutability/migration.sql:11-31`, `prisma/schema.prisma:569-590`
- **Evidencia:** appendAuditLogs lee la cabeza con findFirst orderBy createdAt en READ COMMITTED sin bloqueo; createdAt = new Date() por entrada (empates de ms) y la verificación ordena solo por createdAt. Simulado: dos appends concurrentes → prev_hash_mismatch sin manipulación, y el trigger hace la bifurcación permanente. La auditoría va después y fuera de la transacción de datos. Sin ancla: borrar la cola no deja rotura. El bypass por GUC está al alcance del rol de la app y el hash no tiene clave. verifyFirmAuditChains hace N+1 y no se llama desde la UI.
- **Por qué importa:** Falsos positivos de manipulación ante un auditor, cambios sin rastro si falla la auditoría y una verificación inviable a escala.
- **Recomendación:** pg_advisory_xact_lock(hashtext(invoiceId)) o FOR UPDATE; appendAuditLogs(tx, …) en la misma transacción; prevId único (diagnosticar antes); verificar siguiendo prevId y por lotes o en job nocturno con botón en Auditoría; ancla externa (digest diario en S3 con object lock o HMAC) y rol de BD separado. Sin cambiar computeAuditHash.
- **Impacto / esfuerzo:** Alto / M

### 🟡 P2 F-049 · Dos exportaciones a la vez meten las mismas facturas en dos ficheros, y una corrección simultánea al export puede perderse · RIESGO PROBABLE

- **Rutas:** `src/app/api/export/route.ts:97-182`, `src/app/dashboard/admin/export/ExportForm.tsx:95-97`, `src/lib/auditLog.ts:76-120`, `src/app/dashboard/worker/review/[id]/actions.ts:156-170`, `src/app/dashboard/worker/review/[id]/actions.ts:488-521`
- **Evidencia:** findMany sin bloqueo y updateMany sin exportBatchId: null; solo frena el estado downloading de la misma pestaña. Si parseAndSave lee antes de que el export cree los items y escribe después, el export marca la factura con el snapshot antiguo y la corrección no se reexporta.
- **Por qué importa:** Asientos duplicados o rechazados en A3 y correcciones que nunca llegan.
- **Recomendación:** Dentro de la transacción de F-001, reservar con UPDATE … WHERE exportBatchId IS NULL RETURNING id (o advisory lock por firma y cliente) y construir el fichero solo con las reservadas, releyéndolas.
- **Impacto / esfuerzo:** Alto / S

### 🟡 P2 F-050 · Guardar y validar a la vez puede duplicar las líneas de IVA: bloqueo optimista no atómico y sin unicidad (invoiceId, position) · RIESGO PROBABLE

- **Rutas:** `src/app/dashboard/worker/review/[id]/actions.ts:195-201`, `src/app/dashboard/worker/review/[id]/actions.ts:488-503`, `src/lib/processInvoice.ts:571-586`, `prisma/schema.prisma:454`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:675-676`
- **Evidencia:** Se compara updatedAt en memoria y se escribe con update({ where: { id } }); las líneas se reemplazan con deleteMany + createMany en READ COMMITTED, y la segunda transacción no ve las líneas nuevas de la primera; Guardar y Validar usan transiciones independientes.
- **Por qué importa:** Cada InvoiceVatLine es una fila de A3: base y cuota duplicadas en silencio.
- **Recomendación:** @@unique([invoiceId, position]) en migración nueva (diagnosticar antes), updateMany({ id, updatedAt: expected }) comprobando count antes de reemplazar líneas y un único estado ocupado en la UI.
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-051 · Las compras de un cliente en recargo se exportan como «Interior (IVA deducible)» y la marca mezcla minorista y mayorista · RIESGO PROBABLE

- **Rutas:** `prisma/schema.prisma:196-202`, `src/lib/validators.ts:118-127`, `src/lib/exportFormats.ts:232-234`
- **Evidencia:** Nada ajusta el tipo de operación con equivalenceSurchargeCustomer; sale tipo 1. El comentario del schema dice que recibidas y emitidas pueden llevar recargo.
- **Por qué importa:** El minorista en recargo no deduce el IVA soportado: si A3 no lo resuelve por configuración, se importa IVA deducible indebido.
- **Recomendación:** Confirmar con el asesor en A3; si hace falta, código de operación específico y separar «soporta recargo» de «repercute recargo».
- **Impacto / esfuerzo:** Alto / XS

### 🟡 P2 F-052 · La confianza autodeclarada por Gemini guía la revisión: número, fecha y total pueden salir apagados y fuera del Tab, y el resto casi siempre en amarillo · RIESGO PROBABLE

- **Rutas:** `src/components/ui/SmartField.tsx:23-53`, `src/components/ui/SmartField.tsx:367-396`, `src/lib/reviewConstants.ts:1-27`, `src/lib/ocrLlm.ts:232-249`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:745-763`
- **Evidencia:** El prompt trae confianzas de ejemplo fijas (número, fecha y total 0,95; emisor/CIF/importes 0,9; receptor 0,8). Con CONFIDENCE_HIGH = 0,92 «calibrado a ojo» con Document AI, lo ≥0,92 sale gris (borde 1,10:1) con tabIndex -1 y lo demás amarillo. Distribución real no medida.
- **Por qué importa:** La señal no está calibrada: o empuja a validar sin mirar campos que el cuadre no detecta (número, fecha) o se ignora por ubicua.
- **Recomendación:** Medir la distribución real; mismo contraste para todos los campos con check discreto y sin sacarlos del Tab; sustituir la autoconfianza por señales verificables (NIF válido, cuadre, fecha en periodo, histórico del tercero).
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-053 · La ficha de factura del admin es un callejón sin salida y no sirve para diagnosticar · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/invoices/InvoicesTable.tsx:43-51`, `src/app/dashboard/admin/invoices/InvoicesTable.tsx:217-228`, `src/app/dashboard/admin/invoices/[id]/page.tsx:35-115`, `src/app/dashboard/admin/invoices/[id]/page.tsx:153-193`, `src/app/dashboard/admin/audit/page.tsx:165-171`
- **Evidencia:** «Ver»/«Revisar» de pendientes lleva a una ficha sin enlace a la revisión, con el nombre del fichero como título, un solo % de IVA, lastOcrError crudo y grid-cols-3 fijo; no muestra extracciones, ocrAttempts, incidencias, exportaciones ni el actor del historial.
- **Por qué importa:** «¿Qué pasó con esta factura?» obliga a entrar en la BD.
- **Recomendación:** Enlazar pendientes a la revisión; en la ficha «Abrir en revisión», desglose completo y un panel Diagnóstico con línea de tiempo (historial con actor, auditoría, extracciones, exportaciones) y el detalle del último error.
- **Impacto / esfuerzo:** Alto / S · quick win

### 🟡 P2 F-054 · El alta de una asesoría no escala: clientes uno a uno, plan de cuentas por cliente sin guía, asignaciones una a una y sin checklist · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/clients/ClientForm.tsx:14-137`, `src/app/dashboard/admin/clients/actions.ts:65-167`, `src/app/dashboard/admin/clients/[id]/accounts/ImportButton.tsx:33-50`, `src/app/dashboard/admin/workers/[id]/AssignmentsPanel.tsx:27-48`, `src/app/dashboard/worker/page.tsx:71-78`, `src/app/dashboard/admin/page.tsx:220-224`
- **Evidencia:** No hay importación de clientes; el formato del plan solo aparece al fallar; asignación cliente a cliente; paneles vacíos sin guía; ClientForm invita sin avisar y su toast no se ve por el redirect.
- **Por qué importa:** 150 altas, 150 importaciones y 150 asignaciones manuales antes de la primera factura.
- **Recomendación:** Importar clientes desde CSV/Excel con vista previa, plantilla y vista previa del plan, asignación masiva, checklist de arranque y mensajes de estado vacío.
- **Impacto / esfuerzo:** Alto / L

### 🟡 P2 F-055 · No existe validación asistida en bloque de facturas «verificadas»: cada una se abre y valida a mano · POSIBLE MEJORA

- **Rutas:** `src/app/dashboard/admin/invoices/actions.ts:11-14`, `src/lib/reviewConstants.ts:20-27`, `src/app/dashboard/worker/invoices/page.tsx:42-48`
- **Evidencia:** bulkValidateInvoices se quitó a propósito (correcto); CONFIDENCE_AUTO_VALIDATE no se usa; «Listas para validar» solo filtra sin incidencias.
- **Por qué importa:** A miles de facturas por gestor, 15-25 s por factura sin revisión real no escala.
- **Recomendación:** Subbandeja «Verificadas» con criterios estrictos calculados en servidor y validación de la selección auditada, o un modo ráfaga que pare solo en no verificadas.
- **Impacto / esfuerzo:** Alto / M

### 🟡 P2 F-056 · Las transiciones de estado comprueban y escriben en pasos separados, sin condición sobre el estado previo ni transacción común · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/actions.ts:194-201`, `src/app/dashboard/worker/review/[id]/actions.ts:503`, `src/app/dashboard/worker/review/[id]/actions.ts:912-939`, `src/app/dashboard/worker/clasificar/actions.ts:25-118`, `src/app/dashboard/worker/invoices/actions.ts:53-73`, `src/app/dashboard/worker/batch/actions.ts:68`, `src/app/api/cron/retry-stuck/route.ts:32-46`, `src/app/api/uploads/route.ts:175-187`, `src/lib/reviewQueue.ts:101`
- **Evidencia:** 14 invoiceStatusHistory.create en 9 ficheros y ~15 update({ where: { id } }) tras leer; listas de estados duplicadas (POSPONIBLES, draftStatuses, PROCESSABLE_STATUSES, HECHAS). reject, classify, quickRejectDuplicate y reproceso sin condición; estado, historial y auditoría en operaciones separadas; el cron relanza por updatedAt aunque el primer proceso siga vivo; Document e Invoice se crean por separado. Solo rejectBatch lo hace bien.
- **Por qué importa:** Gana la última escritura: dobles historiales y emails, un rechazo que pisa una validación, estados imposibles.
- **Recomendación:** transitionInvoice(tx, { id, from, to, by, reason, expectedUpdatedAt }) en src/lib con updateMany condicional + historial + auditoría y tabla de transiciones en invoiceStatuses.ts; lease para el cron; migrar acción a acción con tests.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-057 · Las incidencias no se cierran al validar, rechazar ni reprocesar, y cada reproceso crea otras nuevas · HECHO VERIFICADO

- **Rutas:** `src/lib/issueDetector.ts:199-209`, `src/lib/processInvoice.ts:298`, `src/app/api/invoices/[id]/process/route.ts:54-84`, `src/app/dashboard/worker/review/[id]/actions.ts:520-533`, `src/app/dashboard/worker/review/[id]/actions.ts:887-988`, `src/lib/reviewQueue.ts:74-81`, `src/app/dashboard/worker/issues/page.tsx:44-45`
- **Evidencia:** detectIssues hace createMany en cada ejecución y nada cierra las OPEN previas; solo resolveIssue/dismissIssue y los botones de duplicado las tocan; cualquier OPEN manda la factura al bucket «attention».
- **Por qué importa:** Facturas que no salen de «Con incidencias» aunque el OCR nuevo sea limpio y contadores inflados, base de F-016 y F-055.
- **Recomendación:** Al reprocesar, cerrar las automáticas OPEN (resolvedBy sistema) en la misma transacción; al validar marcarlas RESOLVED; al rechazar DISMISSED.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-058 · El cuadre tiene dos tolerancias en cinco sitios y el servidor permite validar descuadradas · HECHO VERIFICADO

- **Rutas:** `src/lib/invoiceBalance.ts:1`, `src/lib/processInvoice.ts:150-156`, `src/lib/processInvoice.ts:557-566`, `src/app/dashboard/worker/review/[id]/actions.ts:385-396`, `src/app/dashboard/worker/review/[id]/actions.ts:433-435`, `src/lib/issueDetector.ts:114-116`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:715-722`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:945`, `src/lib/exportFormats.ts:400-404`
- **Evidencia:** invoiceBalance.ts dice ser el sitio único, pero processInvoice, actions e issueDetector usan ≤ 2 céntimos y ReviewForm/export exigen 0. Simulado: 121,01 con 100 + 21 → válida y sin MATH_MISMATCH en servidor, bloqueada en la UI y avisada en el export. El bloque del servidor está vacío.
- **Por qué importa:** La misma factura es limpia en la cola y descuadrada al revisar; el gestor maquilla un importe.
- **Recomendación:** Una constante BALANCE_TOLERANCE_CENTS e invoiceBalanceDiffCents en todos los sitios, decidir si el servidor bloquea y borrar el bloque vacío; test de contrato.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-059 · Redondeos en coma flotante fallan un céntimo (IRPF con toFixed, cuota negativa) y, con cuadre exacto y cuota de retención de solo lectura, obligan a retocar importes · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:535-540`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:592-661`, `src/lib/equivalenceSurcharge.ts:47`, `src/lib/processInvoice.ts:482-486`, `src/app/dashboard/worker/review/[id]/actions.ts:278`, `src/lib/invoiceBalance.ts:1-17`
- **Evidencia:** Recorrido 0,01-20.000 €: con toFixed fallan 96.000 bases al 10 %, 48.000 al 15 % y 3.840 al 5,2 %; con Math.round(b*r)/100, 2.185 al 15 %. 100,50 × 15 % → 15,07; 333,30 × 15 % → 49,99; 10,50 × 21 % → 2,21 pero −10,50 → −2,20. El IRPF calculado pisa el leído.
- **Por qué importa:** El descuadre de un céntimo bloquea la validación y la única salida es falsear base, % o total.
- **Recomendación:** Helper común en céntimos enteros half-away-from-zero; no sustituir el importe leído si cuadra a ±1 céntimo; cuota de retención editable.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-060 · La extracción con Gemini descarta todas las líneas de IVA al 0 %: en facturas mixtas se pierden exentos y suplidos · HECHO VERIFICADO

- **Rutas:** `src/lib/ocrLlm.ts:385-393`, `src/lib/processInvoice.ts:148-156`, `src/lib/processInvoice.ts:289`, `src/lib/processInvoice.ts:612`, `src/app/dashboard/worker/review/[id]/page.tsx:194-211`
- **Evidencia:** `.filter((l) => l.vatRate > 0)` en parseGeminiResponse. En una mixta (1.000 al 21 % + 50 al 0 %) sobrevive solo la del 21 %: MATH_MISMATCH; en clientes en recargo proposeSurchargesFromTotal puede inventar un recargo para explicar la diferencia.
- **Por qué importa:** Trabajo manual en cada factura mixta y riesgo de recargo inventado.
- **Recomendación:** Conservar las líneas con vatRate 0 y base ≠ 0; test con factura mixta.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-061 · La deduplicación por hash en la subida no es atómica: copias del mismo PDF en un lote entran dos veces sin aviso · RIESGO PROBABLE

- **Rutas:** `src/app/api/uploads/route.ts:127-141`, `src/app/api/uploads/route.ts:163`, `src/app/api/uploads/route.ts:187`, `prisma/schema.prisma:310`, `src/lib/uploadDirectClient.ts:88-116`, `src/lib/uploadDirectClient.ts:402-427`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:102-106`
- **Evidencia:** findFirst({ clientId, fileHash, status ≠ REJECTED }) → putObject → create, sin transacción ni índice (fileHash String?); el navegador sube 3 en paralelo y solo deduplica por nombre + tamaño; en modo clasificar no hay dedupe por hash; los dos OCR corren a la vez y el detector no ve a la otra hasta que termina.
- **Por qué importa:** Dos facturas idénticas validables y exportables.
- **Recomendación:** Índice único parcial (clientId, fileHash) WHERE status NOT IN ('REJECTED','SPLIT_SOURCE','PENDING_ROUTING') tras limpiar existentes y tratar P2002 como duplicado, o advisory lock; dedupe por hash en el cliente y al rutear.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-062 · Dividir una factura no es atómico y las hijas pierden datos de la original · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/actions.ts:1027-1112`, `src/app/dashboard/worker/review/[id]/actions.ts:1171-1281`
- **Evidencia:** Por ticket: putObject → document.create → invoice.create; un return { error } a mitad deja k−1 hijas en UPLOADED sin OCR (el after() se registra al final) y la original igual; reintentar duplica. PDFDocument.load sin try lanza con PDF cifrado. Las hijas no heredan typeUnconfirmed, periodType ni periodo contable.
- **Por qué importa:** Duplicados, facturas atascadas y ventas clasificadas como compras sin confirmar.
- **Recomendación:** Subir todo primero; una $transaction con hijas y SPLIT_SOURCE condicionado; after() tras el commit y limpieza de objetos si falla; heredar campos; try/catch en PDFDocument.load.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-063 · La re-subida del cliente no comprueba cierre ni hash, pierde periodType, repite el periodo equivocado y la fila sigue «Rechazada» · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/client/invoices/reupload-actions.ts:45`, `src/app/dashboard/client/invoices/reupload-actions.ts:64-67`, `src/app/dashboard/client/invoices/reupload-actions.ts:81-106`, `src/app/dashboard/client/invoices/page.tsx:267-272`, `src/app/dashboard/client/invoices/ReuploadButton.tsx:19-23`, `src/app/dashboard/worker/batch/page.tsx:141`, `prisma/schema.prisma:328`
- **Evidencia:** No llama a assertUploadPeriodOpen; solo compara el hash con la rechazada; crea la nueva sin periodType (MONTHLY por defecto) con el periodo de la rechazada (aunque se rechazara por WRONG_PERIOD); no avisa a los gestores; un doble envío lanza P2002 dejando Document y objeto huérfanos; el listado no consulta replacedBy ni muestra éxito. Las hijas de división tienen el mismo problema de periodType. (Las líneas 236-326 citadas por BUG-20/26 no existen: el fichero tiene 116.)
- **Por qué importa:** Facturas en periodos cerrados, lotes fantasma trimestrales/mensuales y un cliente que no sabe si su corrección llegó.
- **Recomendación:** Reutilizar la lógica de /api/uploads (acceso, cierre, dedupe, periodType), dejar elegir periodo, capturar P2002, avisar al gestor, mostrar «Sustituida por una nueva versión» y el motivo del rechazo en la revisión.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-064 · El alta de facturas está duplicada en cuatro sitios con reglas distintas · HECHO VERIFICADO

- **Rutas:** `src/app/api/uploads/route.ts:175-202`, `src/app/dashboard/worker/review/[id]/actions.ts:1055-1083`, `src/app/dashboard/worker/review/[id]/actions.ts:1224-1252`, `src/app/dashboard/client/invoices/reupload-actions.ts:81-106`, `src/app/dashboard/worker/batch/actions.ts:176`
- **Evidencia:** document.create + invoice.create en subida, dos divisiones y re-subida; ya divergen en periodType, typeUnconfirmed, cierre, dedupe y avisos («Rechazar lote T1» filtra por periodType).
- **Por qué importa:** Cada regla nueva hay que ponerla en cuatro sitios.
- **Recomendación:** createInvoiceFromFile en src/lib con validación de periodo, dedupe, clave con id aleatorio y encolado del OCR; mientras, copiar periodType.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-065 · Las facturas clasificadas a mano desde «Por clasificar» no reciben lo aprendido del tercero ni el detector de incidencias completo · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/clasificar/actions.ts:56-118`, `src/lib/processInvoice.ts:275-298`, `src/lib/processInvoice.ts:379-476`, `src/app/dashboard/worker/review/[id]/page.tsx:175-182`
- **Evidencia:** Con isUnclassified, clientRecord es null (sin recargo), issues = [] y AccountEntry se busca con el cliente buzón; classifyInvoice solo fuerza la parte del cliente, dedupe CIF+número y estado según un isValid calculado sin cliente; la revisión no aplica defaultOperationType.
- **Por qué importa:** Un subcontratista aprendido como ISP entra como Interior sin descuadre ni aviso.
- **Recomendación:** Extraer de processInvoice una función «aplicar contexto de cliente» (aprendizaje, recargo, detectIssues) y usarla en el ruteo y en la clasificación manual.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-066 · Huecos en el bloqueo por periodo cerrado: el servidor comprueba el periodo contable que envía el formulario y otras vías no miran el cierre · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/actions.ts:177-192`, `src/app/dashboard/admin/closures/actions.ts:7-49`, `src/app/dashboard/worker/batch/actions.ts:68-80`, `src/app/dashboard/client/invoices/reupload-actions.ts:81-106`, `src/app/api/invoices/[id]/process/route.ts:12`
- **Evidencia:** `checkMonth = parseInt2(data.accountingPeriodMonth) ?? …`: enviar un mes abierto permite modificar una factura de un periodo cerrado y sacarla de él (la UI lo impide, el servidor no). closePeriod en Cierres no exige cero pendientes (sí closePeriodFromBatch); re-subida y reproceso no miran el cierre. Rechazar y dividir con periodo cerrado ya están en curso (fixes #1 y #5).
- **Por qué importa:** El cierre deja de garantizar que lo declarado no cambia.
- **Recomendación:** assertPeriodOpen común contra el periodo guardado y el de destino en todas las acciones que escriben facturas; en Cierres exigir cero pendientes o confirmación.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-067 · La auditoría solo cubre facturas: cierres/reaperturas se sobrescriben y no se registran accesos ni acciones de administración · HECHO VERIFICADO

- **Rutas:** `prisma/schema.prisma:569-604`, `src/app/dashboard/admin/closures/actions.ts:31-66`, `src/app/dashboard/worker/batch/actions.ts:95-115`, `src/app/dashboard/admin/workers/actions.ts`, `src/app/dashboard/admin/clients/[id]/accounts/actions.ts`, `src/app/dashboard/admin/settings/actions.ts`, `src/app/api/invoices/[id]/raw/route.ts`
- **Evidencia:** AuditLog.invoiceId es obligatorio; el upsert de cierre pone reopenedAt/By a null y sobrescribe closedBy al volver a cerrar; sin rastro de altas/bajas de usuarios, asignaciones, plan de cuentas, ajustes, logins ni descargas de PDF.
- **Por qué importa:** «¿Quién reabrió marzo?» es la primera pregunta de una revisión y hoy no tiene respuesta; tampoco se puede investigar una brecha en 72 h.
- **Recomendación:** Tabla append-only de eventos de asesoría (actor, acción, entidad, before/after, IP) con el trigger de inmutabilidad, o al menos PeriodClosureEvent, visible en Auditoría.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-068 · Con Gemini no se guarda lo que respondió la IA, ni con qué modelo, ni por qué se fue a multimodal · HECHO VERIFICADO

- **Rutas:** `src/lib/ocrLlm.ts:79-81`, `src/lib/ocrLlm.ts:337-350`, `src/lib/ocrLlm.ts:393`, `src/lib/ocrLlm.ts:485`, `src/lib/ocrLlm.ts:507`, `src/lib/processInvoice.ts:141-187`
- **Evidencia:** rawJson = { source, textLength, boundingBoxes }: sin el JSON del modelo, modelo, finishReason ni usage; InvoiceExtraction no guarda vatLines ni recargo; el fallo de pdfjs no deja motivo; maxOutputTokens 1024 puede cortar respuestas.
- **Por qué importa:** No se puede saber si un importe lo leyó mal la IA, lo cambió el pipeline o el gestor, ni medir coste o calidad por modelo.
- **Recomendación:** Añadir model, finishReason, usageMetadata, texto JSON del modelo y fallbackReason manteniendo boundingBoxes en la raíz.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-069 · El Excel exportado no se guarda y el lote no registra nombre, hash, filas, excluidas ni asesoría; el snapshot no se ve en ninguna pantalla · HECHO VERIFICADO

- **Rutas:** `prisma/schema.prisma:518-544`, `src/app/api/export/route.ts:118-175`, `src/app/dashboard/admin/export/page.tsx:96-128`, `src/app/dashboard/admin/invoices/[id]/page.tsx:39`, `scripts/backfill-hardening.ts:55-71`
- **Evidencia:** ExportBatch sin storageKey, sha256, filename, rowCount ni advisoryFirmId; el historial no enlaza detalle ni descarga; los snapshots legacy del backfill no son los del momento del export.
- **Por qué importa:** No se puede responder qué fichero contenía una factura para conciliar con A3.
- **Recomendación:** Guardar el xlsx y sus metadatos (migración compartida con F-001/F-004), página de detalle del lote y sección «Exportaciones» en la ficha de factura.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-070 · El export no controla duplicados (sentido, NIF del tercero y número) ni en el lote ni frente a lo ya exportado · HECHO VERIFICADO

- **Rutas:** `src/lib/exportFormats.ts:283-454`, `src/lib/issueDetector.ts:144-196`
- **Evidencia:** validateForA3Export no agrupa por esa clave; la única detección es la del OCR, no bloqueante y sin repetirse tras corregir.
- **Por qué importa:** Foto y PDF validados por separado salen dos veces; A3 rechaza o duplica.
- **Recomendación:** Agrupar por (type, NIF normalizado, número) y avisar/bloquear, también contra facturas ya exportadas.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-071 · La descarga del export es un GET con efectos que, sin parámetros, consume todo lo pendiente de la asesoría · HECHO VERIFICADO

- **Rutas:** `src/app/api/export/route.ts:9-64`, `src/app/api/export/route.ts:117-193`, `src/app/dashboard/admin/export/ExportForm.tsx:98-110`
- **Evidencia:** GET crea el lote y marca facturas; clientId, month y year son opcionales; cookies SameSite=Lax permiten una navegación externa o un prefetch.
- **Por qué importa:** Un enlace o una precarga marca como exportadas facturas sin que el admin lo pretenda; con F-001 pueden perderse.
- **Recomendación:** GET solo para vista previa; descarga por POST con clientId y periodo obligatorios y comprobación de Origin/Sec-Fetch-Site.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-072 · El recargo propuesto a partir del total no se distingue de uno leído, puede explicar un descuadre que no es recargo y reparte el céntimo por su cuenta · HECHO VERIFICADO

- **Rutas:** `src/lib/equivalenceSurcharge.ts:134-185`, `src/lib/processInvoice.ts:282-293`, `src/lib/processInvoice.ts:540-551`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2105-2135`
- **Evidencia:** Simulado: 250 € al 21 % con total 315,50 por unos portes perdidos → propone recargo 5,2 % por 13,00; con 52,02/4,68 impresos propone 52,03/4,67. Se aplica también en ventas y se guarda igual que uno leído, sin marca ni auditoría.
- **Por qué importa:** Un recargo inventado o repartido distinto del impreso cuadra y ningún control lo detecta.
- **Recomendación:** Marcar origen leído/propuesto o crear incidencia, proponer solo en compras y no absorber el residuo.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-073 · Retención IRPF: el importe leído se sustituye por base × %, solo se aprende en compras a personas físicas, la cuota no es editable y en A3 va solo en la primera fila · HECHO VERIFICADO

- **Rutas:** `src/lib/processInvoice.ts:437-486`, `src/app/dashboard/worker/review/[id]/actions.ts:567-573`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:535-560`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2054-2062`, `src/lib/exportFormats.ts:235-239`, `src/lib/validators.ts:350-362`
- **Evidencia:** Con 15 % aprendido y 7 % impreso sale 150 en vez de 70 y va a la cola limpia (detectIssues ya corrió); learnIsPF usa el NIF del tercero (en ventas el cliente final, en alquiler a SL nunca aprende); cuota readOnly; en el Excel la fila 1 lleva la base de esa línea con la cuota total. textMentionsRetention da true con «periodo de retención» (latente mientras F-013).
- **Por qué importa:** Modelos 111/115 y pagos fraccionados: cada venta de profesional y cada alquiler se teclean a mano todos los meses y el importe impreso se pisa sin rastro.
- **Recomendación:** No recalcular si el OCR leyó el importe; aprender por sentido (ventas de profesional, alquileres con sociedades); cuota editable con aviso; confirmar con A3 el reparto por filas; excluir «retención de datos».
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-074 · Tipo de operación por defecto discutible: fuera de la UE siempre «Importación» (también servicios), extranjero sin prefijo como Interior, GR/XI no reconocidos · RIESGO PROBABLE

- **Rutas:** `src/lib/validators.ts:79-90`, `src/lib/validators.ts:247-271`, `src/lib/exportFormats.ts:337-342`
- **Evidencia:** Simulado: GR123456789 y XI123456789 → INTERIOR; CHE-123.456.789 → IMPORTACION; SaaS de EE. UU. sin VAT → INTERIOR sin aviso.
- **Por qué importa:** Un servicio de fuera de la UE es ISP (art. 84.Uno.2º LIVA), no importación; como interior al 0 % queda sin autoliquidar.
- **Recomendación:** No UE + SERVICIOS → proponer INVERSION_SP; aviso si el NIF no es español válido y no hay país; GR como alias de EL y XI; validar con el asesor.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-075 · El Excel añade «_R» al número real de una rectificativa y no lleva la referencia a la rectificada · HECHO VERIFICADO

- **Rutas:** `src/lib/exportFormats.ts:249-260`, `src/lib/exportFingerprint.ts:114-116`
- **Evidencia:** Simulado: R-2026-0003 → «R-2026-0003_R» en C y D, aunque la rectificativa tiene numeración propia.
- **Por qué importa:** El libro de expedidas (y SII/Verifactu desde A3) lleva un número que no existe.
- **Recomendación:** Exportar el número tal cual y sufijar solo si colisiona, con aviso; coordinar con la huella para no reexportar en masa.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-076 · Los CIF con dígito de control 0 y letra «J» se dan por inválidos · HECHO VERIFICADO

- **Rutas:** `src/lib/validators.ts:53-58`, `src/app/dashboard/admin/clients/actions.ts:18`, `src/lib/invoiceRouting.ts:65`, `src/lib/invoiceRouting.ts:105`
- **Evidencia:** `String.fromCharCode(64 + control)` da «@» con control 0 (la tabla oficial es JABCDEFGHI). Simulado: P2800004J → inválido.
- **Por qué importa:** Entidades con letra de control (ayuntamientos, fundaciones, extranjeras) no se pueden dar de alta ni rutear por CIF.
- **Recomendación:** `"JABCDEFGHI"[control]` y test con un CIF real terminado en J.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-077 · El plan de cuentas aprendido se sobrescribe con la cuenta de la última factura validada, incluida la genérica de tickets, sin rastro · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/actions.ts:558-563`, `src/app/dashboard/worker/review/[id]/actions.ts:606-641`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2320-2325`, `src/lib/accountingAccount.ts:129-144`
- **Evidencia:** learnAccountsForDirection guarda lo usado al validar, incluido lo que puso «Usar cuenta genérica», sin confirmación ni historial.
- **Por qué importa:** Una validación con la genérica o un error de tecleo cambia la cuenta autorrellenada de todas las siguientes del tercero.
- **Recomendación:** No aprender la genérica, pedir confirmación al cambiar una cuenta ya aprendida y auditar AccountEntry.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-078 · Longitud de cuenta fija en 8 dígitos; exportConfig.accountLength no se usa ni tiene interfaz · HECHO VERIFICADO

- **Rutas:** `src/lib/accountingAccount.ts:1-45`, `src/lib/accountingAccount.ts:87-90`, `src/lib/exportFormats.ts:20-25`, `src/app/api/export/route.ts:196-203`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2274-2311`, `prisma/schema.prisma:189-190`
- **Evidencia:** MAX_DIGITS = 8 corta al teclear y rellena al exportar; normalizePlanAccount deja otras longitudes del plan importado; nadie lee ni escribe accountLength; sin cuentas por defecto a nivel de asesoría.
- **Por qué importa:** Asesorías con subcuentas de 9-12 dígitos no pueden usar sus cuentas (no afecta al piloto).
- **Recomendación:** Ajustes contables por asesoría/cliente: longitud, cuentas genéricas por defecto y formato, aplicados al teclear, importar y exportar.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-079 · Las ventas con inversión del sujeto pasivo o exentas/no sujetas no se pueden expresar y salen como Interior 0 % · RIESGO PROBABLE

- **Rutas:** `src/lib/validators.ts:108-116`, `src/lib/validators.ts:160-178`, `src/lib/exportFormats.ts:230-234`, `src/lib/exportFormats.ts:294-306`
- **Evidencia:** OPERATION_TYPE_OPTIONS.SALE solo tiene INTERIOR, INTRACOM e IMPORTACION; el mapa por sentido está pendiente de confirmar; tipo desconocido → 1 sin aviso; retentionType no se exporta. No contrastado con la plantilla oficial.
- **Por qué importa:** Un subcontratista de obra con ISP o un cliente con ventas exentas aparece en otra casilla del 303 y sin marca para 340/347.
- **Recomendación:** Confirmar códigos de expedidas con el asesor, bifurcar por sentido y avisar de ventas al 0 % con tipo Interior.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-080 · Pool y timeouts de BD por defecto: 10 conexiones, maxWait 2 s, sin statement_timeout ni métricas · RIESGO PROBABLE

- **Rutas:** `src/lib/prisma.ts:9`, `src/lib/auditLog.ts:76`, `src/lib/processInvoice.ts:642`
- **Evidencia:** PrismaPg crea pg.Pool max 10; sin transactionOptions (maxWait 2.000, timeout 5.000); páginas con 4-6 consultas en paralelo; sin statement_timeout ni pg_stat_statements.
- **Por qué importa:** Con OCR concurrente y páginas pesadas, la auditoría de OCR falla por pool y la factura acaba en Error OCR tras pagar Gemini.
- **Recomendación:** max 20, connectionTimeoutMillis, statement_timeout 15 s, transactionOptions (5 s/15 s) revisando max_connections; pg_stat_statements y log_min_duration_statement.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-081 · Prefetch completo de revisiones y refrescos periódicos que relanzan todos los prefetch, también con la pestaña oculta · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/batch/page.tsx:448-458`, `src/app/dashboard/worker/page.tsx:441`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1132-1144`, `src/components/ui/AutoRefresh.tsx:23`, `src/components/ui/OcrProcessingBanner.tsx:32`, `node_modules/next/dist/client/components/links.js:270`
- **Evidencia:** <Link prefetch> en tarjetas y flechas; en Next 16.2.1 router.refresh() vuelve a programar el prefetch de todos los enlaces visibles; AutoRefresh (5 s) y el banner (3 s) no miran document.hidden ni tienen tope.
- **Por qué importa:** Una pestaña de fondo con una factura atascada lanza cientos de consultas cada 5 s todo el día.
- **Recomendación:** Quitar prefetch de tarjetas y panel; pausar con visibilitychange, back-off y parada a los 5-10 min, o sondear un endpoint mínimo.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-082 · La ETA del OCR recalcula la media de todas las extracciones de la asesoría en cada refresco · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/batch/page.tsx:209`, `src/app/dashboard/admin/batch/page.tsx:193`, `src/app/dashboard/worker/review/[id]/page.tsx:218-227`
- **Evidencia:** invoiceExtraction.aggregate(_avg ocrDurationMs) con join a Invoice y Client, sin límite ni índice, cada 3-5 s.
- **Por qué importa:** Un dato decorativo recorre una de las tablas que más crece en los picos.
- **Recomendación:** Cachear por asesoría 10-15 min o calcular sobre las últimas 200 con índice.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-083 · La búsqueda de texto trae todas las facturas del filtro y filtra en JavaScript · HECHO VERIFICADO

- **Rutas:** `src/lib/invoiceListing.ts:21-40`, `src/app/dashboard/worker/invoices/page.tsx:106`, `src/app/dashboard/admin/invoices/page.tsx:88`
- **Evidencia:** matchingInvoiceIds hace findMany sin take sobre todo el histórico; medido sin BD: 60.000 filas → ~0,4 s de materialización + 0,25-0,45 s de filtro; se lanza a los 400 ms sin mínimo de caracteres. Alimenta el id IN del fallo #11 en curso.
- **Por qué importa:** Cada búsqueda cuesta según todo el histórico en el proceso compartido.
- **Recomendación:** unaccent + pg_trgm con columna generada e índice GIN; mientras, mínimo 3 caracteres y periodo por defecto. Coordinar con el fix #11.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-084 · El desplegable de campos de Auditoría carga todas las filas de auditoría de la asesoría · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/audit/page.tsx:81-102`
- **Evidencia:** findMany distinct field: Prisma 7.5 genera SELECT sin DISTINCT y deduplica en memoria; count y OFFSET ordenados por createdAt sin índice.
- **Por qué importa:** AuditLog es la tabla más grande (6-12 filas por factura).
- **Recomendación:** groupBy({ by: ['field'] }) o lista fija de campos; índice de createdAt (F-031).
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-085 · El panel del admin carga el estado de todas las facturas para 4 clientes y ordena toda la auditoría para 5 filas · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/page.tsx:79`, `src/app/dashboard/admin/page.tsx:85-91`
- **Evidencia:** client.findMany include invoices { status } sin límite; auditLog.findMany orderBy createdAt take 5 con join y sin índice.
- **Por qué importa:** Página de entrada que crece con el histórico de todas las asesorías.
- **Recomendación:** groupBy por cliente y estado en periodos abiertos; índice AuditLog(createdAt) y ventana de 30 días.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-086 · El visor descarga el PDF dos veces por revisión y /raw lo carga entero en memoria con varias copias · HECHO VERIFICADO

- **Rutas:** `src/components/ui/PdfViewer.tsx:155`, `src/components/ui/PdfViewer.tsx:200-204`, `src/app/api/invoices/[id]/raw/route.ts:35-42`, `src/lib/storage.ts:72-73`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:777-788`
- **Evidencia:** computeClientBboxes vuelve a pedir la URL con getDocument; /raw responde no-store y copia bytes tres veces; el <link rel=prefetch> del siguiente probablemente no se aprovecha (no comprobado en navegador).
- **Por qué importa:** El fichero pasa 2-3 veces por Node por revisión.
- **Recomendación:** Reutilizar el PDFDocumentProxy de onLoadSuccess, stream con transformToWebStream y decidir con criterio RGPD private, max-age o quitar el prefetch.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-087 · «Reprocesar todas» las Error OCR: auditoría de todas en una transacción, OCR en serie en un after() de horas, errores tragados y sin progreso · RIESGO PROBABLE

- **Rutas:** `src/app/dashboard/admin/invoices/actions.ts:37-46`, `src/app/dashboard/admin/invoices/actions.ts:62-87`
- **Evidencia:** 2N escrituras en serie, appendAuditLogs de todas sin trocear, un after() en serie con .catch(() => {}); sin resumen. Además firmId ?? undefined (uno de los 7 conocidos, F-004).
- **Por qué importa:** Con cientos de errores la acción lanza a la UI con las facturas ya en UPLOADED y sin after(); si no, horas de trabajo que corta cualquier redeploy.
- **Recomendación:** Trocear auditoría, updateMany/createMany, encolar en F-029, exigir firma y registrar resumen ok/error.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-088 · Importar el plan de cuentas hace un upsert por fila en serie y la tabla pagina en el navegador · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/clients/[id]/accounts/actions.ts:54-56`, `src/app/dashboard/admin/clients/[id]/accounts/page.tsx:21`
- **Evidencia:** for … await accountEntry.upsert; la página carga todas las cuentas y AccountsTable pagina de 50 en 50.
- **Por qué importa:** Planes de miles de terceros tardan decenas de segundos por cliente en el alta.
- **Recomendación:** INSERT … ON CONFLICT desde arrays en tandas de 1.000 conservando la regla de columnas; paginar en servidor.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-089 · El límite de subida de 20 MB no cabe en el envío inline a Gemini: ficheros de más de ~15 MB fallan siempre · RIESGO PROBABLE

- **Rutas:** `src/app/api/uploads/route.ts:29`, `src/lib/ocrLlm.ts:500`, `src/lib/processInvoice.ts:675-679`
- **Evidencia:** Base64 inline añade un 33 % y el límite inline documentado de Gemini ronda 20 MB (a confirmar); el 400 no es transitorio y queda en Error OCR genérico; con F-013 afecta también a PDFs digitales.
- **Por qué importa:** Fallo determinista que el usuario reprocesa en vano.
- **Recomendación:** File API de Gemini para ficheros grandes o bajar el límite a ~14 MB con mensaje claro; reconocer el error de tamaño.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-090 · xlsx 0.18.5 con CVE conocidos (prototype pollution y ReDoS) al leer el plan de cuentas subido · RIESGO PROBABLE

- **Rutas:** `package.json:33`, `src/app/dashboard/admin/clients/[id]/accounts/actions.ts:28-37`
- **Evidencia:** CVE-2023-30533 (corregido en 0.19.3) y CVE-2024-22363 (0.20.2); XLSX.read de ficheros de hasta 10 MB; SheetJS ya no publica en npm.
- **Por qué importa:** El proceso Node es compartido por todas las asesorías.
- **Recomendación:** xlsx 0.20.3 desde el CDN oficial o exceljs para leer, justificado en el commit; limitar filas y columnas.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-091 · Control de fuerza bruta incompleto: rate limit solo en loginAction y contador de fallos no atómico · HECHO VERIFICADO

- **Rutas:** `src/lib/auth.ts:58-84`, `src/app/login/actions.ts:21-26`, `src/app/api/auth/[...nextauth]/route.ts:3`
- **Evidencia:** El endpoint de Auth.js no pasa por el rate limit; failedAttempts se lee y escribe +1, así que peticiones en paralelo leen el mismo valor.
- **Por qué importa:** El límite efectivo de intentos es mayor que el previsto (el bloqueo por usuario sigue actuando).
- **Recomendación:** increment atómico y decisión con el valor devuelto, rate limit dentro de authorize por usuario e IP, 2FA para ADMIN.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-092 · El bloqueo a los 3 intentos es fácil de provocar por terceros, se muestra como «contraseña incorrecta» y no se puede ver ni desbloquear · HECHO VERIFICADO

- **Rutas:** `src/lib/auth.ts:13-14`, `src/lib/auth.ts:62-83`, `src/app/login/actions.ts:34-46`, `node_modules/@auth/core/lib/actions/callback/index.js:385-390`, `node_modules/@auth/core/errors.js:9-31`, `src/app/dashboard/admin/workers/actions.ts:46`
- **Evidencia:** LOCK_ATTEMPTS = 3 durante 15 min sin tener en cuenta la IP; el usuario es el email; sin bcrypt con usuario inexistente (enumeración por tiempo). Auth.js envuelve el Error('ACCOUNT_LOCKED') en CallbackRouteError cuyo message es «Read more at …», así que loginAction nunca detecta el bloqueo y devuelve INVALID_CREDENTIALS. Sin pantalla de desbloqueo ni lastLoginAt.
- **Por qué importa:** Genera llamadas de soporte, bloqueos de ADMIN y enumeración de cuentas.
- **Recomendación:** Leer error.cause.err.message; 5-10 intentos con retraso progresivo y límite por IP; bcrypt contra hash ficticio; desbloqueo auditado en Gestores y lastLoginAt.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-093 · Higiene de credenciales: contraseña por defecto en scripts, mínimo de 8 caracteres, sin 2FA y tokens de restablecimiento en claro sin FK ni limpieza · HECHO VERIFICADO

- **Rutas:** `scripts/bootstrap-admin.mjs:18-23`, `src/app/login/forgot-password/actions.ts:44-49`, `src/app/login/reset-password/actions.ts:34`, `src/app/dashboard/admin/clients/actions.ts:124-129`, `prisma/schema.prisma:609`, `src/lib/demoSeed.ts:118`
- **Evidencia:** «Demo1234!» si falta ADMIN_PASSWORD; PasswordResetToken.token guarda el UUID tal cual, invitaciones de 72 h, sin FK a User ni limpieza de caducados.
- **Por qué importa:** Quien lea la BD o un backup toma cualquier cuenta con invitación o reset pendiente.
- **Recomendación:** Abortar sin contraseña, guardar sha256(token), FK con Cascade y limpieza periódica, invitación para gestores y 2FA para ADMIN.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-094 · Subidas sin límite de cuerpo previo, rate limit ni cuota · RIESGO PROBABLE

- **Rutas:** `src/app/api/uploads/route.ts:45-72`
- **Evidencia:** req.formData() se lee antes de comprobar el tamaño; sin rate limit ni cuota de OCR.
- **Por qué importa:** Coste de OCR y memoria del único contenedor.
- **Recomendación:** Comprobar Content-Length, límite en el proxy, rate limit por usuario y cuota por asesoría.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-095 · CSP permisiva ('unsafe-inline', 'unsafe-eval', connect-src https:) y cabecera X-Powered-By · POSIBLE MEJORA

- **Rutas:** `next.config.ts:8-20`
- **Evidencia:** La CSP global permite scripts inline y eval y cualquier destino https.
- **Por qué importa:** Reduce poco el impacto de una XSS como F-002.
- **Recomendación:** Nonces por ruta, connect-src restringido y poweredByHeader: false.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-096 · Sin vigilancia automática de dependencias (next-auth en beta, sin npm audit ni Dependabot) · POSIBLE MEJORA

- **Rutas:** `package.json:15-35`
- **Evidencia:** No hay npm audit en ningún pipeline ni bot de actualizaciones (npm audit no ejecutado: requiere red).
- **Por qué importa:** Las vulnerabilidades nuevas pasan desapercibidas.
- **Recomendación:** npm audit en CI y Dependabot/Renovate.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-097 · Errores tragados que se muestran como «no hay datos» o como una causa falsa, y server actions que lanzan a la UI · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/page.tsx:92`, `src/app/dashboard/layout.tsx:23`, `src/app/dashboard/worker/page.tsx:71-76`, `src/app/dashboard/client/page.tsx:19-30`, `src/app/dashboard/admin/invoices/page.tsx:66`, `src/app/dashboard/admin/invoices/page.tsx:106-118`, `src/app/dashboard/worker/invoices/page.tsx:92-140`, `src/app/dashboard/admin/audit/page.tsx:81-105`, `src/app/dashboard/admin/settings/actions.ts:42-44`, `src/app/dashboard/admin/workers/actions.ts:53-55`, `src/app/dashboard/admin/workers/actions.ts:130-134`, `src/app/login/actions.ts:41`, `src/lib/errorCodes.ts:89-95`, `src/app/dashboard/worker/review/[id]/actions.ts:677`
- **Evidencia:** 37 .catch(() => [] / 0 / null) sin log: el panel admin devuelve ceros si falla una consulta, el gestor ve «Todo al día». Acciones que traducen cualquier excepción a «Ese CIF ya está registrado» o «tiene cambios en la auditoría»; UNKNOWN_ERROR del login se pinta como credenciales malas. validateInvoice y otras acciones no tienen try/catch y lanzan a error.tsx, contra AGENTS.md; appError no registra nada.
- **Por qué importa:** Una caída de BD parece falta de trabajo o datos perdidos, y un gestor pierde lo editado.
- **Recomendación:** safeQuery(label, fn) que registre antes de degradar o dejar llegar a error.tsx; withActionErrors que devuelva { error } y registre; distinguir P2002; mensaje propio para UNKNOWN_ERROR.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-098 · Logs sin estructura ni correlación, con datos personales y sin retención definida · HECHO VERIFICADO

- **Rutas:** `src/lib/processInvoice.ts:656`, `src/app/api/uploads/route.ts:207`, `src/app/api/uploads/route.ts:231`, `src/lib/email.ts:26`, `src/lib/ocrLlm.ts:345`, `src/lib/ocrLlm.ts:366`, `src/lib/uploadAccess.ts:25-48`, `src/lib/errorCodes.ts:20-47`, `src/app/dashboard/error.tsx:28-30`
- **Evidencia:** 19 console.* en texto libre sin invoiceId/firmId/userId/requestId; entran correos, 300 caracteres de la respuesta de Gemini con NIF e importes y valores de Prisma; AppError.details con motivos internos al navegador; digest casi invisible; catálogo de códigos usado a medias; sin max-size en los logs de Docker.
- **Por qué importa:** Imposible buscar con 10-100 asesorías y problema RGPD.
- **Recomendación:** Helper log(event, fields) en JSON, enmascarar PII, detalles técnicos a BD saneados (F-035), mensajes genéricos al cliente, rotación de logs y digest visible.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-099 · No queda rastro de las subidas rechazadas ni de los errores de almacenamiento · HECHO VERIFICADO

- **Rutas:** `src/app/api/uploads/route.ts:70-202`, `src/app/api/invoices/[id]/raw/route.ts:45-50`, `src/app/dashboard/admin/invoices/[id]/AdminInvoiceViewer.tsx:21`, `src/app/dashboard/client/invoices/reupload-actions.ts:77-79`
- **Evidencia:** Los rechazos (tamaño, magic bytes, cierre, duplicado, putObject) no se registran; se devuelve el e.message del SDK de S3; putObject y los create no son atómicos y dejan objetos huérfanos.
- **Por qué importa:** «Subí 30 y veo 27» no se puede investigar.
- **Recomendación:** Evento upload_rejected estructurado y log de errores de almacenamiento; mensaje amable con código.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-100 · No hay vista de operador de plataforma ni métricas de salud entre asesorías · POSIBLE MEJORA

- **Rutas:** `prisma/schema.prisma:9-13`, `src/app/dashboard/admin/page.tsx:64-92`
- **Evidencia:** Solo roles ADMIN/WORKER/CLIENT filtrados por firma; toda visión transversal exige SQL en producción.
- **Por qué importa:** Con varias asesorías hay que ver qué asesoría tiene problemas antes de que llame.
- **Recomendación:** Script versionado de consultas de soporte y después una página «Salud» de solo lectura para operadores por lista de emails.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-101 · Gestión de cuentas mínima: gestor y cliente sin «Mi cuenta», contraseña del gestor fijada por el admin, sin reset por el admin ni segundo ADMIN, login «Usuario» cuando es el email · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/settings/actions.ts:111-113`, `src/proxy.ts:7-11`, `src/app/dashboard/admin/workers/actions.ts:10-52`, `src/app/dashboard/admin/workers/WorkerForm.tsx:33-37`, `src/components/layout/Sidebar.tsx:74-97`, `src/components/layout/Topbar.tsx:250-266`, `src/app/login/LoginForm.tsx:102-153`, `src/lib/email.ts:313-347`
- **Evidencia:** changePassword/updateProfile exigen ADMIN; WorkerForm pide la contraseña del gestor; no hay reset para otro usuario, edición de gestores, cambio de rol ni creación de otro ADMIN; exportar y cerrar son solo ADMIN; el username es el email pero el login dice «Usuario».
- **Por qué importa:** Las contraseñas circulan por WhatsApp y si el único admin se va la asesoría no puede exportar ni cerrar.
- **Recomendación:** «Mi cuenta» para todos los roles, alta de gestores por invitación, reenviar invitación/enlace de reset, promover a ADMIN y etiqueta «Email o usuario».
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-102 · Ficheros-dios en el flujo crítico: ReviewForm (2.674 líneas), actions de revisión (1.333, parseAndSave no testable) y processInvoice · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:321`, `src/app/dashboard/worker/review/[id]/actions.ts:1`, `src/app/dashboard/worker/review/[id]/actions.ts:117-150`, `src/app/dashboard/worker/review/[id]/actions.ts:152-657`, `src/lib/processInvoice.ts:61-658`, `AGENTS.md:62`
- **Evidencia:** ReviewForm con 44 useState y reglas de negocio propias; parseAndSave (parseo, firma de abonos, diff de auditoría, reexportación, aprendizaje) vive en un fichero "use server" con imports de Next contra AGENTS.md, y escribe historial, AccountEntry y auditoría fuera de su única transacción; splitInvoice/splitPdfInvoice duplican ~120 líneas; processInvoice sin tests. 9 de los 22 fallos en curso están aquí.
- **Por qué importa:** Cada arreglo toca los mismos ficheros sin tests que detecten efectos cruzados.
- **Recomendación:** Extraer funciones puras a src/lib (buildInvoiceUpdate, decideReexport, learnFromValidation, buildDraftFromOcr) con tests de caracterización primero; partir ReviewForm por secciones con reducer; incremental y tras cerrar los fixes en curso.
- **Impacto / esfuerzo:** Medio / L

### 🟡 P2 F-103 · Los tests del Excel A3 no fijan cabeceras («Cutoa»), fechas, _R, IRPF en la primera fila, exclusión por total ni la paridad huella↔fila · HECHO VERIFICADO

- **Rutas:** `tests/unit/exportFormats.test.ts:24`, `tests/unit/exportFormats.test.ts:392-500`, `tests/unit/exportFingerprint.test.ts:24-138`, `src/lib/exportFormats.ts:199-216`, `src/lib/exportFormats.ts:230`, `src/lib/exportFormats.ts:466`
- **Evidencia:** El fixture usa IRPF 0; solo se comprueban recargo y prefijo; ~13 tests cubren generateCsv (código muerto); nada garantiza que exportFingerprint siga a buildA3Row; sin test de la ruta. La simulación confirma que el comportamiento actual es correcto, pero no queda congelado.
- **Por qué importa:** Un refactor puede duplicar retenciones o desalinear la huella sin que falle nada.
- **Recomendación:** Golden test con facturas tipo contra un fixture versionado (cabecera y hojas incluidas), test de propiedad huella ⇔ filas y test de integración de la ruta.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-104 · El E2E son 5 tests de humo del login, está roto (busca «email») y usa el servidor de desarrollo con el .env local · HECHO VERIFICADO

- **Rutas:** `tests/e2e/smoke.spec.ts:1-34`, `playwright.config.ts:24-30`, `src/app/login/LoginForm.tsx:19-24`, `ARCHITECTURE.md:251`
- **Evidencia:** El smoke busca getByLabel(/email/) y «email o contraseña incorrectos», pero el login es por usuario; no se ejecuta en ningún sitio; webServer arranca npm run dev con el DATABASE_URL de .env sin guarda.
- **Por qué importa:** Los fallos de interacción de la revisión (9 de 22 en curso) solo los detecta un E2E.
- **Recomendación:** Arreglar el smoke; con el harness de F-033, specs de happy-path, aislamiento entre asesorías y atajos de revisión, en CI antes de promocionar a producción.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-105 · El gestor no puede ver ni corregir el plan de cuentas de sus clientes y las cuentas se teclean sin autocompletar · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/clients/[id]/accounts/page.tsx:14`, `src/app/dashboard/admin/clients/[id]/accounts/actions.ts:21`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2242-2317`
- **Evidencia:** Todas las acciones del plan exigen ADMIN; en revisión las cuentas son texto libre.
- **Por qué importa:** Fricción en cada tercero nuevo y dependencia del admin.
- **Recomendación:** Acceso del WORKER a sus clientes, autocompletado desde el plan y propuesta de la siguiente subcuenta libre.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-106 · Sin historial ni notas en la revisión y sin forma de preguntar al cliente sin rechazar · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/page.tsx:40-51`, `src/app/dashboard/admin/invoices/[id]/page.tsx:37-40`, `prisma/schema.prisma:305-443`, `src/app/dashboard/worker/review/[id]/actions.ts:781-821`
- **Evidencia:** La revisión no carga auditoría ni historial; no hay notas; posponer no guarda motivo; el único canal al cliente es el rechazo.
- **Por qué importa:** Con varios gestores se pierde el contexto y se repite trabajo.
- **Recomendación:** Panel «Historial», nota interna y motivo al posponer, y estado «Pendiente del cliente» con pregunta en el portal.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-107 · Validar con cuentas vacías solo hace temblar campos que suelen estar fuera de pantalla · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:950-953`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2275-2287`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2414-2438`
- **Evidencia:** triggerShake("accounts") sin toast; el botón con opacity-50 y el motivo solo en title.
- **Por qué importa:** Parece que la app no responde.
- **Recomendación:** Toast, scrollIntoView y foco en la primera cuenta vacía; motivo visible bajo el botón.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-108 · Periodo por defecto equivocado, periodicidad elegida en cada subida (también por el cliente final) y fecha fuera de periodo sin incidencia · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/client/upload/UploadForm.tsx:53-56`, `src/app/dashboard/client/upload/UploadForm.tsx:162-229`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:79-82`, `src/app/dashboard/admin/export/ExportForm.tsx:176-178`, `src/app/dashboard/worker/batch/page.tsx:131`, `prisma/schema.prisma:182-223`, `src/lib/issueDetector.ts:50-212`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:727-733`
- **Evidencia:** Subidas y export arrancan en el mes en curso y «Mensual»; Client no tiene periodicidad y la clave del lote incluye periodType, así que un clic distinto parte el mismo mes en dos lotes; detectIssues no compara fecha con periodo (ARCHITECTURE dice que sí).
- **Por qué importa:** Lotes partidos o en el mes equivocado que obligan a rechazar y resubir.
- **Recomendación:** Periodicidad en Client (migración nueva) usada por defecto, periodo anterior en los primeros días del mes, incidencia «Fecha fuera del periodo» con acción rápida y «No lo sé» en el portal.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-109 · El mismo periodo se escribe de tres formas y los trimestrales aparecen como mes · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/invoices/InvoicesTable.tsx:182`, `src/app/dashboard/worker/invoices/page.tsx:288`, `src/app/dashboard/worker/invoices/page.tsx:323`, `src/app/dashboard/admin/closures/page.tsx:82`, `src/app/dashboard/admin/closures/ClosuresClient.tsx:23-67`, `src/components/batch/BatchFilters.tsx:116-123`, `src/lib/period.ts:21-27`
- **Evidencia:** «jul 2026» en admin, «Julio 2026» en gestor, «T3 2026» en lotes; Cierres solo admite meses; el filtro de Lotes no tiene trimestres.
- **Por qué importa:** Dudas sobre si la factura está en el lote correcto.
- **Recomendación:** periodLabel en todos los listados y en Cierres; trimestres en el filtro de Lotes.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-110 · Acciones de alto impacto sin confirmación (cerrar, reabrir) y cliente y mes preseleccionados por defecto · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/batch/BatchActions.tsx:98-117`, `src/app/dashboard/admin/closures/ClosuresClient.tsx:22-44`, `src/app/dashboard/admin/closures/ReopenButton.tsx:116-131`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:74-81`, `src/app/dashboard/client/upload/UploadForm.tsx:54`, `src/app/dashboard/admin/export/ExportForm.tsx:35-37`
- **Evidencia:** Cerrar periodo con un clic (el aviso solo en title) y cierra también las emitidas; reabrir sin motivo; clients[0] y mes en curso preseleccionados.
- **Por qué importa:** Solo un admin deshace un cierre y los defaults invitan a subir o exportar donde no toca.
- **Recomendación:** useConfirm con resumen en cerrar/reabrir y motivo auditado; desplegables sin preselección; periodo anterior por defecto.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-111 · Contraste por debajo de WCAG AA en los CTA principales, el texto secundario y el foco, con tipografía muy pequeña · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2433-2438`, `src/app/dashboard/worker/batch/page.tsx:449`, `src/app/dashboard/admin/batch/page.tsx:371`, `src/app/dashboard/worker/page.tsx:417`, `src/app/dashboard/admin/invoices/InvoicesTable.tsx:204`, `src/app/globals.css:67-99`, `src/components/ui/SmartField.tsx:379`, `src/components/layout/LegalDisclaimer.tsx:3`
- **Evidencia:** Calculado con OKLCH de Tailwind v4: Validar 3,22:1, Resolver incidencias 2,15:1, slate-400 2,63:1 (160 usos), foco 1,81:1; 8 usos de 9px, 38 de 10px, 166 de 11px.
- **Por qué importa:** Uso intensivo diario y base de cualquier auditoría de accesibilidad.
- **Recomendación:** green-700, amber-600/700 con texto oscuro, slate-500 mínimo, outline de foco ≥3:1 y 12px mínimo en datos.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-112 · Formularios y controles no accesibles por teclado ni lector: zona de subida, 39 labels sin asociar y modales sin semántica · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/client/upload/UploadForm.tsx:234-254`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:361-375`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1445-1946`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:2271-2287`, `src/app/dashboard/worker/review/[id]/SplitInvoiceModal.tsx`, `src/app/dashboard/worker/review/[id]/SplitPdfModal.tsx`, `src/components/ui/Toast.tsx:124-127`, `src/components/ui/ConfirmDialog.tsx:131-148`
- **Evidencia:** jsx-a11y: 39 label-has-associated-control, 12 click-events, 15 static-element-interactions; la zona de subida es un div con input display:none; modales sin role=dialog, Escape ni trampa de foco; toasts de error con aria-live polite.
- **Por qué importa:** Sin teclado no se puede subir; tumba homologaciones.
- **Recomendación:** label/role=button en la zona, htmlFor/id y aria-label por línea, Dialog común, aria-expanded, role=alert y jsx-a11y recommended en ESLint.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-113 · Texto técnico en Auditoría y Actividad reciente: nombres de campo crudos e ids internos · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/page.tsx:137-143`, `src/app/dashboard/admin/page.tsx:320`, `src/app/api/export/route.ts:191`, `src/app/dashboard/worker/review/[id]/actions.ts:474-481`, `src/lib/invoiceStatuses.ts:150-170`
- **Evidencia:** FIELD_LABELS local de 13 campos: «cambió operationType», «cambió export»; valores «Exportada (batch: cm…, formato: a3excel)» sin traducir.
- **Por qué importa:** Es la pantalla que se enseña para demostrar trazabilidad.
- **Recomendación:** auditFieldLabel y traducir patrones en formatAuditValue (solo presentación, sin tocar la cadena).
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-114 · Portal del cliente y pantallas de admin sin adaptar a móvil: las tablas recortan columnas · HECHO VERIFICADO

- **Rutas:** `src/components/layout/DashboardShell.tsx:135`, `src/app/dashboard/client/invoices/page.tsx:229`, `src/app/dashboard/client/page.tsx:50`, `src/app/dashboard/admin/clients/page.tsx:121`, `src/app/dashboard/admin/workers/page.tsx:67`, `src/app/dashboard/worker/invoices/page.tsx:272`, `src/app/dashboard/admin/invoices/[id]/page.tsx:75`
- **Evidencia:** <main> overflow-x-hidden y 8 tablas sin overflow-x-auto; 15 rejillas fijas; a 375 px «Mis facturas» no enseña Estado.
- **Por qué importa:** El portal está pensado para subir fotos desde el móvil.
- **Recomendación:** overflow-x-auto, tarjetas bajo sm en el portal y rejillas responsive.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-115 · Listado del gestor sin importe ni ordenación, rechazadas sin enlace y solo se explica el duplicado · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/invoices/page.tsx:184-189`, `src/app/dashboard/worker/invoices/page.tsx:276-365`
- **Evidencia:** Sin columna Total ni ordenación; REJECTED/UPLOADED/ANALYZING sin enlace; solo se pinta POSSIBLE_DUPLICATE; «Cerradas» choca con «Periodo cerrado».
- **Por qué importa:** Identificar y priorizar exige abrir cada factura.
- **Recomendación:** Total y ordenación, «Ver» para todas, chips por tipo de incidencia y renombrar a «Terminadas».
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟡 P2 F-116 · Visor PDF sin manejo de errores: textos en inglés de react-pdf, spinner infinito y sin «Reintentar» · HECHO VERIFICADO

- **Rutas:** `src/components/ui/PdfViewer.tsx:344-366`, `node_modules/react-pdf/dist/Document.js:41`, `node_modules/react-pdf/dist/Page.js:27`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:736-741`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1242-1253`, `src/app/dashboard/admin/invoices/[id]/AdminInvoiceViewer.tsx:215-220`
- **Evidencia:** <Document> sin error ni onLoadError («Failed to load PDF file.» y loading a true); <Page> muestra «Loading page…»; sin reintento de la URL firmada.
- **Por qué importa:** Único texto en inglés en la pantalla principal y recargar hace perder lo tecleado (F-047).
- **Recomendación:** error en español con Reintentar/Abrir en pestaña, onLoadError y loading en Page.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-117 · No hay acciones masivas en los listados (duplicadas, reprocesar selección, mover de periodo o cliente, asignar varios clientes) · POSIBLE MEJORA

- **Rutas:** `src/app/dashboard/admin/invoices/InvoicesTable.tsx:53-60`, `src/app/dashboard/worker/invoices/page.tsx:340-365`, `src/app/dashboard/admin/workers/[id]/AssignmentsPanel.tsx:27-48`, `src/app/dashboard/admin/invoices/actions.ts:11-18`
- **Evidencia:** Sin selección múltiple; validar en bloque se quitó a propósito (correcto).
- **Por qué importa:** Correcciones de lote obligan a ir factura a factura.
- **Recomendación:** Casillas con rechazar como duplicadas, reprocesar, mover a periodo/cliente (auditado, respetando cierres) y asignar todos los filtrados.
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-118 · Paneles poco accionables: KPIs históricos no clicables, sin foco en el periodo en curso ni señales de problemas · POSIBLE MEJORA

- **Rutas:** `src/app/dashboard/admin/page.tsx:98-159`, `src/app/dashboard/worker/page.tsx:218-278`, `src/app/dashboard/admin/clients/page.tsx:167-172`, `src/app/dashboard/worker/review/[id]/actions.ts:766-770`
- **Evidencia:** Tarjetas del histórico sin enlace; progreso de los 4 menos completos del histórico; sin errores OCR, duplicados, reexportaciones, clientes sin gestor ni plazos; fin de cola sin resumen.
- **Por qué importa:** No dice qué hacer hoy ni qué riesgo hay antes del día 20.
- **Recomendación:** Panel centrado en el periodo abierto con KPIs enlazados y pantalla de «Lote terminado» con «Cerrar periodo».
- **Impacto / esfuerzo:** Medio / M

### 🟡 P2 F-119 · Los toasts, arriba a la derecha, tapan la navegación de la revisión · HECHO VERIFICADO

- **Rutas:** `src/components/ui/Toast.tsx:124-127`
- **Evidencia:** Contenedor fixed right-4 top-16 sobre la cabecera y pausa con hover.
- **Por qué importa:** Tapa los controles más usados justo después de cada acción.
- **Recomendación:** Ya en curso (fixes componentes #4 y #19); añadir desduplicación de mensajes.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-120 · Los correos llevan la marca Faktury (y un remitente facturocr.com por defecto) y no nombran a la asesoría · HECHO VERIFICADO

- **Rutas:** `src/lib/email.ts:10`, `src/lib/email.ts:136-206`, `src/lib/email.ts:369`, `prisma/schema.prisma:144-159`
- **Evidencia:** FROM por defecto «Faktury <noreply@facturocr.com>»; sin nombre, logo ni Reply-To de la asesoría.
- **Por qué importa:** Al cliente final le parece phishing y las respuestas se pierden.
- **Recomendación:** «<Asesoría> vía Faktury», Reply-To al contacto de la asesoría (campo nuevo) y su logo.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-121 · Sin canal de soporte, ayuda ni avisos de mantenimiento dentro del producto · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/error.tsx:19`, `src/lib/errorCodes.ts:70`, `src/lib/errorCodes.ts:76`, `src/components/layout/Sidebar.tsx:49-98`
- **Evidencia:** Los mensajes dicen «contacta con soporte» sin email, teléfono ni enlace; sin guías ni banner de mantenimiento.
- **Por qué importa:** El soporte acaba en el WhatsApp del fundador sin código de error.
- **Recomendación:** Enlace «Ayuda y soporte» con mailto que incluya código y ruta, guías cortas y banner por variable de entorno.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-122 · Se aceptan fotos HEIC, pero no se ven ni se pueden dividir en Chrome/Edge · RIESGO PROBABLE

- **Rutas:** `src/lib/fileValidation.ts:25`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx:390`, `src/components/ui/ImageViewer.tsx:182`
- **Evidencia:** Se guarda image/heic y se muestra con <img> y canvas; Chrome/Edge/Firefox de escritorio no decodifican HEIC; Document AI tampoco lo admite.
- **Por qué importa:** El gestor valida a ciegas o rechaza.
- **Recomendación:** Convertir a JPEG al subir (paquete justificado) o dejar de aceptar HEIC.
- **Impacto / esfuerzo:** Medio / S

### 🟡 P2 F-123 · El recordatorio de cierre no se deduplica (reminderSent nunca se escribe), ignora la periodicidad y recorre en serie todos los clientes de todas las asesorías · HECHO VERIFICADO

- **Rutas:** `src/app/api/cron/closure-reminders/route.ts:31-61`, `prisma/schema.prisma:604`, `src/app/dashboard/admin/closures/page.tsx:144`, `DEPLOY.md:84`
- **Evidencia:** El comentario dice «or reminder already sent» pero solo salta los cerrados; reminderSent solo se lee; DEPLOY.md sugiere programarlo a diario; una consulta y un email por cliente en una petición.
- **Por qué importa:** Cada cliente con portal recibe el mismo correo todos los días hasta el cierre; choca con el límite de Resend.
- **Recomendación:** Registrar el envío por cliente y periodo, respetar la periodicidad, una sola consulta de cierres y envío por lotes limitado; documentar frecuencia mensual.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟡 P2 F-124 · ARCHITECTURE.md y DEPLOY.md no coinciden con el código (Supabase/Vercel, rutas, migraciones, crons POST, fallback de OCR, cobertura de tests) · HECHO VERIFICADO

- **Rutas:** `ARCHITECTURE.md:27`, `ARCHITECTURE.md:87`, `ARCHITECTURE.md:178`, `ARCHITECTURE.md:238`, `ARCHITECTURE.md:249-255`, `DEPLOY.md:29`, `DEPLOY.md:83`, `.env.example:36`, `src/lib/processInvoice.ts:97`, `vercel.json:1`, `src/app/login/forgot-password/actions.ts:15`
- **Evidencia:** Habla de Supabase, POST /api/invoices/upload, Document AI como OCR, migraciones 20260507… inexistentes, cron «cada 5 min», tests de auditLog/reviewQueue y E2E de export que no existen; DEPLOY configura crons con POST; Document AI llamado «fallback» sin failover; restos de Vercel; el Dockerfile no copia scripts/seed-pdfs.
- **Por qué importa:** AGENTS.md obliga a leerlo antes de tocar nada y hoy induce a errores a personas y agentes.
- **Recomendación:** Actualizar ARCHITECTURE y DEPLOY en una pasada, borrar restos de Vercel y decidir sobre Document AI.
- **Impacto / esfuerzo:** Medio / S · quick win

### 🟢 P3 F-125 · Las claves de almacenamiento pueden colisionar y sobrescribir un PDF · RIESGO PROBABLE

- **Rutas:** `src/app/api/uploads/route.ts:157-163`, `src/lib/storage.ts:122`, `src/app/dashboard/worker/review/[id]/actions.ts:1045`, `src/app/dashboard/worker/review/[id]/actions.ts:1215`
- **Evidencia:** Clave = cliente/periodo/Date.now()-nombre saneado sin tildes; putObject sobrescribe.
- **Por qué importa:** Poco probable, pero se pierde el original y dos facturas comparten fichero.
- **Recomendación:** randomUUID() o id de factura en la clave.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟢 P3 F-126 · Trabajo de CPU en el hilo del único proceso web (xlsx, pdf-lib, pdfjs, miles de filas) · RIESGO PROBABLE

- **Rutas:** `src/app/api/export/route.ts:211`, `src/app/dashboard/worker/review/[id]/actions.ts:1189`, `src/lib/ocrLlm.ts:32`, `src/lib/invoiceListing.ts:40`
- **Evidencia:** generateA3Excel síncrono, pdf-lib en la acción, pdfjs 0,2-0,4 s por PDF (medido) y 1,5-3,7 s materializando filas.
- **Por qué importa:** Mientras el event loop está ocupado esperan todas las asesorías.
- **Recomendación:** Primero F-030 y F-083; después OCR y exportaciones grandes al worker de F-029 o worker_threads.
- **Impacto / esfuerzo:** Medio / M

### 🟢 P3 F-127 · La descarga revoca el blob URL justo después de a.click() con el enlace fuera del DOM · RIESGO PROBABLE

- **Rutas:** `src/app/dashboard/admin/export/ExportForm.tsx:127-133`
- **Evidencia:** a.click(); URL.revokeObjectURL(url); setSuccess(true) sin appendChild ni retraso (problema conocido en Safari/Firefox).
- **Por qué importa:** Sin fichero, con las facturas ya marcadas (F-001) y la UI diciendo éxito.
- **Recomendación:** Añadir el enlace al body y revocar con setTimeout de 60 s.
- **Impacto / esfuerzo:** Medio / XS · quick win

### 🟢 P3 F-128 · Configuración leída en cada fichero sin validar al arrancar y con valores por defecto peligrosos · HECHO VERIFICADO

- **Rutas:** `src/lib/email.ts:10-11`, `src/app/dashboard/admin/clients/actions.ts:154`, `src/lib/ocrLlm.ts:6`, `src/lib/ocrLlm.ts:326`, `src/lib/processInvoice.ts:87`
- **Evidencia:** APP_URL = NEXTAUTH_URL ?? http://localhost:3000; process.env en más de 10 ficheros; constantes de negocio dispersas; clave de Gemini en la query string.
- **Por qué importa:** Un redeploy sin NEXTAUTH_URL envía invitaciones a localhost.
- **Recomendación:** src/lib/config.ts con zod validado al arrancar y clave en cabecera x-goog-api-key.
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-129 · El cliente técnico «Sin clasificar» es una fila centinela que hay que excluir a mano en cada consulta · HECHO VERIFICADO

- **Rutas:** `src/lib/unclassifiedClient.ts:12-24`, `src/app/api/export/route.ts:57`
- **Evidencia:** 34 referencias a isUnclassifiedBucket; el export no lo filtra.
- **Por qué importa:** Otra regla que cada consulta debe recordar; una factura del buzón validada por URL saldría con CIF «UNCLASSIFIED-…».
- **Recomendación:** realClientWhere centralizado (también en export) y, a medio plazo, buzón como estado propio.
- **Impacto / esfuerzo:** Bajo / M

### 🟢 P3 F-130 · Scripts y artefactos obsoletos o peligrosos en el repositorio · HECHO VERIFICADO

- **Rutas:** `scripts/seed-demo.ts:101`, `scripts/seed-demo.ts:123`, `scripts/bootstrap-admin.ts:12`, `scripts/_tmp-check.ts:1`, `scripts/get-users.ts`, `package.json:12`
- **Evidencia:** seed-demo borra ExportBatch y tokens sin filtro de asesoría; _tmp-check y get-users listan usuarios; bootstrap-admin duplicado con «Demo1234!»; informes y PDFs en la raíz y docs; clear-invoices apunta a un fichero inexistente.
- **Por qué importa:** Ruido para agentes y riesgo si el .env apunta a producción.
- **Recomendación:** Borrar lo que no se usa y que los scripts restantes se nieguen con NODE_ENV=production o más de una asesoría.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-131 · reset-demo borra los tokens de restablecimiento e invitación de todas las asesorías · HECHO VERIFICADO

- **Rutas:** `src/lib/demoSeed.ts:96`, `src/lib/demoSeed.ts:118`
- **Evidencia:** passwordResetToken.deleteMany({}) sin where; exportBatch.deleteMany por userId del admin. Solo con ALLOW_DEMO_RESET=true.
- **Por qué importa:** En un entorno compartido invalida invitaciones de otras asesorías.
- **Recomendación:** Filtrar por los emails de los usuarios borrados y mantener ALLOW_DEMO_RESET desactivado.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-132 · Las llamadas a Garage no tienen timeout y el OCR no tiene tiempo máximo global · RIESGO PROBABLE

- **Rutas:** `src/lib/storage.ts:33`, `src/lib/processInvoice.ts:92-95`
- **Evidencia:** S3Client sin requestHandler (requestTimeout 0); processInvoice sin plazo global.
- **Por qué importa:** Un Garage colgado deja facturas en ANALYZING y para los bucles en serie.
- **Recomendación:** NodeHttpHandler con connectionTimeout/requestTimeout y throwOnRequestTimeout, y AbortController de ~3 min por OCR.
- **Impacto / esfuerzo:** Bajo / XS

### 🟢 P3 F-133 · Listados sin periodo por defecto: cada carga cuenta y ordena todo el histórico (4-6 consultas) · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/invoices/page.tsx:111-152`, `src/app/dashboard/admin/invoices/page.tsx:92-114`, `src/lib/invoiceListing.ts:71`
- **Evidencia:** 4 count en paralelo (dos con EXISTS sobre InvoiceIssue), página, groupBy de años; orden por createdAt sin índice y OFFSET creciente.
- **Por qué importa:** Hoy va rápido, pero cada carga recorre todo el histórico varias veces.
- **Recomendación:** Trimestre en curso por defecto (consultarlo con gestores), índice (clientId, createdAt), años cacheados y COUNT FILTER.
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-134 · La revisión y la validación encadenan consultas en serie que podrían ir en paralelo o en bloque · POSIBLE MEJORA

- **Rutas:** `src/app/dashboard/worker/review/[id]/page.tsx:40`, `src/app/dashboard/worker/review/[id]/actions.ts:152`, `src/lib/auditLog.ts:88`
- **Evidencia:** ~9 consultas en serie al abrir y ~20 viajes al validar (auditoría: find + insert por campo).
- **Por qué importa:** 20-40 ms hoy; se multiplica con prefetch o con la BD en otro servidor.
- **Recomendación:** Promise.all de las independientes y auditoría con createMany (misma reescritura que F-001/F-048).
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-135 · El logo de la asesoría viaja como data URL en cada render del layout, incluidos los refrescos de 3-5 s · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/layout.tsx:22-32`, `src/app/dashboard/admin/settings/actions.ts:55`, `src/components/layout/Sidebar.tsx:239`
- **Evidencia:** logoDataUrl (hasta 700.000 caracteres) pasa como prop a un Client Component en cada render y router.refresh.
- **Por qué importa:** Bytes repetidos sin caché en cada ciclo de polling.
- **Recomendación:** Servir /api/firm-logo?v=<updatedAt> con Cache-Control largo.
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-136 · Todas las pestañas del navegador se llaman igual y las de login duplican la marca · HECHO VERIFICADO

- **Rutas:** `src/app/layout.tsx:15-19`, `src/app/login/forgot-password/page.tsx:6-8`, `src/app/login/reset-password/page.tsx:10-12`
- **Evidencia:** Ninguna página de /dashboard define metadata; login produce «Nueva contraseña — Faktury \| Faktury».
- **Por qué importa:** Con varias pestañas el gestor valida en la que no era (WCAG 2.4.2).
- **Recomendación:** generateMetadata por página y quitar la marca de los títulos de login.
- **Impacto / esfuerzo:** Bajo / S · quick win

### 🟢 P3 F-137 · Estructura inconsistente y componentes duplicados que ya divergen (dobles h1, tres sistemas de aviso, dos formularios de subida, dos páginas de Lotes) · HECHO VERIFICADO

- **Rutas:** `src/components/layout/Topbar.tsx:239-241`, `src/components/ui/PageHeader.tsx:10`, `src/components/layout/Sidebar.tsx:94`, `src/components/layout/Sidebar.tsx:323-332`, `src/app/dashboard/admin/invoices/InvoicesTable.tsx:76-96`, `src/app/dashboard/admin/invoices/ReprocessAllErrorsButton.tsx:328-356`, `src/app/dashboard/client/upload/UploadForm.tsx`, `src/app/dashboard/worker/upload/WorkerUploadForm.tsx`, `src/app/dashboard/admin/batch/page.tsx`, `src/app/dashboard/worker/batch/page.tsx`
- **Evidencia:** Dos <h1> por página; «Subir facturas» duplicado en el sidebar; toast global, local e inline; «Reprocesar» hace reload antes de ver el toast; formularios y Lotes duplicados ya divergen.
- **Por qué importa:** Cada arreglo hay que aplicarlo dos veces.
- **Recomendación:** Un h1, un sistema de avisos, un componente de subida y uno de Lotes compartidos, de forma incremental.
- **Impacto / esfuerzo:** Bajo / M

### 🟢 P3 F-138 · Pantallas y endpoints huérfanos o desfasados: Incidencias sin enlace, /api/search sin UI (y sin buscar receptor ni normalizar CIF) y capturas antiguas · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/issues/page.tsx`, `src/components/layout/Topbar.tsx:33`, `src/app/api/search/route.ts:64-75`, `docs/screenshots/11_worker_revision.png`, `docs/screenshots_v2/02_admin_dashboard.png`
- **Evidencia:** /dashboard/worker/issues solo por URL; grep: ningún .ts/.tsx consume /api/search, así que el escenario de FLOW-22 («barra superior») no existe hoy; si se reutiliza, no busca receiverName/Cif ni normaliza con parseTaxId. Las capturas muestran FacturOCR, Ctrl+K y campana que ya no existen.
- **Por qué importa:** Superficie sin mantener que acumula fugas (dos de los 7 conocidos) y material de venta que no coincide.
- **Recomendación:** Eliminar o reintegrar Incidencias como filtro, retirar /api/search (o rehacerlo con filtro de firma y los campos de invoiceListing) y regenerar capturas.
- **Impacto / esfuerzo:** Bajo / S · quick win

### 🟢 P3 F-139 · Exportar con avisos sin confirmar y detalles que confunden (selector de una opción, enlaces sin back, texto «Exportada») · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/export/ExportForm.tsx:252-282`, `src/app/dashboard/admin/export/ExportForm.tsx:340-366`, `src/app/dashboard/admin/export/ExportForm.tsx:405-407`
- **Evidencia:** «Descargar Excel» sin confirmar con avisos; radio con una sola opción; enlaces a revisión sin back; dice «pasarán al estado Exportada» y siguen Validada.
- **Por qué importa:** Última barrera antes de la contabilidad del cliente.
- **Recomendación:** useConfirm con avisos, texto fijo de formato, back en enlaces y texto correcto.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-140 · Etiquetas de estado distintas en Facturas (admin): «Pte. revisión» frente a «Por revisar» y «En analisis» sin tilde · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/invoices/page.tsx:18`, `src/app/dashboard/admin/invoices/page.tsx:24`, `src/app/dashboard/admin/invoices/page.tsx:128`
- **Evidencia:** STATUS_BADGE local frente a STATUS_LABELS.
- **Por qué importa:** Dos nombres para el mismo estado y falta de ortografía visible.
- **Recomendación:** Ya en curso (fixes listados #13).
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-141 · El aviso de duplicado no enlaza a la original y rechazar por duplicado pide al cliente que vuelva a subirla · HECHO VERIFICADO

- **Rutas:** `src/lib/issueDetector.ts:29-40`, `src/app/dashboard/worker/invoices/actions.ts:59-120`, `src/lib/email.ts:244-258`
- **Evidencia:** describeExisting devuelve texto sin id; quickRejectDuplicate y la tecla D envían la plantilla genérica «vuelve a subir el documento corregido».
- **Por qué importa:** Fricción en cada duplicado y un cliente confundido.
- **Recomendación:** Guardar el id de la original, enlazarla o compararla lado a lado y plantilla específica para duplicados (o no enviar).
- **Impacto / esfuerzo:** Bajo / S · quick win

### 🟢 P3 F-142 · Facturae XML: se pierde la serie, IGIC/IPSI se trata como IVA y no se mapea el recargo · HECHO VERIFICADO

- **Rutas:** `src/lib/ocr.ts:526-533`, `src/lib/ocr.ts:551-552`, `src/lib/ocr.ts:566-570`
- **Evidencia:** invoiceNumber = InvoiceNumber ?? InvoiceSeriesCode; no mira TaxTypeCode; EquivalenceSurchargeAmount no se mapea.
- **Por qué importa:** Números sin serie colisionan y un IGIC sale como IVA.
- **Recomendación:** Concatenar serie y número, filtrar TaxTypeCode=01 avisando del resto y mapear el recargo.
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-143 · fmtDate usa la hora local y la huella usa UTC: con una zona al oeste de UTC las fechas salen un día antes y fallan 2 tests · HECHO VERIFICADO

- **Rutas:** `src/lib/exportFormats.ts:70-82`, `src/lib/exportFingerprint.ts:77-83`, `src/lib/dates.ts:14-22`, `vitest.config.ts:5`, `Dockerfile:10`, `Dockerfile:36-40`
- **Evidencia:** Simulado: con America/New_York sale 31/03 en vez de 01/04 y fallan 2 tests; hoy correcto porque el contenedor corre en UTC.
- **Por qué importa:** Basta un TZ mal puesto para mover fechas de contabilización sin que la huella lo detecte.
- **Recomendación:** getUTC* en fmtDate, TZ fijo en un setupFile de Vitest y test bajo dos zonas.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-144 · El export mensual de enero, abril, julio y octubre arrastra las subidas trimestrales del trimestre · HECHO VERIFICADO

- **Rutas:** `src/app/api/export/route.ts:43-62`, `src/app/dashboard/worker/batch/actions.ts:146-147`
- **Evidencia:** Sin filtro por periodType: en mensual monthFilter = month, y un trimestre se guarda con periodMonth del primer mes.
- **Por qué importa:** El lote de «enero» lleva facturas de marzo y el historial engaña (la fecha va por factura, no descuadra A3).
- **Recomendación:** Filtrar periodType MONTHLY en mensual o avisarlo; resolverlo junto a F-011.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-145 · Código muerto de exportadores CSV (sage50, contasol, a3con) y exportConfig sin rellenar, anunciados como disponibles · HECHO VERIFICADO

- **Rutas:** `src/lib/exportFormats.ts:18-24`, `src/lib/exportFormats.ts:95-178`, `src/app/api/export/route.ts:20`, `src/app/api/export/route.ts:195-228`, `INFORME_PRODUCTO_v3.md:25`, `prisma/schema.prisma:520`
- **Evidencia:** VALID_FORMATS = ['a3excel']; generateCsv sin entrecomillar ni neutralizar fórmulas; el INFORME anuncia Sage 50, Contasol y A3CON.
- **Por qué importa:** Falsa sensación de soporte multiformato y tests de código no usado.
- **Recomendación:** Quitar generateCsv y su rama y corregir la documentación.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-146 · No se validan longitudes ni formatos contra los límites de A3 (nombre, número, concepto) · POSIBLE MEJORA

- **Rutas:** `src/lib/exportFormats.ts:256-273`
- **Evidencia:** Nombre de 95 caracteres y número de 27 salen sin recortar; límites de A3 no confirmados.
- **Por qué importa:** A3 podría recortar o rechazar la fila.
- **Recomendación:** Confirmar límites con la plantilla oficial y avisar en la vista previa.
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-147 · Una factura legacy EXPORTED corregida sale del lote pero no vuelve a VALIDATED y no llega al Excel · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/actions.ts:441`, `src/app/api/export/route.ts:55-56`
- **Evidencia:** alreadyValidated incluye EXPORTED; la huella pone exportBatchId=null y el export solo recoge VALIDATED.
- **Por qué importa:** Solo filas anteriores a abril de 2026, pero la corrección no llega a A3.
- **Recomendación:** Normalizar EXPORTED→VALIDATED (fixes revisión #2, en curso).
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-148 · Editar o borrar un grupo de empresas solo comprueba la firma del grupo · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/groups/actions.ts:50-83`, `src/lib/invoiceAccess.ts:24-29`
- **Evidencia:** Un gestor puede modificar grupos con empresas que no lleva.
- **Por qué importa:** Afecta a clasificación de clientes ajenos dentro de la misma asesoría.
- **Recomendación:** Exigir acceso a todos los miembros.
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-149 · No hay error global ni de raíz: un fallo fuera del panel muestra la página genérica de Next en inglés · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/error.tsx`, `src/app/layout.tsx`
- **Evidencia:** Solo existe src/app/dashboard/error.tsx; no hay app/error.tsx ni global-error.tsx.
- **Por qué importa:** Justo en login y restablecimiento el mensaje sale en inglés y sin ayuda.
- **Recomendación:** app/error.tsx y app/global-error.tsx en español con soporte y digest.
- **Impacto / esfuerzo:** Bajo / XS

### 🟢 P3 F-150 · `npm run lint` está en rojo (188 errores, 143 en un fichero de tests) y no sirve como gate · HECHO VERIFICADO

- **Rutas:** `tests/unit/exportFormats.test.ts:24`, `eslint.config.mjs:1`, `package.json:9`, `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1239`
- **Evidencia:** eslint src tests: 178 no-explicit-any (143 en fixtures), 6 set-state-in-effect, 2 react-hooks/refs; sin override para tests.
- **Por qué importa:** Impide meter lint en CI sin ruido y oculta avisos útiles de hooks.
- **Recomendación:** Override para tests/**, revisar los avisos de hooks y añadir eslint al pipeline como aviso.
- **Impacto / esfuerzo:** Bajo / XS

### 🟢 P3 F-151 · Huecos en el historial de estados y actor invisible · HECHO VERIFICADO

- **Rutas:** `src/app/api/cron/retry-stuck/route.ts:41-46`, `src/app/dashboard/worker/review/[id]/actions.ts:444-447`, `src/app/dashboard/worker/review/[id]/actions.ts:515-533`, `src/app/dashboard/admin/invoices/[id]/page.tsx:103-113`
- **Evidencia:** El reset del cron no escribe historial ni auditoría; «Guardar» en NEEDS_ATTENTION/OCR_ERROR pasa a PENDING_REVIEW sin historial; la ficha no pinta changedBy.
- **Por qué importa:** El historial tiene saltos y no dice quién hizo cada cambio.
- **Recomendación:** Registrar ambas transiciones con motivo y pintar el actor.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-152 · Las métricas de tiempo de OCR en pantalla están mal calculadas · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/worker/review/[id]/ReviewForm.tsx:1365-1369`, `src/components/ui/OcrProcessingBanner.tsx:26-61`, `src/app/dashboard/admin/batch/page.tsx:190-202`, `src/app/dashboard/worker/review/[id]/page.tsx:218-227`
- **Evidencia:** startedAt = createdAt: al reprocesar una factura antigua el banner muestra cientos de miles de segundos; la media usa todo el histórico.
- **Por qué importa:** La única métrica visible engaña.
- **Recomendación:** Medir desde la última transición a ANALYZING y media de los últimos 7 días o 200 extracciones cacheada.
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-153 · Auditoría: la fecha se muestra en hora de Madrid pero los filtros cortan por día UTC · HECHO VERIFICADO

- **Rutas:** `src/app/dashboard/admin/audit/page.tsx:61-66`
- **Evidencia:** lte dateTo + T23:59:59.999Z y gte new Date(dateFrom) frente a formatDateTimeEs.
- **Por qué importa:** Buscar lo tocado un día puede dejar fuera entradas de madrugada.
- **Recomendación:** Ya en curso (fix #20).
- **Impacto / esfuerzo:** Bajo / XS · quick win

### 🟢 P3 F-154 · La tabla Document solo se escribe, duplica datos de Invoice y se queda con el cliente del buzón al rutear · POSIBLE MEJORA

- **Rutas:** `prisma/schema.prisma:289`, `src/app/api/uploads/route.ts:175`, `src/app/dashboard/worker/clasificar/actions.ts:107`, `src/lib/processInvoice.ts:598`
- **Evidencia:** Ninguna consulta la lee; repite filename, storageKey, fileType y fileHash; Document.clientId no se actualiza al clasificar.
- **Por qué importa:** Dos fuentes de verdad que divergen; peligrosa para purgas RGPD.
- **Recomendación:** Eliminarla con expand/contract o mantenerla coherente y documentada.
- **Impacto / esfuerzo:** Bajo / S

### 🟢 P3 F-155 · Sin validación ni CHECK de rangos de periodo: son posibles meses 0 o 13 y los estados legacy siguen vivos · HECHO VERIFICADO

- **Rutas:** `src/app/api/uploads/route.ts:59-69`, `src/app/dashboard/worker/review/[id]/actions.ts:336`, `prisma/schema.prisma:103`, `prisma/schema.prisma:329`
- **Evidencia:** periodMonth/periodYear solo exigen Number.isFinite (0, 13, −1, 1900 pasan; 2,5 da 500 en Prisma); trimestres no se validan; accountingPeriodMonth sin rango; ANALYZED y EXPORTED siguen en el enum.
- **Por qué importa:** Una factura con mes 13 desaparece de lotes, cierres y exportación sin error (requiere petición manipulada).
- **Recomendación:** Validar en el límite (1-12, trimestres 1/4/7/10, año razonable) y CHECK en migración nueva; CHECK de estados legacy cuando no queden filas.
- **Impacto / esfuerzo:** Bajo / S

