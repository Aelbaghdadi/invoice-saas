# Nuevo enfoque del producto tras RD 238/2026

> Documento de trabajo. Apuntado para retomar más adelante. No implementar todavía.

## Contexto

El RD 238/2026 obliga en España a la facturación electrónica B2B estructurada (Facturae / UBL / CII / EDIFACT, base EN16931), con plataforma pública AEAT + PIPs privadas (ISO 27001), estados de factura obligatorios y trazabilidad Verifactu (RD 1007/2023).

Impacto directo en FacturOCR: el "OCR de PDFs" deja de ser el flujo principal porque las facturas llegarán ya estructuradas. El OCR pasa a ser **fallback** para tickets, facturas extranjeras y emisores no obligados.

---

## Dos opciones de pivote

### Opción A — "Receptor inteligente para asesorías" (recomendada)

La asesoría es el punto de entrada único para todas las facturas del cliente, vengan de donde vengan:

- Recepción multicanal: AEAT, PIPs, XML directo, email, PDF/foto (OCR legacy).
- Normalización a modelo interno único (EN16931).
- Gestión de los **estados legales** obligatorios (aceptada, rechazada, pagada, etc.) con notificación AEAT.
- Verifactu: hash encadenado, sello temporal, export fiscal.
- Salida hacia ERP contable (Sage 50, Contasol, A3) — se conserva.

**Por qué**: aprovecha la relación asesoría–cliente, el motor de reglas (plan de cuentas) y el pipeline actual. El OCR se mantiene como un canal más.

### Opción B — "OCR de nicho"

Centrarse solo en documentos no cubiertos por el RD: tickets, facturas extranjeras, recibos, documentos de gasto no facturables. Mercado más pequeño pero menos competido a corto plazo.

---

## Traducción a módulos / capas funcionales (Opción A)

### Capa 1 · Recepción multicanal
- Conector AEAT (plataforma pública).
- Conectores PIPs privadas certificadas ISO 27001.
- Endpoint XML directo (Facturae / UBL / CII / EDIFACT).
- Buzón email dedicado por cliente.
- OCR legacy (canal residual para PDF/foto/ticket).

### Capa 2 · Normalización
- Parsers por formato → modelo interno único basado en EN16931.
- Validador EN16931 (reglas Business Rules + CIUS español).
- Deduplicación cross-canal (misma factura recibida por 2 vías).

### Capa 3 · Estados legales (prioridad máxima)
- Máquina de estados obligatoria: recibida → aceptada / rechazada / pagada / rectificada…
- Cola de acciones pendientes por cliente (qué requiere decisión humana y en qué plazo).
- Notificador AEAT bidireccional (cambios de estado hacia la AEAT).
- Registro de pagos (conciliación con extracto bancario, fase 2).

### Capa 4 · Verifactu
- Hash encadenado por factura emitida/recibida.
- Sello temporal.
- Export fiscal certificado (ficheros SII-like + libros registro).
- Auditoría de inalterabilidad.

### Capa 5 · Salida ERP (conservado)
- Exportadores actuales: Sage 50, Contasol, A3 (ya existen en plan).
- Añadir: export directo estructurado (no solo CSV).

### Capa 6 · Administración
- Gestión de certificados digitales del cliente.
- Apoderamientos AEAT.
- Onboarding guiado (alta cliente + conexión canales).

### Capa 7 · UX visible
- Dashboard reenfocado: **cola de acciones legales** como vista principal, no "bandeja de OCR".
- "Revisar OCR" queda como pestaña secundaria.
- Widget de cumplimiento Verifactu visible para la asesoría.

---

## Orden de implementación sugerido

1. **Capa 3 (estados legales)** — el cambio más urgente, valor inmediato incluso antes del RD.
2. **Capa 2 (normalización)** — necesaria para cualquier canal estructurado.
3. **Capa 4 (Verifactu)** — obligatoria cuando entre en vigor.
4. **Capa 1 (recepción multicanal)** — empezar por email + XML directo, AEAT/PIPs después.
5. **Capa 6 (admin certificados)** — requisito operativo para AEAT/PIPs.

Capas 5 y 7 evolucionan en paralelo con cada capa nueva.

---

## Qué retirar del posicionamiento actual

- "Sube tus facturas en PDF y las procesamos con IA" → pasa a ser una funcionalidad secundaria.
- Marketing enfocado a OCR / ahorro de tiempo de tecleo → reemplazar por "cumplimiento + control del flujo legal de facturas".
- KPIs de "facturas OCRizadas" → KPIs de "facturas en estado conforme", "acciones pendientes resueltas a tiempo".

---

## Riesgos / preguntas abiertas

- Fechas reales de entrada en vigor del RD 238/2026 y ventana de adaptación.
- Coste de certificación ISO 27001 si queremos actuar como PIP (probablemente no a corto plazo — integrar con PIPs existentes).
- Competencia directa: ERPs contables (Sage, A3) van a incorporar esto nativamente. Ventaja de FacturOCR = foco en la asesoría como intermediario, no en el cliente final.
- Modelo de precios: ¿por cliente gestionado? ¿por factura procesada? El cambio de canal cambia la unidad de valor.
