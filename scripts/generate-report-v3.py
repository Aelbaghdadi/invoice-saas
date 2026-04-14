"""
FacturOCR — Informe de producto MVP v3
Genera el PDF profesional con la misma estructura visual que v2
pero actualizado con todas las funcionalidades nuevas.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether,
)
from reportlab.pdfgen import canvas
from reportlab.platypus.doctemplate import PageTemplate, BaseDocTemplate, Frame
import os

# ─── Colors ──────────────────────────────────────────────────────────────────

BLUE      = HexColor("#2563EB")
DARK_BLUE = HexColor("#1E3A5F")
LIGHT_BLUE= HexColor("#EFF6FF")
SLATE_800 = HexColor("#1E293B")
SLATE_600 = HexColor("#475569")
SLATE_400 = HexColor("#94A3B8")
SLATE_100 = HexColor("#F1F5F9")
GREEN     = HexColor("#16A34A")
RED       = HexColor("#DC2626")
AMBER     = HexColor("#D97706")
BG_WHITE  = HexColor("#FFFFFF")

WIDTH, HEIGHT = A4
MARGIN = 20 * mm

# ─── Styles ──────────────────────────────────────────────────────────────────

STYLES = {
    "title": ParagraphStyle(
        "title",
        fontName="Helvetica-Bold",
        fontSize=26,
        leading=32,
        textColor=SLATE_800,
        spaceAfter=4 * mm,
    ),
    "subtitle": ParagraphStyle(
        "subtitle",
        fontName="Helvetica",
        fontSize=13,
        leading=18,
        textColor=SLATE_600,
        spaceAfter=8 * mm,
    ),
    "section_title": ParagraphStyle(
        "section_title",
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=22,
        textColor=BLUE,
        spaceBefore=6 * mm,
        spaceAfter=4 * mm,
    ),
    "body": ParagraphStyle(
        "body",
        fontName="Helvetica",
        fontSize=10,
        leading=15,
        textColor=SLATE_600,
        alignment=TA_JUSTIFY,
        spaceAfter=3 * mm,
    ),
    "bold_body": ParagraphStyle(
        "bold_body",
        fontName="Helvetica-Bold",
        fontSize=10,
        leading=15,
        textColor=SLATE_800,
        spaceAfter=2 * mm,
    ),
    "bullet": ParagraphStyle(
        "bullet",
        fontName="Helvetica",
        fontSize=10,
        leading=15,
        textColor=SLATE_600,
        leftIndent=10 * mm,
        bulletIndent=4 * mm,
        spaceAfter=1.5 * mm,
    ),
    "small": ParagraphStyle(
        "small",
        fontName="Helvetica",
        fontSize=8,
        leading=11,
        textColor=SLATE_400,
    ),
    "cover_title": ParagraphStyle(
        "cover_title",
        fontName="Helvetica-Bold",
        fontSize=36,
        leading=44,
        textColor=white,
        alignment=TA_LEFT,
    ),
    "cover_subtitle": ParagraphStyle(
        "cover_subtitle",
        fontName="Helvetica",
        fontSize=14,
        leading=20,
        textColor=HexColor("#93C5FD"),
        alignment=TA_LEFT,
    ),
    "cover_meta": ParagraphStyle(
        "cover_meta",
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=HexColor("#BFDBFE"),
        alignment=TA_LEFT,
    ),
    "toc_item": ParagraphStyle(
        "toc_item",
        fontName="Helvetica",
        fontSize=11,
        leading=20,
        textColor=SLATE_600,
        leftIndent=8 * mm,
        spaceAfter=1 * mm,
    ),
}


# ─── Header / Footer ────────────────────────────────────────────────────────

def header_footer(canvas_obj, doc):
    canvas_obj.saveState()
    # Header
    canvas_obj.setFillColor(BLUE)
    canvas_obj.rect(0, HEIGHT - 14 * mm, WIDTH, 14 * mm, fill=1, stroke=0)
    canvas_obj.setFillColor(white)
    canvas_obj.setFont("Helvetica-Bold", 9)
    canvas_obj.drawString(MARGIN, HEIGHT - 10 * mm, "FacturOCR")
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.drawRightString(WIDTH - MARGIN, HEIGHT - 10 * mm,
                               "Informe de producto v3 — Abril 2026")
    # Footer
    canvas_obj.setFillColor(SLATE_400)
    canvas_obj.setFont("Helvetica", 7)
    canvas_obj.drawString(MARGIN, 8 * mm,
                          "FacturOCR — Documento confidencial")
    canvas_obj.drawRightString(WIDTH - MARGIN, 8 * mm,
                               f"Pagina {doc.page}")
    # Thin line
    canvas_obj.setStrokeColor(SLATE_100)
    canvas_obj.setLineWidth(0.5)
    canvas_obj.line(MARGIN, 12 * mm, WIDTH - MARGIN, 12 * mm)
    canvas_obj.restoreState()


# ─── Helpers ─────────────────────────────────────────────────────────────────

def bullet(text):
    return Paragraph(f"<bullet>&bull;</bullet> {text}", STYLES["bullet"])

def body(text):
    return Paragraph(text, STYLES["body"])

def bold(text):
    return Paragraph(text, STYLES["bold_body"])

def section(num, title):
    return Paragraph(f"{num}. {title}", STYLES["section_title"])

def spacer(h=4):
    return Spacer(1, h * mm)

def make_table(headers, rows, col_widths=None):
    """Create a styled table."""
    data = [headers] + rows
    if not col_widths:
        col_widths = [None] * len(headers)
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BLUE),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), 9),
        ("TEXTCOLOR", (0, 1), (-1, -1), SLATE_600),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [BG_WHITE, SLATE_100]),
        ("GRID", (0, 0), (-1, -1), 0.5, SLATE_100),
    ]))
    return t

def info_box(text):
    """Blue info box."""
    data = [[Paragraph(text, ParagraphStyle(
        "info",
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        textColor=DARK_BLUE,
    ))]]
    t = Table(data, colWidths=[WIDTH - 2 * MARGIN - 10 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT_BLUE),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("ROUNDEDCORNERS", [4, 4, 4, 4]),
    ]))
    return t


# ─── Cover page ──────────────────────────────────────────────────────────────

def cover_page(canvas_obj, doc):
    canvas_obj.saveState()
    # Full blue background
    canvas_obj.setFillColor(BLUE)
    canvas_obj.rect(0, 0, WIDTH, HEIGHT, fill=1, stroke=0)

    # Decorative gradient overlay (darker at top)
    canvas_obj.setFillColor(HexColor("#1D4ED8"))
    canvas_obj.rect(0, HEIGHT * 0.6, WIDTH, HEIGHT * 0.4, fill=1, stroke=0)

    # Logo block
    canvas_obj.setFillColor(white)
    canvas_obj.setFont("Helvetica-Bold", 14)
    canvas_obj.drawString(MARGIN + 5 * mm, HEIGHT - 45 * mm, "OCR")
    canvas_obj.roundRect(MARGIN, HEIGHT - 50 * mm, 18 * mm, 18 * mm, 4 * mm,
                         fill=0, stroke=1)
    canvas_obj.setStrokeColor(HexColor("#60A5FA"))
    canvas_obj.setLineWidth(1)

    # Title
    canvas_obj.setFont("Helvetica-Bold", 42)
    canvas_obj.drawString(MARGIN, HEIGHT - 100 * mm, "FacturOCR")

    # Subtitle
    canvas_obj.setFont("Helvetica", 18)
    canvas_obj.setFillColor(HexColor("#93C5FD"))
    canvas_obj.drawString(MARGIN, HEIGHT - 115 * mm,
                          "Informe de producto MVP v3")

    # Description
    canvas_obj.setFont("Helvetica", 12)
    canvas_obj.setFillColor(HexColor("#BFDBFE"))
    canvas_obj.drawString(MARGIN, HEIGHT - 135 * mm,
                          "Plataforma SaaS de gestion inteligente de facturas con OCR")

    # Meta info box
    y_box = 80 * mm
    canvas_obj.setFillColor(HexColor("#1E40AF"))
    canvas_obj.roundRect(MARGIN, y_box - 5 * mm, WIDTH - 2 * MARGIN, 55 * mm,
                         4 * mm, fill=1, stroke=0)

    canvas_obj.setFillColor(white)
    canvas_obj.setFont("Helvetica-Bold", 10)
    info = [
        ("Version", "MVP v3 — Abril 2026"),
        ("Stack", "Next.js 16 + Prisma + Supabase + Resend"),
        ("OCR", "Google Document AI (Invoice Parser)"),
        ("Roles", "Administrador, Gestor (Worker), Cliente"),
        ("Exportacion", "A3asesor Excel (.xlsx), A3 CSV, Sage 50, Contasol"),
        ("Funcionalidades", "OCR, Plan de Cuentas, Validacion, Exportacion, Lotes, Auditoria"),
    ]
    y = y_box + 40 * mm
    for label, value in info:
        canvas_obj.setFont("Helvetica-Bold", 9)
        canvas_obj.setFillColor(HexColor("#93C5FD"))
        canvas_obj.drawString(MARGIN + 8 * mm, y, label)
        canvas_obj.setFont("Helvetica", 9)
        canvas_obj.setFillColor(white)
        canvas_obj.drawString(MARGIN + 50 * mm, y, value)
        y -= 7 * mm

    # Footer
    canvas_obj.setFillColor(HexColor("#60A5FA"))
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.drawString(MARGIN, 15 * mm,
                          "FacturOCR — Documento confidencial")
    canvas_obj.drawRightString(WIDTH - MARGIN, 15 * mm, "Pagina 1")

    canvas_obj.restoreState()


# ─── Build document ──────────────────────────────────────────────────────────

def build():
    output_path = os.path.join("docs", "FacturOCR_Informe_v3.pdf")

    doc = BaseDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=22 * mm,
        bottomMargin=18 * mm,
        title="FacturOCR — Informe de producto MVP v3",
        author="FacturOCR",
    )

    frame = Frame(
        doc.leftMargin,
        doc.bottomMargin,
        doc.width,
        doc.height,
        id="main",
    )

    # Cover template (no header/footer)
    cover_template = PageTemplate(
        id="cover",
        frames=[frame],
        onPage=cover_page,
    )

    # Normal template (with header/footer)
    normal_template = PageTemplate(
        id="normal",
        frames=[frame],
        onPage=header_footer,
    )

    doc.addPageTemplates([cover_template, normal_template])

    story = []

    # ─── Cover ─────────────────────────────────────────────────────
    story.append(Spacer(1, 1))  # Cover is drawn by onPage handler
    story.append(PageBreak())

    # Switch to normal template for remaining pages
    from reportlab.platypus.doctemplate import NextPageTemplate
    story.append(NextPageTemplate("normal"))

    # ─── Table of contents ─────────────────────────────────────────
    story.append(Paragraph("Indice", STYLES["section_title"]))
    story.append(spacer(2))

    toc_items = [
        "1. Inicio de sesion",
        "2. Panel de Administrador",
        "3. Gestion de clientes",
        "4. Plan de cuentas por cliente",
        "5. Gestion de gestores",
        "6. Facturas — vista completa",
        "7. Lotes de facturas",
        "8. Revision de factura (OCR)",
        "9. Exportacion a software contable",
        "10. Cierres de periodo",
        "11. Registro de auditoria",
        "12. Ajustes de asesoria",
        "13. Panel del Gestor",
        "14. Subida de facturas (Gestor)",
        "15. Panel del Cliente",
        "16. Subida de facturas (Cliente)",
        "17. Ciclo de vida de una factura",
        "18. Stack tecnologico",
        "19. Novedades v3",
    ]
    for item in toc_items:
        story.append(Paragraph(f"<bullet>&bull;</bullet> {item}",
                               STYLES["toc_item"]))
    story.append(PageBreak())

    # ─── 1. Login ──────────────────────────────────────────────────
    story.append(section(1, "Inicio de sesion"))
    story.append(body(
        "Pantalla de acceso con autenticacion segura. Soporte para 3 roles: "
        "Administrador, Gestor y Cliente. Incluye bloqueo de cuenta tras "
        "intentos fallidos y enlace de recuperacion de contrasena."
    ))
    story.append(info_box(
        "<b>Seguridad:</b> bcrypt para hashing de contrasenas, bloqueo tras "
        "5 intentos fallidos, sesiones con NextAuth.js y tokens JWT."
    ))
    story.append(PageBreak())

    # ─── 2. Panel Admin ────────────────────────────────────────────
    story.append(section(2, "Panel de Administrador"))
    story.append(body(
        "Vista general con KPIs en tiempo real: total de facturas, pendientes "
        "de validar, validadas y exportadas. Incluye tabla de facturas recientes, "
        "actividad del equipo y progreso por cliente."
    ))
    story.append(bold("Elementos destacados:"))
    for b in [
        "4 tarjetas KPI con iconos y contadores en tiempo real",
        "Tabla de facturas recientes con estado y acciones",
        "Feed de actividad con historial de cambios",
        "Barra de progreso por cliente (facturas procesadas vs total)",
        "Barra de busqueda global (Ctrl+K) para encontrar clientes y facturas",
    ]:
        story.append(bullet(b))
    story.append(PageBreak())

    # ─── 3. Gestion de clientes ────────────────────────────────────
    story.append(section(3, "Gestion de clientes"))
    story.append(body(
        "Listado completo de clientes de la asesoria. Cada cliente tiene CIF "
        "(validado con checksum NIF/NIE/CIF), software contable configurado, "
        "numero de facturas y gestores asignados. Permite crear nuevos clientes "
        "y acceder al detalle incluyendo su plan de cuentas."
    ))
    story.append(info_box(
        "<b>Validacion CIF/NIF:</b> Al crear un cliente, el sistema valida el "
        "formato y digito de control del CIF/NIF/NIE con checksum. Los formatos "
        "invalidos se rechazan antes de guardar."
    ))
    story.append(spacer(2))
    story.append(bold("Funcionalidad:"))
    for b in [
        "Creacion de cliente con validacion de CIF/NIF (checksum)",
        "Cuenta de acceso generada automaticamente para el cliente",
        "Configuracion de software contable (A3asesor, Sage 50, Contasol)",
        "Asignacion de gestores responsables",
        "Enlace directo al plan de cuentas del cliente",
    ]:
        story.append(bullet(b))
    story.append(PageBreak())

    # ─── 4. Plan de cuentas ────────────────────────────────────────
    story.append(section(4, "Plan de cuentas por cliente"))
    story.append(body(
        "Cada cliente tiene su propio plan de cuentas contable. Permite importar "
        "desde Excel en formato A3asesor (3 columnas: Cuenta, Descripcion, NIF) "
        "o crear cuentas manualmente. El sistema agrupa automaticamente las "
        "cuentas por NIF, clasificando prefijos 4xx como cuenta proveedor y "
        "6xx/7xx como cuenta de gasto/ingreso."
    ))
    story.append(bold("Funcionalidades:"))
    for b in [
        "Importacion masiva desde Excel (.xlsx) en formato A3",
        "Creacion, edicion y eliminacion manual de cuentas",
        "Agrupacion automatica por NIF (una entrada por proveedor)",
        "Clasificacion por prefijo: 4xx = proveedor, 6xx/7xx = gasto",
        "Busqueda por NIF o razon social",
        "Auto-asignacion en revision: al revisar una factura, si el NIF del "
        "emisor coincide con una entrada del plan, las cuentas se pre-rellenan",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))
    story.append(make_table(
        ["Campo", "Descripcion", "Ejemplo"],
        [
            ["NIF", "CIF/NIF del proveedor", "B12345678"],
            ["Nombre", "Razon social", "Suministros Madrid S.L."],
            ["Cuenta Proveedor", "Codigo 4xx del plan", "400.00015"],
            ["Cuenta Gasto", "Codigo 6xx/7xx del plan", "629.00000"],
            ["% IVA defecto", "Tipo IVA habitual (opcional)", "21%"],
        ],
        col_widths=[35 * mm, 55 * mm, 50 * mm],
    ))
    story.append(PageBreak())

    # ─── 5. Gestion de gestores ────────────────────────────────────
    story.append(section(5, "Gestion de gestores"))
    story.append(body(
        "Panel de gestion del equipo de trabajo. Muestra los gestores registrados "
        "con su email, rol y numero de clientes asignados. El administrador puede "
        "crear nuevos gestores y gestionar las asignaciones cliente-gestor."
    ))
    story.append(PageBreak())

    # ─── 6. Facturas ───────────────────────────────────────────────
    story.append(section(6, "Facturas — vista completa"))
    story.append(body(
        "Vista centralizada de todas las facturas del sistema. Tabla con columnas "
        "de cliente, archivo, periodo, tipo, estado, total y fecha. Incluye "
        "busqueda, ordenacion por columna, paginacion y seleccion multiple. "
        "Diseno responsive: en movil se ocultan columnas secundarias (Periodo, "
        "Tipo, Fecha) manteniendo la informacion esencial visible."
    ))
    story.append(bold("Acciones masivas (checkboxes):"))
    for b in [
        "Validar N facturas seleccionadas en bloque",
        "Marcar N facturas como exportadas en bloque",
        "Cada accion genera historial de estado y registro de auditoria",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))
    story.append(make_table(
        ["Estado", "Descripcion", "Color"],
        [
            ["UPLOADED", "Factura subida, pendiente de OCR", "Gris"],
            ["ANALYZING", "OCR en proceso con Document AI", "Azul"],
            ["ANALYZED", "OCR completado, pendiente revision", "Amarillo"],
            ["PENDING_REVIEW", "Guardada por gestor, falta validar", "Azul"],
            ["NEEDS_ATTENTION", "Con incidencias detectadas", "Amarillo"],
            ["VALIDATED", "Revisada y aprobada por gestor", "Verde"],
            ["EXPORTED", "Exportada a Excel/CSV", "Gris oscuro"],
            ["OCR_ERROR", "Error en el analisis OCR", "Rojo"],
            ["REJECTED", "Rechazada por el gestor", "Rojo"],
        ],
        col_widths=[38 * mm, 70 * mm, 30 * mm],
    ))
    story.append(PageBreak())

    # ─── 7. Lotes ──────────────────────────────────────────────────
    story.append(section(7, "Lotes de facturas"))
    story.append(body(
        "Vista de lotes que agrupa las facturas por cliente y periodo mensual. "
        "Cada tarjeta representa un lote (ej: 'Empresa X — Abril 2026 — 12 facturas') "
        "con barra de progreso segmentada por colores, pills de estado y acciones directas."
    ))
    story.append(bold("Elementos de cada lote:"))
    for b in [
        "Nombre del cliente, CIF, mes/ano y total de facturas",
        "Badge de estado general: Completado (verde), En proceso (azul), Parcial (gris)",
        "Badges de alerta: errores OCR (rojo), incidencias (amarillo)",
        "Barra de progreso segmentada: exportadas (gris), validadas (verde), "
        "rechazadas (rojo), en revision (azul)",
        "Pills con contadores por estado (solo los que tienen facturas)",
        "Boton 'Revisar (N)': enlaza a la primera factura pendiente del lote "
        "y entra en modo de revision secuencial",
        "Boton 'Ver todas': enlaza a la tabla de facturas filtrada por cliente+periodo",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))
    story.append(info_box(
        "<b>Revision secuencial:</b> Al pulsar 'Revisar' se entra en la primera "
        "factura pendiente. El sistema muestra navegacion '3 de 15' con flechas "
        "para saltar entre facturas del mismo lote. Al validar, salta "
        "automaticamente a la siguiente."
    ))
    story.append(PageBreak())

    # ─── 8. Revision OCR ──────────────────────────────────────────
    story.append(section(8, "Revision de factura (OCR)"))
    story.append(body(
        "Pantalla de revision a doble panel: a la izquierda el visor del documento "
        "(PDF, imagen o XML) y a la derecha el formulario con los datos extraidos "
        "por OCR. El gestor puede corregir, validar o rechazar cada factura."
    ))
    story.append(bold("Datos del formulario (alineados con plantilla A3asesor):"))
    for b in [
        "Emisor: Nombre/Razon social, CIF/NIF (con warning si formato invalido)",
        "Receptor: Nombre/Razon social, CIF/NIF",
        "Factura: Numero, Fecha de expedicion",
        "Periodo contable: Mes y ano (puede diferir del periodo de subida)",
        "Importes: Base imponible, % IVA, Cuota IVA, Total (con bounds 0-100 para IVA)",
        "Cuentas contables: Cuenta proveedor (4xx), Cuenta gasto (6xx/7xx) — "
        "auto-asignadas desde plan de cuentas si el NIF coincide",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))
    story.append(bold("Validaciones automaticas:"))
    for b in [
        "Semaforo matematico: Base + IVA = Total (rojo/verde en tiempo real)",
        "Badges de confianza OCR por campo (alta/media/baja)",
        "Deteccion de duplicados por hash SHA-256",
        "Comparacion OCR vs valores actuales (tabla expandible)",
        "Validacion de bounds: % IVA entre 0-100, importes no negativos",
        "Warning de CIF invalido bajo el campo del emisor",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))
    story.append(info_box(
        "<b>Nota:</b> El IRPF se ha ocultado del formulario y las validaciones "
        "ya que la plantilla A3asesor no lo requiere y Document AI no lo extrae. "
        "Los campos siguen existiendo en la base de datos para compatibilidad "
        "con FacturaE XML."
    ))
    story.append(PageBreak())

    # ─── 9. Exportacion ────────────────────────────────────────────
    story.append(section(9, "Exportacion a software contable"))
    story.append(body(
        "Genera archivos listos para importar en software contable. Permite "
        "seleccionar cliente, periodo, tipo de factura y formato de exportacion. "
        "Muestra resumen de exportacion y historial de exportaciones anteriores."
    ))
    story.append(spacer(2))
    story.append(make_table(
        ["Formato", "Tipo", "Columnas", "Descripcion"],
        [
            ["A3asesor Excel", ".xlsx", "13",
             "Formato completo con cuentas contables. 2 hojas: recibidas/emitidas"],
            ["A3 CSV", ".csv", "9",
             "Formato basico sin cuentas contables"],
            ["Sage 50", ".csv", "11",
             "Formato estandar con IRPF"],
            ["Contasol", ".csv", "11",
             "Formato compatible con Contasol"],
        ],
        col_widths=[30 * mm, 12 * mm, 18 * mm, 80 * mm],
    ))
    story.append(spacer(2))
    story.append(bold("Columnas A3asesor Excel (13 columnas):"))
    for b in [
        "Fecha de Expedicion, Fecha de Contabilizacion, Concepto",
        "Numero Factura, NIF, Nombre, Tipo de Operacion",
        "Cuenta Cliente/Proveedor (4xx), Cuenta de Compras/Ventas (6xx/7xx)",
        "Base, % IVA, Cuota IVA, Enlace de la Factura",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))
    story.append(info_box(
        "<b>Re-exportacion:</b> Las facturas ya exportadas se pueden volver a "
        "exportar sin cambiar su estado. El historial de exportaciones mantiene "
        "trazabilidad completa con snapshots de cada factura al momento de exportar."
    ))
    story.append(PageBreak())

    # ─── 10. Cierres ──────────────────────────────────────────────
    story.append(section(10, "Cierres de periodo"))
    story.append(body(
        "Funcionalidad de cierre mensual de periodos por cliente. Una vez cerrado "
        "un periodo, no se pueden subir, editar ni validar facturas de ese mes. "
        "Incluye recordatorios automaticos diarios para clientes sin cierre."
    ))
    story.append(bold("Funcionalidades:"))
    for b in [
        "Cerrar periodo: bloquea modificaciones en el mes seleccionado",
        "Reabrir periodo: permite desbloquear si es necesario",
        "Recordatorios automaticos: cron diario que notifica por email",
        "Historial completo: registro de todos los cierres y reaperturas",
        "Bloqueo en cascada: afecta subida (cliente y gestor) y revision",
    ]:
        story.append(bullet(b))
    story.append(PageBreak())

    # ─── 11. Auditoria ────────────────────────────────────────────
    story.append(section(11, "Registro de auditoria"))
    story.append(body(
        "Registro de trazabilidad completa de todos los cambios realizados en las "
        "facturas. Cada registro incluye fecha, usuario, factura, cliente, campo "
        "modificado y valores anterior/nuevo."
    ))
    story.append(bold("Filtros disponibles:"))
    for b in [
        "Busqueda por texto (archivo, cliente)",
        "Filtro por usuario (quien realizo el cambio)",
        "Filtro por campo modificado (Estado, CIF, Base imponible, etc.)",
        "Rango de fechas (desde/hasta)",
    ]:
        story.append(bullet(b))
    story.append(PageBreak())

    # ─── 12. Ajustes ──────────────────────────────────────────────
    story.append(section(12, "Ajustes de asesoria"))
    story.append(body(
        "Configuracion de la asesoria: nombre/razon social y CIF/NIF. Tambien "
        "incluye secciones de perfil personal, cambio de contrasena y gestion "
        "de equipo."
    ))
    story.append(PageBreak())

    # ─── 13. Panel Gestor ─────────────────────────────────────────
    story.append(section(13, "Panel del Gestor"))
    story.append(body(
        "Vista personalizada para el gestor. Muestra clientes asignados, "
        "facturas pendientes de revisar y facturas validadas hoy. Acceso rapido "
        "a la lista de facturas recientes y a los lotes por periodo."
    ))
    story.append(PageBreak())

    # ─── 14. Subida Gestor ────────────────────────────────────────
    story.append(section(14, "Subida de facturas (Gestor)"))
    story.append(body(
        "Los gestores pueden subir facturas en nombre de sus clientes asignados. "
        "Incluye selector de cliente, configuracion de lote (mes, ano, tipo) y "
        "zona de arrastre para multiples archivos."
    ))
    story.append(bold("Validaciones:"))
    for b in [
        "Verificacion de asignacion gestor-cliente",
        "Periodo abierto (no cerrado)",
        "Deduplicacion por hash SHA-256",
        "Tamano maximo de 10 MB por archivo",
        "Formatos aceptados: PDF, XML, JPG, PNG, WEBP, HEIC",
    ]:
        story.append(bullet(b))
    story.append(PageBreak())

    # ─── 15. Panel Cliente ────────────────────────────────────────
    story.append(section(15, "Panel del Cliente"))
    story.append(body(
        "Vista simplificada para el cliente. Muestra total de facturas, facturas "
        "en proceso y facturas validadas. Listado de facturas recientes con "
        "estado visible. Acceso directo a subida de facturas."
    ))
    story.append(PageBreak())

    # ─── 16. Subida Cliente ───────────────────────────────────────
    story.append(section(16, "Subida de facturas (Cliente)"))
    story.append(body(
        "Formulario de subida para clientes. Configuracion de lote con mes, ano "
        "y tipo (recibidas/emitidas). Zona de arrastre para subir multiples "
        "archivos. Los archivos se analizan automaticamente con OCR tras la subida."
    ))
    story.append(info_box(
        "<b>Formatos soportados:</b> PDF, XML (FacturaE), JPG, PNG, WEBP — "
        "Maximo 10 MB por archivo. Deduplicacion automatica por hash SHA-256."
    ))
    story.append(PageBreak())

    # ─── 17. Ciclo de vida ────────────────────────────────────────
    story.append(section(17, "Ciclo de vida de una factura"))
    story.append(body(
        "Flujo completo desde la subida hasta el cierre de periodo:"
    ))
    story.append(spacer(2))
    story.append(make_table(
        ["Paso", "Accion", "Actor", "Estado"],
        [
            ["1", "Subida de factura (drag & drop)", "Cliente / Gestor", "UPLOADED"],
            ["2", "Analisis OCR automatico (Document AI)", "Sistema", "ANALYZING -> ANALYZED"],
            ["3", "Deteccion de incidencias", "Sistema", "NEEDS_ATTENTION"],
            ["4", "Revision de datos extraidos", "Gestor", "PENDING_REVIEW"],
            ["5", "Auto-asignacion de cuentas contables", "Sistema", "(si NIF en plan)"],
            ["6", "Validacion o rechazo", "Gestor", "VALIDATED / REJECTED"],
            ["7", "Exportacion (A3 Excel / CSV)", "Admin", "EXPORTED"],
            ["8", "Re-exportacion (si necesario)", "Admin", "EXPORTED"],
            ["9", "Cierre de periodo mensual", "Admin", "Periodo bloqueado"],
        ],
        col_widths=[12 * mm, 55 * mm, 32 * mm, 42 * mm],
    ))
    story.append(PageBreak())

    # ─── 18. Stack ─────────────────────────────────────────────────
    story.append(section(18, "Stack tecnologico"))
    story.append(spacer(2))
    story.append(make_table(
        ["Componente", "Tecnologia"],
        [
            ["Frontend", "Next.js 16.2 (App Router, Turbopack, Server Components)"],
            ["Base de datos", "PostgreSQL (Supabase) + Prisma ORM"],
            ["OCR", "Google Document AI — Invoice Parser"],
            ["Autenticacion", "NextAuth.js v5 con Credentials provider"],
            ["Email", "Resend (bienvenida, validacion, rechazo, recordatorios)"],
            ["Almacenamiento", "Supabase Storage (facturas originales)"],
            ["Hosting", "Vercel (Hobby plan)"],
            ["Cron jobs", "Vercel Cron (alertas diarias)"],
            ["Excel", "SheetJS (xlsx) para importacion/exportacion"],
        ],
        col_widths=[40 * mm, 100 * mm],
    ))
    story.append(PageBreak())

    # ─── 19. Novedades v3 ─────────────────────────────────────────
    story.append(section(19, "Novedades en v3 (respecto a v2)"))
    story.append(body(
        "Listado completo de cambios y mejoras incorporados en esta version:"
    ))
    story.append(spacer(2))

    story.append(bold("OCR y procesamiento"))
    for b in [
        "Migracion de OpenAI GPT-4o Vision a Google Document AI (Invoice Parser)",
        "Scores de confianza por campo desde Document AI",
        "Cache de autenticacion Google (singleton AuthClient)",
        "Timeout de 60s en llamadas OCR",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))

    story.append(bold("Plan de cuentas"))
    for b in [
        "Nuevo modelo AccountEntry con relacion a Client",
        "Importacion masiva desde Excel A3 (.xlsx)",
        "CRUD completo (crear, editar, eliminar cuentas)",
        "Auto-asignacion de cuentas en revision por NIF",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))

    story.append(bold("Exportacion A3asesor"))
    for b in [
        "Nuevo formato A3asesor Excel (.xlsx) con 13 columnas exactas",
        "2 hojas automaticas: Facturas recibidas / Facturas emitidas",
        "Validacion pre-exportacion (warnings no bloqueantes)",
        "Formato por defecto cambiado de Sage50 a A3 Excel",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))

    story.append(bold("Alineacion con plantilla A3"))
    for b in [
        "IRPF oculto del formulario de revision y validaciones",
        "Formula simplificada: Base + IVA = Total (sin IRPF)",
        "Campos del formulario alineados con las 13 columnas A3",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))

    story.append(bold("Validaciones y seguridad"))
    for b in [
        "Validacion CIF/NIF/NIE con checksum (digito de control)",
        "Warning visual en ReviewForm para CIF invalido",
        "Bounds numericos: % IVA 0-100, importes no negativos (client+server)",
        "Error boundary (error.tsx) y 404 personalizado (not-found.tsx)",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))

    story.append(bold("Base de datos"))
    for b in [
        "onDelete Cascade en todas las FK hijas (10 relaciones)",
        "Indexes de rendimiento: Invoice(clientId+status, issuerCif, periodo), AccountEntry(clientId)",
        "Campos supplierAccount y expenseAccount en Invoice",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))

    story.append(bold("Lotes de facturas"))
    for b in [
        "Paginas de lotes reescritas: agrupacion por cliente + periodo mensual",
        "Barra de progreso segmentada por colores de estado",
        "Boton 'Revisar' enlaza a primera factura pendiente del lote",
        "Pills de estado con contadores (solo estados con facturas)",
        "Sidebar: 'Nuevo lote' enlaza a pagina de subida",
    ]:
        story.append(bullet(b))
    story.append(spacer(2))

    story.append(bold("UI/UX"))
    for b in [
        "Tablas responsive: columnas secundarias ocultas en movil",
        "Overflow-x-auto en AccountsTable",
        "Padding responsive (px-3 md:px-5)",
    ]:
        story.append(bullet(b))

    # Build
    doc.build(story)
    print(f"Informe generado: {output_path}")
    return output_path


if __name__ == "__main__":
    build()
