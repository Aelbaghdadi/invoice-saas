from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white, black
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
import os

OUTPUT = os.path.join(os.path.dirname(__file__), "..", "docs", "FacturOCR_MVP_v2_Review.pdf")
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

PAGE_W = A4[0] - 40*mm

# ── Colors ──────────────────────────────────────────────────────────────────
BLUE = HexColor("#2563eb")
BLUE_LIGHT = HexColor("#eff6ff")
BLUE_MED = HexColor("#dbeafe")
SLATE_800 = HexColor("#1e293b")
SLATE_600 = HexColor("#475569")
SLATE_400 = HexColor("#94a3b8")
SLATE_100 = HexColor("#f1f5f9")
GREEN = HexColor("#059669")
GREEN_LIGHT = HexColor("#ecfdf5")
AMBER = HexColor("#d97706")
AMBER_LIGHT = HexColor("#fffbeb")
RED = HexColor("#dc2626")
RED_LIGHT = HexColor("#fef2f2")

styles = getSampleStyleSheet()

# ── Custom styles ───────────────────────────────────────────────────────────
title_style = ParagraphStyle("CustomTitle", parent=styles["Title"],
    fontSize=28, leading=34, textColor=SLATE_800, spaceAfter=6, fontName="Helvetica-Bold")
subtitle_style = ParagraphStyle("CustomSubtitle", parent=styles["Normal"],
    fontSize=14, leading=18, textColor=SLATE_600, spaceAfter=20, fontName="Helvetica")
h1_style = ParagraphStyle("H1", parent=styles["Heading1"],
    fontSize=20, leading=26, textColor=BLUE, spaceBefore=16, spaceAfter=10, fontName="Helvetica-Bold")
h2_style = ParagraphStyle("H2", parent=styles["Heading2"],
    fontSize=15, leading=20, textColor=SLATE_800, spaceBefore=14, spaceAfter=8, fontName="Helvetica-Bold")
h3_style = ParagraphStyle("H3", parent=styles["Heading3"],
    fontSize=12, leading=16, textColor=SLATE_600, spaceBefore=10, spaceAfter=6, fontName="Helvetica-Bold")
body_style = ParagraphStyle("Body", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=SLATE_600, spaceAfter=6, fontName="Helvetica")
bullet_style = ParagraphStyle("Bullet", parent=body_style,
    leftIndent=18, bulletIndent=6, spaceBefore=2, spaceAfter=2)
small_style = ParagraphStyle("Small", parent=styles["Normal"],
    fontSize=8, leading=11, textColor=SLATE_400, fontName="Helvetica")
badge_blue = ParagraphStyle("BadgeBlue", parent=body_style, fontSize=9, textColor=BLUE, fontName="Helvetica-Bold")
badge_green = ParagraphStyle("BadgeGreen", parent=body_style, fontSize=9, textColor=GREEN, fontName="Helvetica-Bold")
badge_red = ParagraphStyle("BadgeRed", parent=body_style, fontSize=9, textColor=RED, fontName="Helvetica-Bold")
badge_amber = ParagraphStyle("BadgeAmber", parent=body_style, fontSize=9, textColor=AMBER, fontName="Helvetica-Bold")

# Score style
score_style = ParagraphStyle("Score", parent=title_style, fontSize=48, alignment=TA_CENTER, textColor=AMBER)

# ── Header / Footer ────────────────────────────────────────────────────────
def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(BLUE)
    canvas.setLineWidth(2)
    canvas.line(20*mm, A4[1] - 12*mm, A4[0] - 20*mm, A4[1] - 12*mm)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.setFillColor(BLUE)
    canvas.drawString(20*mm, A4[1] - 10*mm, "FacturOCR")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE_400)
    canvas.drawRightString(A4[0] - 20*mm, A4[1] - 10*mm, "Revision Critica MVP v2")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE_400)
    canvas.drawString(20*mm, 12*mm, "FacturOCR - Documento Interno")
    canvas.drawRightString(A4[0] - 20*mm, 12*mm, f"Pagina {doc.page}")
    canvas.setStrokeColor(SLATE_100)
    canvas.setLineWidth(0.5)
    canvas.line(20*mm, 16*mm, A4[0] - 20*mm, 16*mm)
    canvas.restoreState()

doc = SimpleDocTemplate(OUTPUT, pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=22*mm)

story = []

# ── Helpers ─────────────────────────────────────────────────────────────────
def make_table(data, col_widths, header_bg=BLUE, alt_row=True):
    t = Table(data, colWidths=col_widths, repeatRows=1)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), header_bg),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]
    if alt_row:
        style_cmds.append(("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]))
    t.setStyle(TableStyle(style_cmds))
    return t

def gap_table(data):
    """4-col gap table: Aspecto, Problema, Propuesta, Prioridad"""
    t = Table(data, colWidths=[30*mm, 50*mm, 55*mm, 30*mm], repeatRows=1)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), SLATE_800),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
    ]
    t.setStyle(TableStyle(style_cmds))
    return t

P = Paragraph  # shorthand

# ═════════════════════════════════════════════════════════════════════════════
# COVER PAGE
# ═════════════════════════════════════════════════════════════════════════════
story.append(Spacer(1, 50*mm))
story.append(P("FacturOCR", ParagraphStyle("Logo", parent=title_style,
    fontSize=42, textColor=BLUE, alignment=TA_CENTER)))
story.append(Spacer(1, 8*mm))
story.append(P("Revision Critica del MVP<br/>Plan de Mejora v2", ParagraphStyle(
    "CoverTitle", parent=title_style, fontSize=22, alignment=TA_CENTER,
    textColor=SLATE_800, leading=28)))
