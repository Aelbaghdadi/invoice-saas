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

OUTPUT = os.path.join(os.path.dirname(__file__), "..", "docs", "FacturOCR_Informe_UI.pdf")
SCREENSHOTS = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

# Image helper: fit screenshot to page width with border
PAGE_W = A4[0] - 40*mm  # usable width

def screenshot(filename, caption=None):
    """Return flowables for a screenshot with optional caption."""
    fpath = os.path.join(SCREENSHOTS, filename)
    if not os.path.exists(fpath):
        return [Paragraph(f"<i>[Captura no disponible: {filename}]</i>", small_style)]
    img = Image(fpath, width=PAGE_W, height=PAGE_W * 0.64)  # 16:10 ratio
    img.hAlign = "CENTER"
    elements = [Spacer(1, 3*mm), img]
    if caption:
        elements.append(Paragraph(
            f"<i>{caption}</i>",
            ParagraphStyle("Caption", parent=small_style, alignment=TA_CENTER, spaceBefore=3, spaceAfter=6)
        ))
    else:
        elements.append(Spacer(1, 4*mm))
    return elements

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
RED_LIGHT = HexColor("#fef2f2")

styles = getSampleStyleSheet()

# Custom styles
title_style = ParagraphStyle(
    "CustomTitle", parent=styles["Title"],
    fontSize=28, leading=34, textColor=SLATE_800,
    spaceAfter=6, fontName="Helvetica-Bold"
)
subtitle_style = ParagraphStyle(
    "CustomSubtitle", parent=styles["Normal"],
    fontSize=14, leading=18, textColor=SLATE_600,
    spaceAfter=20, fontName="Helvetica"
)
h1_style = ParagraphStyle(
    "H1", parent=styles["Heading1"],
    fontSize=20, leading=26, textColor=BLUE,
    spaceBefore=16, spaceAfter=10, fontName="Helvetica-Bold"
)
h2_style = ParagraphStyle(
    "H2", parent=styles["Heading2"],
    fontSize=15, leading=20, textColor=SLATE_800,
    spaceBefore=14, spaceAfter=8, fontName="Helvetica-Bold"
)
h3_style = ParagraphStyle(
    "H3", parent=styles["Heading3"],
    fontSize=12, leading=16, textColor=SLATE_600,
    spaceBefore=10, spaceAfter=6, fontName="Helvetica-Bold"
)
body_style = ParagraphStyle(
    "Body", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=SLATE_600,
    spaceAfter=6, fontName="Helvetica"
)
bullet_style = ParagraphStyle(
    "Bullet", parent=body_style,
    leftIndent=18, bulletIndent=6,
    spaceBefore=2, spaceAfter=2
)
small_style = ParagraphStyle(
    "Small", parent=styles["Normal"],
    fontSize=8, leading=11, textColor=SLATE_400,
    fontName="Helvetica"
)
badge_blue = ParagraphStyle("BadgeBlue", parent=body_style, fontSize=9, textColor=BLUE, fontName="Helvetica-Bold")
badge_green = ParagraphStyle("BadgeGreen", parent=body_style, fontSize=9, textColor=GREEN, fontName="Helvetica-Bold")

def header_footer(canvas, doc):
    canvas.saveState()
    # Header line
    canvas.setStrokeColor(BLUE)
    canvas.setLineWidth(2)
    canvas.line(20*mm, A4[1] - 12*mm, A4[0] - 20*mm, A4[1] - 12*mm)
    # Header text
    canvas.setFont("Helvetica-Bold", 9)
    canvas.setFillColor(BLUE)
    canvas.drawString(20*mm, A4[1] - 10*mm, "FacturOCR")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE_400)
    canvas.drawRightString(A4[0] - 20*mm, A4[1] - 10*mm, "Informe de UI y Funcionalidades")
    # Footer
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE_400)
    canvas.drawString(20*mm, 12*mm, "FacturOCR - Informe Confidencial")
    canvas.drawRightString(A4[0] - 20*mm, 12*mm, f"Pagina {doc.page}")
    canvas.setStrokeColor(SLATE_100)
    canvas.setLineWidth(0.5)
    canvas.line(20*mm, 16*mm, A4[0] - 20*mm, 16*mm)
    canvas.restoreState()

