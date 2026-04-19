from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor, white, black
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable, Image
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.pdfgen import canvas as pdfcanvas
import os

OUTPUT = os.path.join(os.path.dirname(__file__), "..", "docs", "FacturOCR_Informe_v2.pdf")
SCREENSHOTS = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots_v2")
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

PAGE_W = A4[0] - 40*mm

# Colors
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

def screenshot(filename, caption=None):
    fpath = os.path.join(SCREENSHOTS, filename)
    if not os.path.exists(fpath):
        return [Paragraph(f"<i>[Captura no disponible: {filename}]</i>", small_style)]
    img = Image(fpath, width=PAGE_W, height=PAGE_W * 0.64)
    img.hAlign = "CENTER"
    elements = [Spacer(1, 3*mm), img]
    if caption:
        elements.append(Paragraph(f"<i>{caption}</i>",
            ParagraphStyle("Cap", parent=small_style, alignment=TA_CENTER, spaceBefore=3, spaceAfter=6)))
    else:
        elements.append(Spacer(1, 4*mm))
    return elements

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(BLUE)
    canvas.setLineWidth(2)
    canvas.line(20*mm, A4[1] - 12*mm, A4[0] - 20*mm, A4[1] - 12*mm)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(BLUE)
    canvas.drawString(20*mm, A4[1] - 10*mm, "FacturOCR")
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(SLATE_400)
    canvas.drawRightString(A4[0] - 20*mm, A4[1] - 10*mm, "Informe de producto v2 — Abril 2026")
    canvas.setStrokeColor(SLATE_100)
    canvas.setLineWidth(0.5)
    canvas.line(20*mm, 14*mm, A4[0] - 20*mm, 14*mm)
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(SLATE_400)
    canvas.drawString(20*mm, 9*mm, "FacturOCR — Documento confidencial")
    canvas.drawRightString(A4[0] - 20*mm, 9*mm, f"Pagina {doc.page}")
    canvas.restoreState()

def colored_box(text, bg_color, text_color=SLATE_800):
    return Table(
        [[Paragraph(text, ParagraphStyle("box", parent=body_style, textColor=text_color, fontSize=10))]],
        colWidths=[PAGE_W],
        style=TableStyle([
            ("BACKGROUND", (0,0), (-1,-1), bg_color),
            ("BOX", (0,0), (-1,-1), 0.5, bg_color),
            ("TOPPADDING", (0,0), (-1,-1), 8),
            ("BOTTOMPADDING", (0,0), (-1,-1), 8),
            ("LEFTPADDING", (0,0), (-1,-1), 12),
            ("RIGHTPADDING", (0,0), (-1,-1), 12),
            ("ROUNDEDCORNERS", [6,6,6,6]),
        ])
    )