story.append(Spacer(1, 6*mm))
story.append(HRFlowable(width="40%", thickness=2, color=BLUE, spaceBefore=0, spaceAfter=0, hAlign="CENTER"))
story.append(Spacer(1, 6*mm))
story.append(P("Analisis funcional, tecnico y de arquitectura<br/>Product Owner + Solution Architect + Tech Lead",
    ParagraphStyle("CoverSub", parent=subtitle_style, alignment=TA_CENTER, fontSize=12)))
story.append(Spacer(1, 20*mm))

cover_data = [
    ["Documento", "Revision Critica MVP v2"],
    ["Fecha", "30 de marzo de 2026"],
    ["Tipo", "Analisis interno - Product & Architecture"],
    ["Puntuacion MVP actual", "6.5 / 10"],
]
cover_table = Table(cover_data, colWidths=[50*mm, 80*mm])
cover_table.setStyle(TableStyle([
    ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
    ("FONTNAME", (1, 0), (1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 10),
    ("TEXTCOLOR", (0, 0), (0, -1), SLATE_400),
    ("TEXTCOLOR", (1, 0), (1, -1), SLATE_800),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.5, SLATE_100),
]))
story.append(cover_table)
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# TABLE OF CONTENTS
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("Indice de contenidos", h1_style))
story.append(Spacer(1, 4*mm))
toc_items = [
    ("1.", "Resumen ejecutivo"),
    ("2.", "Lo que ya esta bien resuelto"),
    ("3.", "Gaps funcionales importantes"),
    ("4.", "Gaps tecnicos y de arquitectura"),
    ("5.", "Seguridad y operativa"),
    ("6.", "Que anadir si o si al MVP"),
    ("7.", "Que dejaria para fase 2"),
    ("8.", "Que quitaria o suavizaria"),
    ("9.", "Propuesta de estados y flujo revisado"),
    ("10.", "Modelo de datos minimo mejorado"),
    ("11.", "Endpoints y acciones minimas"),
    ("12.", "Plan de prioridad real"),
]
for num, title in toc_items:
    story.append(P(f"<b>{num}</b>  {title}", ParagraphStyle(
        "TOC", parent=body_style, fontSize=11, spaceBefore=4, spaceAfter=4, leftIndent=10)))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 1. RESUMEN EJECUTIVO
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("1. Resumen ejecutivo", h1_style))
story.append(Spacer(1, 4*mm))
story.append(P("6.5 / 10", score_style))
story.append(Spacer(1, 4*mm))
story.append(P(
    "El MVP tiene una base tecnica solida y un flujo end-to-end funcional que demuestra bien el concepto. "
    "La arquitectura Next.js 14 + Prisma + Supabase es coherente, el split-panel de revision aporta valor real, "
    "y la auditoria field-level es un diferencial legitimo. <b>Como demo, impresiona. Como producto vendible "
    "a una asesoria real, le faltan piezas criticas.</b>", body_style))
story.append(Spacer(1, 4*mm))

exec_data = [
    ["Aspecto", "Evaluacion"],
    ["Principal fortaleza", "Flujo completo subida - OCR - revision - validacion - exportacion implementado de punta a punta con buena UX y trazabilidad."],
    ["Principal debilidad", "Modelo de datos monolitico (documento + OCR + correcciones mezclados en 1 tabla), sin gestion de errores OCR, sin duplicados, y flujo de estados demasiado lineal."],
    ["Valoracion general", "Demo funcional impresionante. Necesita ~10 dias de trabajo enfocado en robustez para ser vendible a una asesoria real."],
]
story.append(make_table(exec_data, [35*mm, 130*mm], header_bg=SLATE_800))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 2. LO QUE YA ESTA BIEN RESUELTO
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("2. Lo que ya esta bien resuelto", h1_style))
story.append(Spacer(1, 2*mm))

bien_data = [
    ["Area", "Valoracion"],
    ["Flujo end-to-end", "El ciclo completo funciona: cliente sube, GPT-4o extrae, gestor revisa en split-panel, valida, y admin exporta CSV. Es el core del producto y esta operativo."],
    ["Separacion de roles", "3 roles con dashboards diferenciados, middleware RBAC, y filtrado de datos por rol. El worker solo ve sus clientes asignados."],
    ["Split-panel de revision", "Pantalla estrella. Documento a la izquierda, formulario editable a la derecha, navegacion entre facturas, validacion matematica en tiempo real."],
    ["Auditoria field-level", "Cada campo modificado se registra con old/new value, usuario y timestamp. Requisito real de asesorias."],
    ["Exportacion multi-formato", "Sage 50, Contasol, a3con con CSV espanol (;, BOM UTF-8, 1.234,56). Cubre los 3 programas mas usados en Espana."],
    ["OCR multi-formato", "PDF (Responses API), imagenes (Chat Completions con detail: high), XML/FacturaE (parsing directo sin coste API)."],
    ["Seguridad base", "Bloqueo por intentos (3 -> 15 min), bcrypt, JWT, URLs firmadas con TTL 10 min, optimistic locking."],
    ["Notificaciones email", "Emails automaticos al subir (-> workers) y al validar (-> cliente) via Resend."],
    ["Drag & drop upload", "Multi-archivo, validacion de tipos y tamano, preview antes de subir. Buena UX para el cliente."],
    ["Busqueda global", "Ctrl+K con busqueda en clientes y facturas, filtrada por rol."],
]
story.append(make_table(bien_data, [38*mm, 127*mm]))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 3. GAPS FUNCIONALES IMPORTANTES
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("3. Gaps funcionales importantes", h1_style))

story.append(P("3.1 Deteccion de duplicados", h2_style))
story.append(P(
    "<b>Problema:</b> No hay ningun control. Si un cliente sube la misma factura 2 veces, se crean 2 registros "
    "independientes y se procesan ambos por OCR. Si se exportan ambos, genera asientos dobles en contabilidad.", body_style))