doc = SimpleDocTemplate(
    OUTPUT, pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm,
    topMargin=18*mm, bottomMargin=22*mm
)

story = []

# ═══════════════════════════════════════════════════════════════
# COVER PAGE
# ═══════════════════════════════════════════════════════════════
story.append(Spacer(1, 60*mm))
story.append(Paragraph("FacturOCR", ParagraphStyle(
    "Logo", parent=title_style, fontSize=42, textColor=BLUE, alignment=TA_CENTER
)))
story.append(Spacer(1, 8*mm))
story.append(Paragraph("Informe de Interfaz de Usuario<br/>y Funcionalidades", ParagraphStyle(
    "CoverTitle", parent=title_style, fontSize=22, alignment=TA_CENTER, textColor=SLATE_800, leading=28
)))
story.append(Spacer(1, 6*mm))
story.append(HRFlowable(width="40%", thickness=2, color=BLUE, spaceBefore=0, spaceAfter=0, hAlign="CENTER"))
story.append(Spacer(1, 6*mm))
story.append(Paragraph("Sistema SaaS de gestion inteligente de facturas<br/>para asesorias contables", ParagraphStyle(
    "CoverSub", parent=subtitle_style, alignment=TA_CENTER, fontSize=12
)))
story.append(Spacer(1, 20*mm))

cover_data = [
    ["Version", "1.0 - MVP"],
    ["Fecha", "29 de marzo de 2026"],
    ["Stack", "Next.js 14 + TypeScript + Prisma + Supabase"],
    ["OCR Engine", "OpenAI GPT-4o Vision"],
]
cover_table = Table(cover_data, colWidths=[45*mm, 80*mm])
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

# ═══════════════════════════════════════════════════════════════
# TABLE OF CONTENTS
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("Indice de contenidos", h1_style))
story.append(Spacer(1, 4*mm))

toc_items = [
    ("1.", "Vision general del sistema"),
    ("2.", "Arquitectura tecnica"),
    ("3.", "Pantallas - Autenticacion"),
    ("4.", "Pantallas - Panel de Administrador"),
    ("5.", "Pantallas - Panel de Gestor (Worker)"),
    ("6.", "Pantallas - Portal del Cliente"),
    ("7.", "Funcionalidades principales"),
    ("8.", "Flujo de datos"),
    ("9.", "Credenciales de demo"),
]
for num, title in toc_items:
    story.append(Paragraph(f"<b>{num}</b>  {title}", ParagraphStyle(
        "TOC", parent=body_style, fontSize=11, spaceBefore=4, spaceAfter=4, leftIndent=10
    )))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 1. VISION GENERAL
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("1. Vision general del sistema", h1_style))
story.append(Paragraph(
    "FacturOCR es una plataforma SaaS disenada para asesorias contables que automatiza "
    "el proceso de extraccion, validacion y exportacion de datos de facturas mediante "
    "OCR e inteligencia artificial (GPT-4o Vision).",
    body_style
))
story.append(Spacer(1, 4*mm))
story.append(Paragraph("Propuesta de valor", h3_style))

value_props = [
    "<b>Automatizacion OCR</b>: Extrae automaticamente CIF, fecha, base imponible, IVA, IRPF y total de facturas en PDF, imagen o XML.",
    "<b>Validacion matematica</b>: Verifica que los importes cuadren antes de aprobar la factura.",
    "<b>Exportacion multi-formato</b>: Genera CSV listos para importar en Sage 50, Contasol y a3con.",
    "<b>Multi-rol</b>: Tres roles diferenciados (Administrador, Gestor, Cliente) con dashboards personalizados.",
    "<b>Auditoria completa</b>: Registro de cada cambio realizado en cada factura con old/new value.",
    "<b>Notificaciones email</b>: Alertas automaticas via Resend al subir y validar facturas.",
]
for vp in value_props:
    story.append(Paragraph(vp, bullet_style, bulletText="\u2022"))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 2. ARQUITECTURA TECNICA
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("2. Arquitectura tecnica", h1_style))
story.append(Spacer(1, 2*mm))