def build_pdf():
    doc = SimpleDocTemplate(OUTPUT, pagesize=A4,
        topMargin=18*mm, bottomMargin=18*mm, leftMargin=20*mm, rightMargin=20*mm)
    story = []

    # ======================== COVER PAGE ========================
    story.append(Spacer(1, 60*mm))
    story.append(Paragraph("FacturOCR", ParagraphStyle("Logo", parent=title_style, fontSize=42, textColor=BLUE)))
    story.append(Spacer(1, 8*mm))
    story.append(Paragraph("Informe de producto MVP v2", title_style))
    story.append(Paragraph("Plataforma SaaS de gestion inteligente de facturas con OCR", subtitle_style))
    story.append(Spacer(1, 10*mm))

    cover_data = [
        ["Version", "MVP v2 — Abril 2026"],
        ["Stack", "Next.js 16 + Prisma + Supabase + Resend"],
        ["Roles", "Administrador, Gestor (Worker), Cliente"],
        ["Funcionalidades", "OCR, Validacion, Exportacion CSV, Cierres, Auditoria"],
    ]
    cover_table = Table(cover_data, colWidths=[45*mm, PAGE_W - 45*mm])
    cover_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (0,-1), BLUE_LIGHT),
        ("TEXTCOLOR", (0,0), (0,-1), BLUE),
        ("FONTNAME", (0,0), (0,-1), "Helvetica-Bold"),
        ("FONTNAME", (1,0), (1,-1), "Helvetica"),
        ("FONTSIZE", (0,0), (-1,-1), 10),
        ("TOPPADDING", (0,0), (-1,-1), 8),
        ("BOTTOMPADDING", (0,0), (-1,-1), 8),
        ("LEFTPADDING", (0,0), (-1,-1), 10),
        ("GRID", (0,0), (-1,-1), 0.5, BLUE_MED),
        ("ROUNDEDCORNERS", [4,4,4,4]),
    ]))
    story.append(cover_table)
    story.append(PageBreak())

    # ======================== INDEX ========================
    story.append(Paragraph("Indice", h1_style))
    toc = [
        "1. Inicio de sesion",
        "2. Panel de Administrador",
        "3. Gestion de clientes",
        "4. Gestion de gestores",
        "5. Facturas — vista completa",
        "6. Exportacion a software contable",
        "7. Cierres de periodo",
        "8. Registro de auditoria",
        "9. Ajustes de asesoria",
        "10. Panel del Gestor",
        "11. Facturas del Gestor",
        "12. Subida de facturas (Gestor)",
        "13. Panel del Cliente",
        "14. Facturas del Cliente",
        "15. Subida de facturas (Cliente)",
        "16. Ciclo de vida de una factura",
    ]
    for item in toc:
        story.append(Paragraph(f"&bull; {item}", bullet_style))
    story.append(PageBreak())

    # ======================== 1. LOGIN ========================
    story.append(Paragraph("1. Inicio de sesion", h1_style))
    story.append(Paragraph(
        "Pantalla de acceso con autenticacion segura. Soporte para 3 roles: "
        "Administrador, Gestor y Cliente. Incluye bloqueo de cuenta tras intentos fallidos "
        "y enlace de recuperacion de contrasena.",
        body_style))
    story.extend(screenshot("01_login.png", "Pantalla de login con formulario de credenciales"))
    story.append(colored_box(
        "<b>Seguridad:</b> bcrypt para hashing de contrasenas, bloqueo tras 5 intentos fallidos, "
        "sesiones con NextAuth.js y tokens JWT.", BLUE_LIGHT, BLUE))
    story.append(PageBreak())

    # ======================== 2. ADMIN DASHBOARD ========================
    story.append(Paragraph("2. Panel de Administrador", h1_style))
    story.append(Paragraph(
        "Vista general con KPIs en tiempo real: total de facturas, pendientes de validar, "
        "validadas y exportadas. Incluye tabla de facturas recientes, actividad del equipo "
        "y progreso por cliente.",
        body_style))
    story.extend(screenshot("02_admin_dashboard.png", "Dashboard del administrador con metricas y actividad reciente"))
    story.append(Paragraph("Elementos destacados:", h3_style))
    for item in [
        "4 tarjetas KPI con iconos y contadores en tiempo real",
        "Tabla de facturas recientes con estado y acciones",
        "Feed de actividad con historial de cambios",
        "Barra de progreso por cliente (facturas procesadas vs total)",
        "Barra de busqueda global (Ctrl+K) para encontrar clientes y facturas",
    ]:
        story.append(Paragraph(f"&bull; {item}", bullet_style))
    story.append(PageBreak())

    # ======================== 3. CLIENTES ========================
    story.append(Paragraph("3. Gestion de clientes", h1_style))
    story.append(Paragraph(
        "Listado completo de clientes de la asesoria. Cada cliente tiene CIF, software contable "
        "configurado, numero de facturas y gestores asignados. Permite crear nuevos clientes "
        "y acceder al detalle de cada uno.",
        body_style))
    story.extend(screenshot("03_admin_clientes.png", "Lista de clientes con buscador y boton de nuevo cliente"))
    story.append(colored_box(
        "<b>Funcionalidad:</b> Al crear un cliente se genera automaticamente una cuenta de acceso "
        "para el cliente, se configura su software contable (Sage 50, Contasol o a3con) "
        "y se asignan los gestores responsables.", BLUE_LIGHT, BLUE))
    story.append(PageBreak())

    # ======================== 4. GESTORES ========================
    story.append(Paragraph("4. Gestion de gestores", h1_style))
    story.append(Paragraph(
        "Panel de gestion del equipo de trabajo. Muestra los gestores registrados con su email, "
        "rol y numero de clientes asignados. El administrador puede crear nuevos gestores "
        "y gestionar las asignaciones cliente-gestor.",
        body_style))
    story.extend(screenshot("04_admin_gestores.png", "Lista de gestores con sus clientes asignados"))
    story.append(PageBreak())

    # ======================== 5. FACTURAS ========================
    story.append(Paragraph("5. Facturas — vista completa", h1_style))
    story.append(Paragraph(
        "Vista centralizada de todas las facturas del sistema. Filtros por pestanas de estado "
        "(Todas, Subidas, En analisis, Analizadas, Error OCR, Validadas, Rechazadas, Exportadas). "
        "Cada factura muestra cliente, archivo, periodo, tipo, estado, total y fecha.",
        body_style))
    story.extend(screenshot("05_admin_facturas.png", "Tabla de facturas con filtros por estado y busqueda"))
    story.append(Paragraph("Estados del ciclo de vida:", h3_style))

    status_data = [
        ["Estado", "Descripcion", "Color"],
        ["UPLOADED", "Factura subida, pendiente de OCR", "Gris"],
        ["ANALYZING", "OCR en proceso con OpenAI Vision", "Azul"],
        ["ANALYZED", "OCR completado, pendiente revision", "Amarillo"],
        ["VALIDATED", "Revisada y aprobada por gestor", "Verde"],
        ["EXPORTED", "Exportada a CSV para contabilidad", "Azul oscuro"],
        ["OCR_ERROR", "Error en el analisis OCR", "Rojo"],
        ["REJECTED", "Rechazada por el gestor", "Rojo"],
    ]
    status_table = Table(status_data, colWidths=[30*mm, PAGE_W - 60*mm, 30*mm])
    status_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), BLUE),
        ("TEXTCOLOR", (0,0), (-1,0), white),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING", (0,0), (-1,-1), 8),
        ("GRID", (0,0), (-1,-1), 0.5, SLATE_100),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [white, BLUE_LIGHT]),
    ]))
    story.append(status_table)
    story.append(PageBreak())

    # ======================== 6. EXPORTAR ========================
    story.append(Paragraph("6. Exportacion a software contable", h1_style))
    story.append(Paragraph(
        "Genera archivos CSV listos para importar en Sage 50, Contasol o a3con. "
        "Permite seleccionar cliente, periodo y tipo de factura. Muestra resumen de exportacion "
        "y historial de exportaciones anteriores. Soporta re-exportacion de facturas ya exportadas.",
        body_style))
    story.extend(screenshot("06_admin_exportar.png", "Formulario de exportacion con selector de formato y historial"))
    story.append(colored_box(
        "<b>Re-exportacion:</b> Las facturas ya exportadas se pueden volver a exportar sin necesidad "
        "de cambiar su estado. El historial de exportaciones mantiene trazabilidad completa.", GREEN_LIGHT, GREEN))
    story.append(PageBreak())

    # ======================== 7. CIERRES ========================
    story.append(Paragraph("7. Cierres de periodo", h1_style))
    story.append(Paragraph(
        "Funcionalidad de cierre mensual de periodos por cliente. Una vez cerrado un periodo, "
        "no se pueden subir, editar ni validar facturas de ese mes. Incluye recordatorios "
        "automaticos mensuales para clientes sin cierre.",
        body_style))
    story.extend(screenshot("07_admin_cierres.png", "Gestion de cierres con periodos activos y historial"))
    story.append(Paragraph("Funcionalidades:", h3_style))
    for item in [
        "Cerrar periodo: bloquea modificaciones en el mes seleccionado",
        "Reabrir periodo: permite desbloquear si es necesario",
        "Recordatorios automaticos: cron diario que notifica por email a clientes sin cierre",
        "Historial completo: registro de todos los cierres y reaperturas",
        "Bloqueo en cascada: afecta subida (cliente y gestor) y revision",
    ]:
        story.append(Paragraph(f"&bull; {item}", bullet_style))
    story.append(PageBreak())

    # ======================== 8. AUDITORIA ========================
    story.append(Paragraph("8. Registro de auditoria", h1_style))
    story.append(Paragraph(
        "Historial completo e inmutable de todos los cambios realizados en las facturas. "
        "Cada registro incluye fecha, usuario, factura, cliente, campo modificado y valores "
        "anterior/nuevo. Sistema de filtros avanzados.",
        body_style))
    story.extend(screenshot("08_admin_auditoria.png", "Log de auditoria con filtros por usuario, campo y fecha"))
    story.append(Paragraph("Filtros disponibles:", h3_style))
    for item in [
        "Busqueda por texto (archivo, cliente)",
        "Filtro por usuario (quien realizo el cambio)",
        "Filtro por campo modificado (Estado, CIF, Base imponible, etc.)",
        "Rango de fechas (desde/hasta)",
    ]:
        story.append(Paragraph(f"&bull; {item}", bullet_style))
    story.append(PageBreak())

    # ======================== 9. AJUSTES ========================
    story.append(Paragraph("9. Ajustes de asesoria", h1_style))
    story.append(Paragraph(
        "Configuracion de la asesoria: nombre/razon social y CIF/NIF. "
        "Tambien incluye secciones de perfil personal, cambio de contrasena y gestion de equipo.",
        body_style))
    story.extend(screenshot("09_admin_ajustes.png", "Pagina de ajustes con datos de la asesoria"))
    story.append(PageBreak())

    # ======================== 10. WORKER DASHBOARD ========================
    story.append(Paragraph("10. Panel del Gestor", h1_style))
    story.append(Paragraph(
        "Vista personalizada para el gestor. Muestra clientes asignados, facturas pendientes "
        "de revisar y facturas validadas hoy. Acceso rapido a la lista de facturas recientes "
        "de sus clientes asignados.",
        body_style))
    story.extend(screenshot("10_worker_dashboard.png", "Dashboard del gestor con clientes y facturas asignadas"))
    story.append(PageBreak())

    # ======================== 11. WORKER FACTURAS ========================
    story.append(Paragraph("11. Facturas del Gestor", h1_style))
    story.append(Paragraph(
        "Lista de todas las facturas de los clientes asignados al gestor. "
        "Desde aqui el gestor puede acceder a la revision de cada factura para validar "
        "los datos extraidos por OCR, corregirlos o rechazar la factura.",
        body_style))
    story.extend(screenshot("11_worker_facturas.png", "Lista de facturas del gestor con estados"))
    story.append(PageBreak())

    # ======================== 12. WORKER SUBIR ========================
    story.append(Paragraph("12. Subida de facturas (Gestor)", h1_style))
    story.append(Paragraph(
        "Los gestores pueden subir facturas en nombre de sus clientes asignados. "
        "Incluye selector de cliente, configuracion de lote (mes, ano, tipo) "
        "y zona de arrastre para multiples archivos. Se verifica que el gestor "
        "tenga asignacion al cliente y que el periodo no este cerrado.",
        body_style))
    story.extend(screenshot("12_worker_subir.png", "Formulario de subida del gestor con selector de cliente"))
    story.append(colored_box(
        "<b>Validaciones:</b> Se verifica asignacion gestor-cliente, periodo abierto, "
        "deduplicacion por hash SHA-256 y tamano maximo de 10 MB por archivo.", AMBER_LIGHT, AMBER))
    story.append(PageBreak())

    # ======================== 13. CLIENT DASHBOARD ========================
    story.append(Paragraph("13. Panel del Cliente", h1_style))
    story.append(Paragraph(
        "Vista simplificada para el cliente. Muestra total de facturas, facturas en proceso "
        "y facturas validadas. Listado de facturas recientes con estado visible. "
        "Acceso directo a subida de facturas.",
        body_style))
    story.extend(screenshot("14_client_dashboard.png", "Dashboard del cliente con resumen y facturas recientes"))
    story.append(PageBreak())

    # ======================== 14. CLIENT FACTURAS ========================
    story.append(Paragraph("14. Facturas del Cliente", h1_style))
    story.append(Paragraph(
        "Listado completo de facturas del cliente con archivo, periodo, tipo, estado y fecha. "
        "El cliente puede ver el motivo de rechazo cuando aplica. No puede modificar ni "
        "eliminar facturas ya subidas.",
        body_style))
    story.extend(screenshot("15_client_facturas.png", "Lista de facturas del cliente con estados"))
    story.append(PageBreak())

    # ======================== 15. CLIENT SUBIR ========================
    story.append(Paragraph("15. Subida de facturas (Cliente)", h1_style))
    story.append(Paragraph(
        "Formulario de subida para clientes. Configuracion de lote con mes, ano y tipo "
        "(recibidas/emitidas). Zona de arrastre para subir multiples archivos. "
        "Los archivos se analizan automaticamente con OCR tras la subida.",
        body_style))
    story.extend(screenshot("16_client_subir.png", "Formulario de subida del cliente con drag & drop"))
    story.append(colored_box(
        "<b>Formatos soportados:</b> PDF, XML, JPG, PNG, WEBP — Maximo 10 MB por archivo. "
        "Deduplicacion automatica por hash SHA-256.", BLUE_LIGHT, BLUE))
    story.append(PageBreak())

    # ======================== 16. CICLO DE VIDA ========================
    story.append(Paragraph("16. Ciclo de vida de una factura", h1_style))
    story.append(Paragraph(
        "Flujo completo desde la subida hasta el cierre de periodo:", body_style))
    story.append(Spacer(1, 5*mm))

    flow_data = [
        ["Paso", "Accion", "Actor", "Estado resultante"],
        ["1", "Subida de factura (drag & drop)", "Cliente / Gestor", "UPLOADED"],
        ["2", "Analisis OCR automatico (OpenAI Vision)", "Sistema", "ANALYZING -> ANALYZED"],
        ["3", "Revision de datos extraidos", "Gestor", "ANALYZED"],
        ["4", "Validacion o rechazo", "Gestor", "VALIDATED / REJECTED"],
        ["5", "Exportacion a CSV (Sage/Contasol/a3con)", "Admin", "EXPORTED"],
        ["6", "Re-exportacion (si necesario)", "Admin", "EXPORTED"],
        ["7", "Cierre de periodo mensual", "Admin", "Periodo bloqueado"],
    ]
    flow_table = Table(flow_data, colWidths=[12*mm, PAGE_W - 82*mm, 35*mm, 35*mm])
    flow_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), BLUE),
        ("TEXTCOLOR", (0,0), (-1,0), white),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 7),
        ("BOTTOMPADDING", (0,0), (-1,-1), 7),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("GRID", (0,0), (-1,-1), 0.5, SLATE_100),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [white, BLUE_LIGHT]),
        ("ALIGN", (0,0), (0,-1), "CENTER"),
    ]))
    story.append(flow_table)
    story.append(Spacer(1, 8*mm))

    story.append(Paragraph("Stack tecnologico", h2_style))
    tech_data = [
        ["Componente", "Tecnologia"],
        ["Frontend", "Next.js 16.2 (App Router, Turbopack, Server Components)"],
        ["Base de datos", "PostgreSQL (Supabase) + Prisma ORM"],
        ["OCR", "OpenAI GPT-4o Vision API"],
        ["Autenticacion", "NextAuth.js v5 con Credentials provider"],
        ["Email", "Resend (transaccional: bienvenida, recordatorios)"],
        ["Almacenamiento", "Supabase Storage (facturas originales)"],
        ["Hosting", "Vercel (Hobby plan)"],
        ["Cron jobs", "Vercel Cron (alertas diarias + recordatorios mensuales)"],
    ]
    tech_table = Table(tech_data, colWidths=[35*mm, PAGE_W - 35*mm])
    tech_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), SLATE_800),
        ("TEXTCOLOR", (0,0), (-1,0), white),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("BACKGROUND", (0,1), (0,-1), SLATE_100),
        ("FONTNAME", (0,1), (0,-1), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING", (0,0), (-1,-1), 8),
        ("GRID", (0,0), (-1,-1), 0.5, SLATE_100),
    ]))
    story.append(tech_table)

    # Build
    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    print(f"PDF generado: {OUTPUT}")

if __name__ == "__main__":
    build_pdf()