story.append(P(
    "<b>Propuesta:</b> 1) Hash SHA-256 del archivo al subir -> rechazar si existe mismo hash. 2) Post-OCR: "
    "comprobar si ya existe factura con mismo invoiceNumber + issuerCif -> marcar como DUPLICATE_SUSPECT. "
    "3) El gestor decide: descartar o mantener.", body_style))
story.append(P("<b>Prioridad: Alta</b>", badge_red))

story.append(P("3.2 Gestion de errores OCR y reprocesado", h2_style))
story.append(P(
    "<b>Problema:</b> Si GPT devuelve datos parciales o la imagen es ilegible, la factura queda en ANALYZING "
    "con campos vacios. No hay forma de saber que salio mal ni de reprocesar. El rollback solo ocurre ante "
    "excepcion tecnica, no si GPT devuelve basura.", body_style))
story.append(P(
    "<b>Propuesta:</b> 1) Estado OCR_ERROR para fallos tecnicos. 2) Guardar JSON bruto de GPT en campo separado. "
    "3) Boton Reprocesar OCR. 4) Indicador de confianza por campo.", body_style))
story.append(P("<b>Prioridad: Alta</b>", badge_red))

story.append(P("3.3 Incidencias y facturas problematicas", h2_style))
story.append(P(
    "<b>Problema:</b> No existe concepto de factura con incidencia. Si tiene datos incorrectos o esta incompleta, "
    "queda en ANALYZING indefinidamente. No hay canal para comunicar al cliente que su factura tiene un problema. "
    "En operativa real, un 10-20% de facturas necesitan aclaracion.", body_style))
story.append(P(
    "<b>Propuesta:</b> Estado REJECTED con rejectionReason. El cliente ve en su portal las facturas rechazadas "
    "y el motivo. Puede resubir o responder.", body_style))
story.append(P("<b>Prioridad: Alta</b>", badge_red))

story.append(P("3.4 Estados insuficientes", h2_style))
story.append(P(
    "<b>Problema:</b> 4 estados lineales (UPLOADED -> ANALYZING -> VALIDATED -> EXPORTED) no cubren la realidad. "
    "No hay forma de clasificar facturas atascadas, con errores OCR, o rechazadas.", body_style))
story.append(P(
    "<b>Propuesta:</b> Anadir minimo: OCR_ERROR, ANALYZED, REJECTED. Ver seccion 9 para flujo completo.", body_style))
story.append(P("<b>Prioridad: Alta</b>", badge_red))
story.append(PageBreak())

story.append(P("3.5 Trazabilidad de exportaciones", h2_style))
story.append(P(
    "<b>Problema:</b> Se marcan facturas como EXPORTED y se genera CSV al vuelo, pero no queda registro de que "
    "se exporto junto, cuando, ni con que filtros. Imposible re-descargar un CSV anterior.", body_style))
story.append(P(
    "<b>Propuesta:</b> Modelo ExportBatch con id, formato, filtros, usuario, fecha, y relacion con facturas.", body_style))
story.append(P("<b>Prioridad: Alta</b>", badge_red))

story.append(P("3.6 Confianza OCR por campo", h2_style))
story.append(P(
    "<b>Problema:</b> Todos los campos OCR se presentan igual. El gestor no sabe si GPT adivino un CIF borroso "
    "o lo leyo con total claridad. Pierde tiempo verificando campos correctos.", body_style))
story.append(P(
    "<b>Propuesta:</b> Modificar prompt de GPT para devolver confidence (0-1) por campo. Mostrar: verde (>0.9), "
    "amarillo (0.7-0.9), rojo (<0.7).", body_style))
story.append(P("<b>Prioridad: Media</b>", badge_amber))

story.append(P("3.7 Configuracion contable por cliente", h2_style))
story.append(P(
    "<b>Problema:</b> accountingProgram existe pero no hay configuracion de IVA por defecto, tipo de retencion "
    "habitual, ni regimen fiscal. El gestor valida manualmente cada vez.", body_style))
story.append(P(
    "<b>Propuesta:</b> Ampliar Client con defaultVatRate, defaultIrpfRate, fiscalRegime. El OCR puede comparar "
    "valores extraidos contra los esperados.", body_style))
story.append(P("<b>Prioridad: Media</b>", badge_amber))

story.append(P("3.8 Guardar sin validar: estado intermedio", h2_style))
story.append(P(
    "<b>Problema:</b> saveInvoiceFields() existe, pero la factura queda en ANALYZING. Si el gestor guarda y se va, "
    "otro gestor no sabe que alguien ya empezo a revisar. Riesgo de trabajo duplicado.", body_style))
story.append(P(
    "<b>Propuesta:</b> Estado REVIEW_IN_PROGRESS + campo reviewedBy para reservar la factura.", body_style))
story.append(P("<b>Prioridad: Media</b>", badge_amber))

story.append(P("3.9 Cierre de mes", h2_style))
story.append(P(
    "<b>Problema:</b> No existe concepto de cierre. Las facturas de diferentes meses se mezclan. No hay forma "
    "de saber si un periodo esta completo. Pueden exportar un periodo incompleto.", body_style))
story.append(P(
    "<b>Propuesta:</b> Indicador visual por cliente/periodo con progreso. Boton marcar periodo como cerrado.", body_style))
story.append(P("<b>Prioridad: Media</b>", badge_amber))

story.append(P("3.10 Validacion mas alla de la matematica", h2_style))
story.append(P(
    "<b>Problema:</b> Solo se valida que Base + IVA - IRPF = Total (+-2 centimos). No se valida formato CIF, "
    "coherencia de fechas, ni que el receptor sea el propio cliente.", body_style))