arch_data = [
    ["Componente", "Tecnologia", "Descripcion"],
    ["Frontend", "Next.js 14 App Router", "SSR + RSC, Tailwind CSS, Lucide Icons"],
    ["Backend", "Next.js Server Actions", "Logica de negocio con 'use server'"],
    ["Base de datos", "PostgreSQL (Supabase)", "Prisma ORM con adaptador PrismaPg"],
    ["Almacenamiento", "Supabase Storage", "Bucket 'invoices' con URLs firmadas"],
    ["Autenticacion", "NextAuth.js v5", "JWT + Credentials, bloqueo por intentos"],
    ["OCR / IA", "OpenAI GPT-4o", "Responses API (PDF), Chat Completions (img)"],
    ["Email", "Resend", "Plantillas HTML con branding"],
    ["Despliegue", "Vercel", "CI/CD automatico desde GitHub"],
]
arch_table = Table(arch_data, colWidths=[35*mm, 45*mm, 85*mm])
arch_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
]))
story.append(arch_table)
story.append(Spacer(1, 6*mm))

story.append(Paragraph("Modelo de datos principal", h3_style))
models = [
    "<b>User</b>: id, email, passwordHash, name, role (ADMIN/WORKER/CLIENT), failedAttempts, lockedUntil",
    "<b>AdvisoryFirm</b>: id, name, cif - Datos de la asesoria",
    "<b>Client</b>: id, name, cif, userId, firmId - Empresas cliente de la asesoria",
    "<b>Invoice</b>: id, filename, status, type, periodMonth/Year, campos OCR (issuer, receiver, importes...)",
    "<b>AuditLog</b>: id, invoiceId, userId, field, oldValue, newValue, createdAt",
    "<b>PasswordResetToken</b>: id, email, token, expiresAt",
]
for m in models:
    story.append(Paragraph(m, bullet_style, bulletText="\u2022"))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 3. PANTALLAS - AUTENTICACION
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("3. Pantallas - Autenticacion", h1_style))

story.append(Paragraph("3.1 Pantalla de Login", h2_style))
story.append(Paragraph(
    "Pagina de inicio de sesion con diseno split-panel:",
    body_style
))
login_features = [
    "<b>Panel izquierdo</b>: Branding con gradiente azul-violeta, headline 'Creado para la nueva era de la contabilidad', "
    "pills de features (OCR con IA, Validacion automatica, Exportacion CSV, Multi-cliente, Auditorias) y "
    "stats en tarjetas glassmorphism (< 2 min por factura, 99.5% precision, 0 EUR para empezar).",
    "<b>Panel derecho</b>: Formulario con email, contrasena, enlace a 'Olvidaste tu contrasena' y boton de inicio de sesion.",
    "<b>Seguridad</b>: Bloqueo automatico tras 3 intentos fallidos durante 15 minutos.",
    "<b>Responsive</b>: En movil solo se muestra el formulario con logo.",
]
for f in login_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("01_login.png", "Fig. 1 - Pantalla de Login con diseno split-panel"))

story.append(Paragraph("3.2 Recuperar contrasena", h2_style))
story.append(Paragraph(
    "Flujo completo de recuperacion: el usuario introduce su email, recibe un enlace con token "
    "temporal (expira en 1 hora), y puede establecer una nueva contrasena. Implementado con "
    "Resend para el envio de emails con plantilla HTML profesional.",
    body_style
))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 4. PANTALLAS - ADMINISTRADOR
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("4. Pantallas - Panel de Administrador", h1_style))
story.append(Paragraph(
    "El administrador tiene acceso completo a todas las funcionalidades del sistema. "
    "El sidebar incluye 8 secciones de navegacion.",
    body_style
))

# 4.1 Dashboard
story.append(Paragraph("4.1 Dashboard principal", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin</font>", small_style))
story.append(Spacer(1, 2*mm))
dash_features = [
    "<b>4 KPI cards</b>: Total facturas (con numero de clientes), Pendientes de validar (subidas + en analisis), "
    "Validadas (listas para exportar), Exportadas (enviadas a contabilidad). Cada card con icono y color diferenciado.",
    "<b>Facturas recientes</b>: Tabla con las ultimas facturas mostrando cliente, archivo, periodo, estado y accion rapida.",
    "<b>Progreso por cliente</b>: Barra de progreso visual mostrando % de facturas procesadas por cada cliente.",
    "<b>Actividad reciente</b>: Feed en tiempo real del audit log con cambios realizados por los usuarios.",
]
for f in dash_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("02_admin_dashboard.png", "Fig. 2 - Dashboard del Administrador"))
story.append(PageBreak())

# 4.2 Clientes
story.append(Paragraph("4.2 Gestion de clientes", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/clients</font>", small_style))
client_features = [
    "<b>Lista de clientes</b>: Tabla con nombre, CIF, software contable, numero de facturas, gestores asignados y acciones.",
    "<b>Buscador</b>: Filtrado en tiempo real por nombre o CIF.",
    "<b>Crear cliente</b>: Formulario con razon social, CIF, email, contacto y software contable (Select personalizado). "
    "Genera automaticamente una cuenta de portal con contrasena derivada del CIF.",
    "<b>Detalle de cliente</b>: Vista individual con historial de facturas y datos del cliente.",
]
for f in client_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("03_admin_clientes.png", "Fig. 3 - Gestion de clientes"))

# 4.3 Gestores
story.append(Paragraph("4.3 Gestion de gestores", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/workers</font>", small_style))
worker_features = [
    "<b>Lista de gestores</b>: Nombre, email, numero de clientes asignados.",
    "<b>Crear gestor</b>: Formulario con nombre, email y contrasena. Asignacion de clientes.",
]
for f in worker_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.append(PageBreak())

# 4.4 Facturas
story.append(Paragraph("4.4 Tabla de facturas", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/invoices</font>", small_style))
story.append(Spacer(1, 2*mm))
story.append(Paragraph(
    "Tabla interactiva completa con las siguientes funcionalidades:",
    body_style
))
inv_features = [
    "<b>Filtros por estado</b>: Pestanas para Todas, Subidas, En analisis, Validadas, Exportadas, cada una con contador.",
    "<b>Buscador</b>: Filtrado en tiempo real por nombre de cliente, CIF, nombre de archivo o importe.",
    "<b>Ordenacion</b>: Click en cualquier cabecera de columna (Cliente, Archivo, Periodo, Tipo, Estado, Total, Fecha) "
    "para ordenar ascendente/descendente con iconos indicadores.",
    "<b>Seleccion multiple</b>: Checkboxes individuales + 'seleccionar todo' en la cabecera.",
    "<b>Acciones en lote</b>: Al seleccionar facturas aparecen botones de Validar (marca como validadas), "
    "Exportar (marca como exportadas) y Deseleccionar.",
    "<b>Paginacion</b>: 20 facturas por pagina con controles numerados y flechas prev/next.",
    "<b>Columnas</b>: Cliente (nombre + CIF), Archivo, Periodo, Tipo (badge Recibida/Emitida), Estado (badge con color), "
    "Total (formateado en EUR), Fecha, Acciones (Revisar/Ver/Exportar/Archivar segun estado).",
    "<b>Toast feedback</b>: Notificacion tras acciones masivas exitosas o con error.",
]
for f in inv_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("04_admin_facturas.png", "Fig. 4 - Tabla interactiva de facturas (Admin)"))

# 4.5 Detalle factura
story.append(Paragraph("4.5 Detalle de factura", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/invoices/[id]</font>", small_style))
det_features = [
    "<b>Visor de documento</b>: Preview del PDF o imagen de la factura con URLs firmadas de Supabase.",
    "<b>Datos extraidos</b>: Todos los campos OCR (emisor, receptor, numero, fecha, importes).",
    "<b>Indicador de validacion</b>: Semaforo que muestra si los calculos matematicos cuadran.",
    "<b>Historial de auditoria</b>: Log completo de cambios realizados en esa factura especifica.",
]
for f in det_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))

# 4.6 Export
story.append(Paragraph("4.6 Exportacion CSV", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/export</font>", small_style))
export_features = [
    "<b>Filtros</b>: Cliente (Select personalizado), Periodo (mes + ano), Tipo de factura (Todas/Recibidas/Emitidas).",
    "<b>Formatos</b>: Sage 50 Espana, Contasol, a3con - cada uno con radio button y descripcion.",
    "<b>Panel de resumen</b>: Card lateral con resumen de la exportacion (cliente, periodo, formato, numero de facturas).",
    "<b>Preview</b>: Muestra el numero de facturas validadas antes de descargar.",
    "<b>Descarga</b>: Boton 'Descargar CSV' que genera el archivo y marca las facturas como Exportadas.",
    "<b>Formato CSV</b>: Separador ';', codificacion BOM UTF-8, numeros en formato espanol (1.234,56).",
]
for f in export_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("05_admin_exportar.png", "Fig. 5 - Exportacion CSV con filtros y formatos"))
story.append(PageBreak())

# 4.7 Auditoria
story.append(Paragraph("4.7 Registro de auditoria", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/audit</font>", small_style))
audit_features = [
    "<b>Tabla completa</b>: Fecha/hora, Usuario (con avatar), Factura, Cliente, Campo modificado, Cambio (old -> new).",
    "<b>Cambios visuales</b>: Valores anteriores en rojo tachado, nuevos en verde.",
    "<b>100 entradas recientes</b>: Ordenadas por fecha descendente.",
]
for f in audit_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("06_admin_auditoria.png", "Fig. 6 - Registro de auditoria"))

# 4.8 Ajustes
story.append(Paragraph("4.8 Ajustes", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/settings</font>", small_style))
settings_features = [
    "<b>Datos de la asesoria</b>: Nombre/Razon social y CIF/NIF editables.",
    "<b>Mi perfil</b>: Nombre y email del usuario.",
    "<b>Contrasena</b>: Cambio de contrasena.",
    "<b>Equipo</b>: Lista de todos los miembros del equipo con rol y fecha de alta.",
]
for f in settings_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("07_admin_ajustes.png", "Fig. 7 - Ajustes de la asesoria y perfil"))

# 4.9 Lotes
story.append(Paragraph("4.9 Lotes", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/admin/batch</font>", small_style))
batch_features = [
    "<b>Vista por cliente</b>: Card por cada cliente con numero de facturas y barra de progreso.",
    "<b>Desglose por estado</b>: Subidas, En analisis, Validadas, Exportadas con contadores.",
    "<b>Accion rapida</b>: Enlace directo para revisar el lote de cada cliente.",
]
for f in batch_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("08_admin_lotes.png", "Fig. 8 - Vista de lotes por cliente"))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 5. PANTALLAS - GESTOR
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("5. Pantallas - Panel de Gestor (Worker)", h1_style))
story.append(Paragraph(
    "El gestor trabaja con los clientes que tiene asignados. Su foco principal es la "
    "revision y validacion de facturas.",
    body_style
))

story.append(Paragraph("5.1 Dashboard del gestor", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/worker</font>", small_style))
worker_dash = [
    "<b>3 KPI cards</b>: Clientes asignados, Facturas pendientes, Validadas hoy.",
    "<b>Lista de clientes</b>: Clientes asignados con badge de pendientes.",
    "<b>Facturas recientes</b>: Ultimas facturas de sus clientes con estado y accion.",
]
for f in worker_dash:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("09_worker_dashboard.png", "Fig. 9 - Dashboard del Gestor"))

story.append(Paragraph("5.2 Revision de factura (split-panel)", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/worker/review/[id]</font>", small_style))
story.append(Spacer(1, 2*mm))
story.append(Paragraph(
    "Esta es la pantalla principal de trabajo del gestor. Diseno split-panel:",
    body_style
))
review_features = [
    "<b>Panel izquierdo</b>: Visor del documento original (PDF renderizado o imagen) con carga desde Supabase Storage.",
    "<b>Panel derecho</b>: Formulario editable con todos los campos extraidos por OCR:",
    "    - Emisor: Nombre/Razon social, CIF/NIF",
    "    - Receptor: Nombre/Razon social, CIF/NIF",
    "    - Factura: Numero, Fecha",
    "    - Importes: Base imponible, % IVA, Cuota IVA, % IRPF, Cuota IRPF",
    "<b>Validacion matematica</b>: Semaforo que indica si Base + IVA - IRPF = Total.",
    "<b>Boton Guardar</b>: Guarda los campos sin cambiar el estado de la factura.",
    "<b>Boton Validar</b>: Guarda + marca como VALIDATED + envia email al cliente.",
    "<b>Navegacion</b>: Flechas prev/next para saltar entre facturas del lote. Indicador 'X de Y'.",
    "<b>Optimistic locking</b>: Detecta si otro usuario modifico la factura mientras se editaba.",
    "<b>Audit trail</b>: Cada campo modificado se registra en el log de auditoria.",
]
for f in review_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("11_worker_revision.png", "Fig. 10 - Revision split-panel de factura"))

story.append(Paragraph("5.3 Facturas del gestor", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/worker/invoices</font>", small_style))
winv_features = [
    "<b>Tabla</b>: Archivo, Cliente, Periodo, Tipo, Estado, Fecha, Accion.",
    "<b>Filtro por cliente</b>: Solo muestra facturas de clientes asignados.",
    "<b>Accion Revisar</b>: Solo visible para facturas en estado Subida o En analisis.",
]
for f in winv_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("10_worker_facturas.png", "Fig. 11 - Facturas del Gestor"))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 6. PANTALLAS - CLIENTE
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("6. Pantallas - Portal del Cliente", h1_style))
story.append(Paragraph(
    "El cliente tiene un portal simplificado para subir facturas y consultar su estado.",
    body_style
))

story.append(Paragraph("6.1 Dashboard del cliente", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/client</font>", small_style))
client_dash = [
    "<b>3 KPI cards</b>: Total facturas, En proceso, Validadas.",
    "<b>Boton CTA</b>: 'Subir facturas' destacado.",
    "<b>Facturas recientes</b>: Lista con nombre, periodo, tipo y badge de estado.",
]
for f in client_dash:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("12_client_dashboard.png", "Fig. 12 - Dashboard del Cliente"))

story.append(Paragraph("6.2 Subir facturas", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/client/upload</font>", small_style))
upload_features = [
    "<b>Configuracion del lote</b>: Seleccion de mes, ano y tipo (Recibidas/Emitidas) con Select personalizado.",
    "<b>Zona de arrastre</b>: Drag & drop con visual feedback. Soporta PDF, XML, JPG, PNG, WEBP, HEIC.",
    "<b>Lista de archivos</b>: Preview con nombre, tamano e icono segun tipo. Boton para eliminar antes de subir.",
    "<b>Limite</b>: Maximo 10 MB por archivo.",
    "<b>Feedback</b>: Toast de exito/error tras la subida.",
    "<b>Post-upload</b>: Los archivos se suben a Supabase Storage y se dispara el procesamiento OCR automatico.",
    "<b>Notificacion</b>: Se envia email a los gestores asignados avisando de la nueva subida.",
]
for f in upload_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("13_client_subir.png", "Fig. 13 - Subida de facturas (drag & drop)"))

story.append(Paragraph("6.3 Mis facturas", h2_style))
story.append(Paragraph("Ruta: <font color='#2563eb'>/dashboard/client/invoices</font>", small_style))
cinv_features = [
    "<b>Tabla simplificada</b>: Archivo, Periodo, Tipo, Estado, Fecha.",
    "<b>Solo sus facturas</b>: Filtrado automatico por la empresa del cliente.",
]
for f in cinv_features:
    story.append(Paragraph(f, bullet_style, bulletText="\u2022"))
story.extend(screenshot("14_client_facturas.png", "Fig. 14 - Mis facturas (vista Cliente)"))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 7. FUNCIONALIDADES PRINCIPALES
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("7. Funcionalidades principales", h1_style))

func_data = [
    ["Funcionalidad", "Estado", "Descripcion"],
    ["Login con roles", "Completo", "3 roles: Admin, Worker, Client con dashboards diferenciados"],
    ["Recuperar contrasena", "Completo", "Flujo email con token temporal via Resend"],
    ["Bloqueo de cuenta", "Completo", "3 intentos fallidos = 15 min de bloqueo"],
    ["Dashboard Admin", "Completo", "KPIs, facturas recientes, progreso clientes, actividad"],
    ["Dashboard Worker", "Completo", "KPIs, clientes asignados, facturas pendientes"],
    ["Dashboard Cliente", "Completo", "KPIs, facturas recientes, CTA subida"],
    ["Gestion clientes", "Completo", "CRUD con asignacion de gestores y software contable"],
    ["Gestion gestores", "Completo", "CRUD con asignacion a clientes"],
    ["Upload facturas", "Completo", "Drag & drop multi-archivo, 6 formatos soportados"],
    ["OCR con GPT-4o", "Completo", "Extraccion automatica de PDF, imagenes y XML (FacturaE)"],
    ["Revision split-panel", "Completo", "Visor + formulario editable con validacion matematica"],
    ["Validacion matematica", "Completo", "Verificacion Base + IVA - IRPF = Total"],
    ["Acciones en lote", "Completo", "Validar/Exportar multiples facturas a la vez"],
    ["Exportacion CSV", "Completo", "3 formatos: Sage 50, Contasol, a3con"],
    ["Auditoria", "Completo", "Log completo de cambios field-level con old/new"],
    ["Busqueda global", "Completo", "Ctrl+K para buscar clientes y facturas en tiempo real"],
    ["Notificaciones email", "Completo", "Upload nuevo -> workers, Validacion -> cliente"],
    ["Optimistic locking", "Completo", "Prevencion de ediciones concurrentes"],
    ["Select personalizado", "Completo", "Dropdown moderno en todos los formularios"],
    ["Paginacion", "Completo", "20 items/pagina con controles numerados"],
    ["Pagina 404", "Completo", "Pagina personalizada con branding"],
    ["Responsive", "Completo", "Sidebar overlay movil, grids adaptativos, tablas scrollables"],
]
func_table = Table(func_data, colWidths=[42*mm, 20*mm, 103*mm])
func_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
    ("FONTNAME", (1, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("BACKGROUND", (1, 1), (1, -1), GREEN_LIGHT),
    ("TEXTCOLOR", (1, 1), (1, -1), GREEN),
    ("FONTNAME", (1, 1), (1, -1), "Helvetica-Bold"),
]))
story.append(func_table)
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 8. FLUJO DE DATOS
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("8. Flujo de datos", h1_style))
story.append(Spacer(1, 4*mm))

flow_data = [
    ["Paso", "Actor", "Accion", "Sistema"],
    ["1", "Cliente", "Sube facturas (PDF/XML/IMG)", "Almacena en Supabase Storage + crea registro Invoice"],
    ["2", "Sistema", "Procesamiento OCR automatico", "GPT-4o extrae campos, guarda en BD, estado -> ANALYZING"],
    ["3", "Sistema", "Notificacion", "Email a gestores asignados via Resend"],
    ["4", "Gestor", "Revisa factura en split-panel", "Edita campos, validacion matematica en tiempo real"],
    ["5", "Gestor", "Valida factura", "Estado -> VALIDATED, audit log, email a cliente"],
    ["6", "Admin", "Exporta facturas validadas", "Genera CSV (Sage/Contasol/a3con), estado -> EXPORTED"],
    ["7", "Admin", "Consulta auditoria", "Historial completo de cambios con old/new values"],
]
flow_table = Table(flow_data, colWidths=[12*mm, 18*mm, 50*mm, 85*mm])
flow_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, BLUE_LIGHT]),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ALIGN", (0, 0), (0, -1), "CENTER"),
    ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
    ("TEXTCOLOR", (0, 1), (0, -1), BLUE),
]))
story.append(flow_table)
story.append(Spacer(1, 8*mm))

story.append(Paragraph("Ciclo de vida de una factura", h3_style))
story.append(Spacer(1, 3*mm))

status_data = [
    ["Estado", "Color", "Significado", "Siguiente accion"],
    ["UPLOADED", "Azul", "Factura subida, pendiente de OCR", "Procesamiento automatico"],
    ["ANALYZING", "Amarillo", "OCR completado, pendiente de revision", "Gestor revisa y edita"],
    ["VALIDATED", "Verde", "Revisada y aprobada por gestor", "Admin exporta a CSV"],
    ["EXPORTED", "Gris", "Exportada al software contable", "Archivada"],
]
status_table = Table(status_data, colWidths=[28*mm, 18*mm, 55*mm, 64*mm])
status_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), SLATE_800),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, SLATE_100]),
]))
story.append(status_table)
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════
# 9. CREDENCIALES DE DEMO
# ═══════════════════════════════════════════════════════════════
story.append(Paragraph("9. Credenciales de demo", h1_style))
story.append(Spacer(1, 4*mm))
story.append(Paragraph(
    "Para acceder al entorno de demostracion, utilice las siguientes credenciales:",
    body_style
))
story.append(Spacer(1, 4*mm))