story.append(P(
    "<b>Propuesta:</b> 1) Validar formato CIF/NIF espanol. 2) Warning si receiverCif != client.cif. "
    "3) Warning si fecha futura o >1 ano. Implementar como warnings, no bloqueos.", body_style))
story.append(P("<b>Prioridad: Media</b>", badge_amber))
story.append(PageBreak())

# ── Summary table of all gaps ──────────────────────────────────────────────
story.append(P("Resumen de gaps funcionales", h2_style))
gaps_summary = [
    ["#", "Gap", "Impacto", "Prioridad"],
    ["3.1", "Deteccion de duplicados", "Asientos dobles en contabilidad", "Alta"],
    ["3.2", "Errores OCR / reprocesado", "Facturas atascadas sin solucion", "Alta"],
    ["3.3", "Incidencias / facturas problematicas", "Sin comunicacion con cliente", "Alta"],
    ["3.4", "Estados insuficientes", "Facturas en limbo indefinido", "Alta"],
    ["3.5", "Trazabilidad de exportaciones", "Imposible auditar que se exporto", "Alta"],
    ["3.6", "Confianza OCR por campo", "Gestor revisa a ciegas", "Media"],
    ["3.7", "Config. contable por cliente", "Validacion manual repetitiva", "Media"],
    ["3.8", "Estado intermedio de revision", "Trabajo duplicado entre gestores", "Media"],
    ["3.9", "Cierre de mes", "Exportaciones de periodos incompletos", "Media"],
    ["3.10", "Validacion CIF/fechas", "Facturas con datos invalidos", "Media"],
]
gt = Table(gaps_summary, colWidths=[10*mm, 45*mm, 55*mm, 22*mm], repeatRows=1)
gt.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
    # Color-code priority column
    ("TEXTCOLOR", (3, 1), (3, 5), RED),
    ("FONTNAME", (3, 1), (3, 5), "Helvetica-Bold"),
    ("TEXTCOLOR", (3, 6), (3, -1), AMBER),
    ("FONTNAME", (3, 6), (3, -1), "Helvetica-Bold"),
]))
story.append(gt)
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 4. GAPS TECNICOS Y DE ARQUITECTURA
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("4. Gaps tecnicos y de arquitectura", h1_style))

tech_gaps = [
    ["Aspecto", "Situacion actual", "Riesgo", "Recomendacion MVP", "Fase 2"],
    ["Modelo monolitico Invoice",
     "20+ campos que mezclan metadatos, datos OCR y correcciones manuales en 1 tabla",
     "No se distingue que escribio GPT vs que corrigio el gestor. Reprocesar borra correcciones.",
     "Separar en Invoice (datos finales) e InvoiceExtraction (datos OCR brutos + confianza)",
     "Versionado de extracciones"],
    ["Sin historico de estados",
     "Invoice.status es campo plano. AuditLog registra cambios como un field mas.",
     "Imposible medir tiempos, detectar cuellos de botella, calcular metricas.",
     "Crear InvoiceStatusHistory (invoiceId, fromStatus, toStatus, changedBy, changedAt)",
     "Dashboards de rendimiento"],
    ["Sin entidad ExportBatch",
     "Exportacion genera CSV al vuelo, marca EXPORTED. No queda registro agrupado.",
     "Imposible re-descargar CSV anterior. Imposible auditar que se envio a Sage.",
     "Modelo ExportBatch (id, format, filters, userId, createdAt, invoiceCount)",
     "Almacenar CSV en Supabase Storage"],
    ["Procesamiento asincrono fragil",
     "OCR se dispara con after() de Next.js. Sin retry ni dead-letter.",
     "Si el servidor recicla el proceso o hay timeout, la factura queda UPLOADED para siempre.",
     "Campo ocrAttempts + cron /api/cron/retry-stuck cada 10 min",
     "Cola real (Inngest / Trigger.dev)"],
    ["Server Actions para todo",
     "Toda la logica en Server Actions. Validacion matematica duplicada en 2 archivos.",
     "Logica de negocio mezclada con IO. Dificil de testear.",
     "Extraer logica compartida a src/lib/services/",
     "Tests unitarios sobre capa de servicios"],
    ["Hash de archivo inexistente",
     "No se calcula ni almacena hash del archivo subido.",
     "Imposible detectar duplicados por contenido ni verificar integridad.",
     "Calcular SHA-256 al subir, almacenar en Invoice.fileHash",
     "Verificacion de integridad periodica"],
]
tt = Table(tech_gaps, colWidths=[25*mm, 30*mm, 30*mm, 40*mm, 30*mm], repeatRows=1)
tt.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), SLATE_800),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
]))
story.append(tt)
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 5. SEGURIDAD Y OPERATIVA
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("5. Puntos a revisar en seguridad y operativa", h1_style))

sec_data = [
    ["Punto", "Que revisar", "Por que importa", "Recomendacion"],
    ["Contrasenas autogeneradas",
     "createClient() genera password con ultimos 6 chars del CIF + '!'",
     "CIF es informacion publica. Cualquiera podria acceder al portal del cliente.",
     "Generar password aleatoria + email de invitacion con link temporal"],
    ["Credenciales en PDF",
     "El informe UI incluye emails y contrasenas reales de demo",
     "Si el PDF se comparte, credenciales expuestas",
     "Separar credenciales del informe. Variables de entorno para demo."],
    ["URLs firmadas",
     "TTL 10 minutos, solo ADMIN/WORKER pueden generar",
     "Correcto para MVP. URL compartida da acceso temporal.",
     "Aceptable. Fase 2: log de acceso a documentos."],
    ["Control de acceso por rol",
     "Middleware + verificaciones en cada Server Action",
     "Doble capa correcta. Pero API export solo verifica role ADMIN.",
     "Verificar que TODAS las API routes verifican rol, no solo auth."],
    ["RGPD / retencion",
     "No hay politica de borrado ni retencion. Datos almacenados indefinidamente.",
     "Obligaciones legales de retencion (4-6 anos) y eliminacion post-periodo.",
     "MVP: documentar retencion minima. Fase 2: archivado automatico."],
    ["Doble edicion",
     "Optimistic locking existe en validateInvoice() pero NO en saveInvoiceFields()",
     "Un gestor puede machacar cambios de otro al guardar sin validar.",
     "Aplicar mismo check de updatedAt en saveInvoiceFields()."],
    ["Invitacion de clientes",
     "No hay flujo de invitacion. Admin crea cuenta directamente.",
     "Cliente no elige contrasena ni verifica email.",
     "Email de bienvenida con link de establecer contrasena (reutilizar reset)."],
]
story.append(make_table(sec_data, [30*mm, 38*mm, 42*mm, 45*mm]))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 6. QUE ANADIR SI O SI AL MVP
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("6. Que anadir si o si al MVP", h1_style))
story.append(Spacer(1, 2*mm))

add_data = [
    ["#", "Item", "Descripcion", "Backend", "Frontend", "Prior."],
    ["1", "Estado REJECTED",
     "Permitir al gestor rechazar factura con motivo",
     "Nuevo enum + rejectionReason",
     "Badge rojo + motivo visible para cliente", "P0"],
    ["2", "Estado OCR_ERROR",
     "Diferenciar fallo OCR vs pendiente revision",
     "Nuevo enum + ocrAttempts + lastOcrError",
     "Indicador visual + boton reprocesar", "P0"],
    ["3", "Deteccion duplicados",
     "Hash archivo + check n factura + CIF emisor",
     "Campo fileHash, query duplicados",
     "Warning en upload + badge duplicado", "P0"],
    ["4", "ExportBatch",
     "Registrar cada exportacion como entidad",
     "Modelo ExportBatch con relacion",
     "Historial de exportaciones en admin", "P0"],
    ["5", "Reprocesar OCR",
     "Boton para re-lanzar OCR sin borrar datos manuales",
     "Endpoint + logica re-extraccion",
     "Boton en vista de revision", "P1"],
    ["6", "InvoiceExtraction",
     "Datos OCR brutos separados de datos finales",
     "Nueva tabla InvoiceExtraction",
     "Diff visual OCR vs editado (opcional)", "P1"],
    ["7", "StatusHistory",
     "Historico de transiciones de estado",
     "Tabla simple con 5 campos",
     "Timeline en detalle de factura", "P1"],
    ["8", "Password segura",
     "Email invitacion con link temporal para clientes",
     "Reutilizar flujo reset-password",
     "Eliminar password hardcodeada", "P1"],
    ["9", "Cron retry OCR",
     "Job que reprocese facturas atascadas en UPLOADED",
     "Vercel Cron + endpoint retry",
     "Ninguno", "P1"],
    ["10", "Validacion CIF",
     "Validar formato CIF/NIF extraido",
     "Funcion validacion CIF espanol",
     "Warning visual en formulario", "P2"],
    ["11", "Warnings revision",
     "Avisos no-bloqueantes (receptor != cliente, fecha rara)",
     "Logica de comparacion",
     "Iconos warning junto a campos", "P2"],
    ["12", "Filtros avanzados",
     "Filtro por cliente, rango fechas, importes",
     "Query params en Server Component",
     "Dropdowns y date pickers", "P2"],
]
at = Table(add_data, colWidths=[8*mm, 28*mm, 40*mm, 32*mm, 38*mm, 12*mm], repeatRows=1)
at.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
    # P0 rows bold red
    ("TEXTCOLOR", (5, 1), (5, 4), RED),
    ("FONTNAME", (5, 1), (5, 4), "Helvetica-Bold"),
    # P1 rows bold amber
    ("TEXTCOLOR", (5, 5), (5, 9), AMBER),
    ("FONTNAME", (5, 5), (5, 9), "Helvetica-Bold"),
    # P2 rows blue
    ("TEXTCOLOR", (5, 10), (5, -1), BLUE),
    ("FONTNAME", (5, 10), (5, -1), "Helvetica-Bold"),
]))
story.append(at)
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 7. QUE DEJARIA PARA FASE 2
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("7. Que dejaria para fase 2", h1_style))
story.append(Spacer(1, 2*mm))

fase2_data = [
    ["Item", "Razon para posponer"],
    ["Memoria historica de cuentas contables",
     "Requiere modelo de plan de cuentas completo. Demasiada complejidad contable para el MVP."],
    ["Sugerencia automatica de cuenta contable",
     "Depende de historico + ML/reglas. No prometer inteligencia contable sin garantias."],
    ["Plan de cuentas completo (PGC)",
     "Es un proyecto en si mismo. Cada asesoria adapta el PGC."],
    ["Validacion contra AEAT / SII",
     "Requiere integracion con API de la Agencia Tributaria. Complejidad regulatoria alta."],
    ["Exportadores avanzados (XLS, API Sage)",
     "Los 3 CSV actuales cubren el 80% del mercado. Mas formatos = mas mantenimiento sin retorno."],
    ["Multi-tenancy real",
     "El modelo tiene AdvisoryFirm pero el MVP es para una sola asesoria. Multi-tenant requiere aislamiento de datos, facturacion, y onboarding."],
    ["Reglas fiscales complejas (RECC, rec. equivalencia, OSS)",
     "Cada regimen tiene sus propias reglas. Demasiadas casuisticas."],
    ["Dashboard de rendimiento",
     "Valioso pero no critico. Requiere InvoiceStatusHistory (que si entra en MVP como base)."],
    ["API publica / webhooks",
     "Nadie los usara en la primera version. Primero validar el producto."],
    ["OCR con confianza por campo",
     "Requiere refinar prompts, testing extensivo, y calibrar con datos reales."],
    ["Cierre de mes formal",
     "El indicador de progreso por cliente/periodo es suficiente para el MVP."],
]
story.append(make_table(fase2_data, [50*mm, 115*mm], header_bg=SLATE_800))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 8. QUE QUITARIA O SUAVIZARIA
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("8. Que quitaria, suavizaria o no venderia aun", h1_style))
story.append(Spacer(1, 2*mm))