cred_data = [
    ["Rol", "Email", "Contrasena", "Funcionalidades"],
    ["Administrador", "admin@demo.com", "admin123", "Acceso completo: clientes, gestores, facturas, export, auditoria, ajustes"],
    ["Gestor", "worker@demo.com", "worker123", "Revision de facturas, validacion, clientes asignados"],
    ["Cliente", "azeddinebaghdadi2\n@gmail.com", "25004036", "Subida de facturas, consulta de estado"],
]
cred_table = Table(cred_data, colWidths=[28*mm, 45*mm, 25*mm, 67*mm])
cred_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
    ("FONTNAME", (1, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, BLUE_LIGHT]),
    ("GRID", (0, 0), (-1, -1), 0.5, SLATE_400),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
]))
story.append(cred_table)
story.append(Spacer(1, 10*mm))

story.append(Paragraph("URL de produccion", h3_style))
story.append(Paragraph(
    "<font color='#2563eb'>https://invoice-saas-6pkzb6wgt-aelbaghdadis-projects.vercel.app</font>",
    ParagraphStyle("URL", parent=body_style, fontSize=11, fontName="Helvetica-Bold")
))
story.append(Spacer(1, 6*mm))

story.append(Paragraph("Repositorio", h3_style))
story.append(Paragraph(
    "<font color='#2563eb'>https://github.com/Aelbaghdadi/invoice-saas</font>",
    ParagraphStyle("URL2", parent=body_style, fontSize=11, fontName="Helvetica-Bold")
))

# Build
doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(f"PDF generado: {OUTPUT}")