quit_data = [
    ["Aspecto", "Problema", "Recomendacion"],
    ["Claim '99.5% precision'",
     "No hay datos reales que lo respalden. La precision depende de la calidad del documento. Una factura escaneada de lado a 72 DPI no dara 99.5%.",
     "Eliminar el porcentaje concreto. Usar 'Alta precision con verificacion humana'. Cuando haya datos reales, poner el % real."],
    ["Claim '< 2 min por factura'",
     "Depende de la complejidad. Una factura con 20 lineas de detalle puede llevar 10 minutos.",
     "Cambiar a 'Reduce el tiempo de procesamiento hasta un 80%' o eliminarlo hasta tener metricas."],
    ["3 formatos de export desde dia 1",
     "Mantener 3 formatos implica testear los 3 contra los programas reales. Si el CSV de Sage 50 no importa correctamente, pierde credibilidad.",
     "Validar al menos 1 exhaustivamente. Los otros 2 marcarlos como beta internamente."],
    ["'0 EUR para empezar'",
     "Si no hay modelo de precios definido, prometer gratis atrae usuarios que se frustran con paywall.",
     "Definir si es freemium, trial, o plan gratuito real. No poner 0 EUR sin plan de pricing."],
    ["Procesamiento automatico sin supervision",
     "El flujo asume que GPT siempre devuelve algo usable. Un 15-25% de facturas requieren intervencion manual significativa.",
     "Posicionar como 'automatizacion asistida'. El humano siempre revisa. Eso es un feature, no un bug."],
]
story.append(make_table(quit_data, [32*mm, 60*mm, 73*mm], header_bg=RED))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 9. PROPUESTA DE ESTADOS Y FLUJO REVISADO
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("9. Propuesta de estados y flujo revisado", h1_style))
story.append(Spacer(1, 2*mm))

story.append(P("7 estados propuestos (vs 4 actuales)", h2_style))
story.append(Spacer(1, 2*mm))

# Flow diagram as text
flow_text = (
    "UPLOADED ---> ANALYZING ---> ANALYZED ---> VALIDATED ---> EXPORTED<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "|&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "|<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "OCR_ERROR&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "REJECTED"
)
story.append(P(flow_text, ParagraphStyle("Flow", parent=body_style,
    fontName="Courier", fontSize=9, leading=14, textColor=BLUE)))
story.append(Spacer(1, 4*mm))

story.append(P("Tabla de transiciones", h2_style))
trans_data = [
    ["Estado origen", "Estado destino", "Quien", "Accion", "Humano?"],
    ["-", "UPLOADED", "Sistema", "Cliente sube archivo", "No"],
    ["UPLOADED", "ANALYZING", "Sistema", "Se inicia procesamiento OCR", "No"],
    ["ANALYZING", "ANALYZED", "Sistema", "OCR completado con exito", "No"],
    ["ANALYZING", "OCR_ERROR", "Sistema", "Fallo en procesamiento OCR", "No"],
    ["OCR_ERROR", "UPLOADED", "Worker/Admin", "Boton Reprocesar", "Si"],
    ["ANALYZED", "VALIDATED", "Worker/Admin", "Gestor revisa, edita y valida", "Si"],
    ["ANALYZED", "REJECTED", "Worker/Admin", "Gestor rechaza con motivo", "Si"],
    ["REJECTED", "UPLOADED", "Cliente", "Cliente resube el documento", "Si"],
    ["VALIDATED", "EXPORTED", "Admin", "Admin exporta a CSV", "Si"],
    ["EXPORTED", "VALIDATED", "Admin", "Correccion post-exportacion (excepcional)", "Si"],
]
story.append(make_table(trans_data, [27*mm, 27*mm, 25*mm, 52*mm, 18*mm]))
story.append(Spacer(1, 4*mm))

story.append(P("Notas clave", h3_style))
notes = [
    "<b>ANALYZED</b> sustituye el actual ANALYZING como estado 'listo para revisar'. ANALYZING es ahora transitorio (solo mientras GPT procesa).",
    "<b>OCR_ERROR</b> permite identificar facturas que necesitan atencion tecnica.",
    "<b>REJECTED</b> cierra el ciclo de comunicacion con el cliente.",
    "Solo <b>VALIDATED</b> permite exportar. Cualquier otro estado bloquea exportacion.",
    "<b>EXPORTED -> VALIDATED</b> es excepcional (correccion) y genera audit log destacado.",
]
for n in notes:
    story.append(P(n, bullet_style, bulletText="\u2022"))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 10. MODELO DE DATOS MINIMO MEJORADO
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("10. Modelo de datos minimo mejorado", h1_style))
story.append(Spacer(1, 2*mm))

model_data = [
    ["Entidad", "MVP?", "Proposito", "Campos minimos clave", "Relaciones"],
    ["User", "Si",
     "Cuentas de usuario",
     "id, email, passwordHash, name, role, failedAttempts, lockedUntil, advisoryFirmId",
     "-> AdvisoryFirm, -> AuditLog[], -> WorkerClientAssignment[]"],
    ["AdvisoryFirm", "Si",
     "Datos de la asesoria",
     "id, name, cif, createdAt",
     "-> User[], -> Client[]"],
    ["Client", "Si",
     "Empresas cliente",
     "id, name, cif, email, accountingProgram, defaultVatRate, defaultIrpfRate, advisoryFirmId, userId",
     "-> AdvisoryFirm, -> User, -> Invoice[]"],
    ["WorkerClient\nAssignment", "Si",
     "Asignacion worker-cliente",
     "id, workerId, clientId, createdAt",
     "-> User, -> Client"],
    ["Invoice", "Si",
     "Factura (datos finales)",
     "id, filename, storageKey, fileHash, type, status, period, issuer*, receiver*, importes*, rejectionReason, reviewedBy, ocrAttempts, clientId, exportBatchId",
     "-> Client, -> InvoiceExtraction[], -> StatusHistory[], -> AuditLog[]"],
    ["Invoice\nExtraction", "Si",
     "Datos brutos OCR",
     "id, invoiceId, rawResponse (JSON), issuer*, receiver*, importes*, isValid, source, createdAt",
     "-> Invoice"],
    ["InvoiceStatus\nHistory", "Si",
     "Historico de estados",
     "id, invoiceId, fromStatus, toStatus, changedBy, reason, createdAt",
     "-> Invoice, -> User"],
    ["AuditLog", "Si",
     "Cambios field-level",
     "id, invoiceId, userId, field, oldValue, newValue, createdAt",
     "-> Invoice, -> User"],
    ["ExportBatch", "Si",
     "Registro exportaciones",
     "id, format, clientId, periodMonth, periodYear, invoiceCount, userId, createdAt",
     "-> Invoice[], -> User"],
    ["PasswordReset\nToken", "Si",
     "Reset de contrasena",
     "id, email, token, expiresAt, createdAt",
     "-"],
    ["InvoiceIssue", "Fase 2",
     "Incidencias con detalle",
     "id, invoiceId, type, description, status, createdBy, resolvedAt",
     "-> Invoice, -> User"],
]
mt = Table(model_data, colWidths=[24*mm, 12*mm, 22*mm, 60*mm, 40*mm], repeatRows=1)
mt.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
    # MVP column coloring
    ("TEXTCOLOR", (1, 1), (1, -2), GREEN),
    ("FONTNAME", (1, 1), (1, -2), "Helvetica-Bold"),
    ("TEXTCOLOR", (1, -1), (1, -1), AMBER),
    ("FONTNAME", (1, -1), (1, -1), "Helvetica-Bold"),
]))
story.append(mt)
story.append(Spacer(1, 4*mm))

story.append(P("Diagrama simplificado de relaciones", h3_style))
diagram = (
    "AdvisoryFirm ---+---> User (ADMIN/WORKER/CLIENT)<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "+---> Client ---> Invoice ---+---> InvoiceExtraction<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "+---> InvoiceStatusHistory<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "+---> AuditLog<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
    "+---> ExportBatch"
)
story.append(P(diagram, ParagraphStyle("Diagram", parent=body_style,
    fontName="Courier", fontSize=8, leading=12, textColor=SLATE_600)))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 11. ENDPOINTS Y ACCIONES MINIMAS
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("11. Endpoints y acciones minimas", h1_style))
story.append(Spacer(1, 2*mm))

groups = [
    ("Auth", [
        ("login", "Autenticacion con credentials"),
        ("logout", "Cerrar sesion"),
        ("forgotPassword", "Enviar email de reset"),
        ("resetPassword", "Establecer nueva contrasena con token"),
        ("changePassword", "Cambiar contrasena estando logueado"),
    ]),
    ("Clients", [
        ("listClients", "Listar clientes de la asesoria (con paginacion)"),
        ("createClient", "Crear cliente + cuenta portal + email invitacion"),
        ("updateClient", "Editar datos y configuracion del cliente"),
        ("getClientDetail", "Ver detalle con facturas y progreso"),
        ("assignWorker", "Asignar/desasignar gestor a cliente"),
    ]),
    ("Invoices", [
        ("listInvoices", "Listar con filtros (estado, cliente, periodo, tipo, fechas)"),
        ("getInvoiceDetail", "Detalle completo con extraccion OCR e historial"),
        ("bulkValidate", "Validar multiples facturas"),
        ("bulkExport", "Exportar multiples facturas"),
        ("checkDuplicates", "Verificar duplicados por hash o n factura + CIF"),
    ]),
    ("Upload", [
        ("uploadInvoices", "Subir archivos + hash + crear registros + trigger OCR"),
        ("deleteUpload", "Eliminar factura en UPLOADED (antes de procesamiento)"),
    ]),
    ("Review", [
        ("getReviewData", "Datos factura + extraccion OCR + documento firmado"),
        ("saveFields", "Guardar campos editados sin validar (con optimistic lock)"),
        ("validateInvoice", "Guardar + marcar VALIDATED + notificar"),
        ("rejectInvoice", "Rechazar con motivo + notificar cliente"),
        ("getNextInvoice", "Siguiente factura pendiente del lote"),
    ]),
    ("Reprocess", [
        ("reprocessOcr", "Re-lanzar OCR (nueva InvoiceExtraction sin borrar anterior)"),
        ("retryStuckInvoices", "Cron: buscar UPLOADED >5 min y reprocesar"),
    ]),
    ("Export", [
        ("previewExport", "Contar facturas que coinciden con filtros"),
        ("generateExport", "Generar CSV + crear ExportBatch + marcar EXPORTED"),
        ("listExportHistory", "Historial de exportaciones anteriores"),
        ("redownloadExport", "Re-generar CSV de un batch anterior"),
    ]),
    ("Audit", [
        ("listAuditLogs", "Listar con filtros (usuario, factura, fecha, campo)"),
        ("getInvoiceHistory", "Historial completo de una factura (status + fields)"),
    ]),
    ("Workers", [
        ("listWorkers", "Listar gestores"),
        ("createWorker", "Crear gestor + email de credenciales"),
        ("updateWorker", "Editar datos"),
        ("getWorkerQueue", "Cola de facturas pendientes para un gestor"),
    ]),
]

for group_name, ops in groups:
    story.append(P(group_name, h3_style))
    op_data = [["Operacion", "Descripcion"]]
    for op, desc in ops:
        op_data.append([op, desc])
    ot = Table(op_data, colWidths=[40*mm, 125*mm])
    ot.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BLUE_MED),
        ("TEXTCOLOR", (0, 0), (-1, 0), SLATE_800),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Courier"),
        ("FONTNAME", (1, 1), (1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
    ]))
    story.append(ot)
    story.append(Spacer(1, 2*mm))
story.append(PageBreak())

# ═════════════════════════════════════════════════════════════════════════════
# 12. PLAN DE PRIORIDAD REAL
# ═════════════════════════════════════════════════════════════════════════════
story.append(P("12. Plan de prioridad real", h1_style))
story.append(Spacer(1, 4*mm))

# ── ANADIR AHORA ───────────────────────────────────────────────────────────
story.append(P("ANADIR AHORA (antes de vender)", ParagraphStyle(
    "BlockTitle", parent=h2_style, textColor=RED)))
story.append(Spacer(1, 2*mm))

now_data = [
    ["Orden", "Item", "Esfuerzo"],
    ["1", "Nuevos estados: OCR_ERROR, ANALYZED, REJECTED + transiciones", "1-2 dias"],
    ["2", "Deteccion de duplicados (fileHash + check n factura + CIF emisor)", "1 dia"],
    ["3", "ExportBatch (modelo + historial + trazabilidad)", "1 dia"],
    ["4", "Separar InvoiceExtraction del Invoice (datos OCR brutos aparte)", "2 dias"],
    ["5", "InvoiceStatusHistory (tabla simple de transiciones)", "0.5 dias"],
    ["6", "Rechazo de factura con motivo (REJECTED + rejectionReason + notif)", "1 dia"],
    ["7", "Reprocesar OCR (boton + nueva extraccion sin borrar datos manuales)", "1 dia"],
    ["8", "Contrasenas seguras para clientes (email invitacion, no CIF+!)", "0.5 dias"],
    ["9", "Cron de retry para facturas atascadas", "0.5 dias"],
    ["10", "Aplicar optimistic lock en saveFields (no solo en validate)", "0.5 dias"],
    ["11", "Eliminar claims sin medir (99.5%, < 2 min, 0 EUR)", "0.5 horas"],
]
nt = Table(now_data, colWidths=[14*mm, 120*mm, 24*mm], repeatRows=1)
nt.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), RED),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, RED_LIGHT]),
    ("ALIGN", (0, 0), (0, -1), "CENTER"),
    ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
    ("TEXTCOLOR", (0, 1), (0, -1), RED),
]))
story.append(nt)
story.append(Spacer(1, 3*mm))
story.append(P("<b>Total estimado: ~10-11 dias de desarrollo</b>", body_style))
story.append(Spacer(1, 6*mm))

# ── ANADIR DESPUES ─────────────────────────────────────────────────────────
story.append(P("ANADIR DESPUES (fase 2, post-primeros clientes)", ParagraphStyle(
    "BlockTitle2", parent=h2_style, textColor=AMBER)))
story.append(Spacer(1, 2*mm))

later_items = [
    "Confianza OCR por campo con indicadores visuales",
    "Validacion CIF/NIF espanol",
    "Warnings inteligentes en revision (receptor != cliente, fecha rara)",
    "Cierre de mes con bloqueo de periodo",
    "Configuracion contable avanzada por cliente",
    "Dashboard de rendimiento (tiempos, volumenes, productividad)",
    "Capa de servicios + tests unitarios",
    "Cola de jobs real (Inngest / Trigger.dev)",
    "Filtros avanzados con date picker y rangos",
    "Multi-tenancy real",
    "Re-descarga de CSV de ExportBatch anteriores",
    "Politica RGPD de archivado/borrado",
]
for item in later_items:
    story.append(P(item, bullet_style, bulletText="\u2022"))
story.append(Spacer(1, 6*mm))

# ── NO METER TODAVIA ───────────────────────────────────────────────────────
story.append(P("NO METER TODAVIA", ParagraphStyle(
    "BlockTitle3", parent=h2_style, textColor=SLATE_400)))
story.append(Spacer(1, 2*mm))

no_items = [
    "Plan de cuentas / sugerencia de cuentas contables",
    "Validacion AEAT / SII",
    "Exportacion directa a APIs de Sage/Contasol",
    "Reglas fiscales complejas (RECC, recargo equivalencia, OSS)",
    "API publica / webhooks",
    "App movil / PWA",
    "IA predictiva de cuentas contables",
    "Automatizacion sin supervision humana",
    "Multi-idioma",
]
for item in no_items:
    story.append(P(item, bullet_style, bulletText="\u2022"))
story.append(Spacer(1, 10*mm))

# ── CLOSING ────────────────────────────────────────────────────────────────
story.append(HRFlowable(width="100%", thickness=2, color=BLUE, spaceBefore=6, spaceAfter=6))
story.append(P(
    "<b>Conclusion:</b> El MVP actual es una demo funcional impresionante, pero necesita ~10 dias de "
    "trabajo enfocado en robustez (estados, duplicados, trazabilidad de exportaciones, separacion de datos OCR) "
    "para convertirse en un producto que una asesoria pueda usar en produccion sin riesgo. La buena noticia "
    "es que la arquitectura lo permite sin reescribir nada: es evolucion, no revolucion.",
    ParagraphStyle("Conclusion", parent=body_style, fontSize=10, leading=15, textColor=SLATE_800)))

# ── Build ──────────────────────────────────────────────────────────────────
doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(f"PDF generado: {OUTPUT}")
