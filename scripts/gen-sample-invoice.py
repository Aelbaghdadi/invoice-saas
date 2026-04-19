"""Genera un PDF de factura a partir de un JSON de configuracion.

Uso:
    python gen-sample-invoice.py <config.json> <output.pdf>

El JSON debe tener (todos opcionales excepto emisor/receptor/numero/conceptos/base/iva/total):
{
  "emisor":   {"nombre": "...", "cif": "...", "direccion": "...", "cp_ciudad": "..."},
  "receptor": {"nombre": "...", "cif": "...", "direccion": "...", "cp_ciudad": "..."},
  "numero":   "F-2026-0001",
  "fecha_emision": "15/04/2026",
  "fecha_vencimiento": "30/04/2026",
  "periodo":  "01/03/2026 - 31/03/2026",
  "conceptos": [["Descripcion", "Cant.", "Precio", "Importe"], ...],
  "base":     216.00,
  "iva_rate": 21,
  "iva":      45.36,
  "total":    261.36,
  "forma_pago": "Domiciliacion bancaria ...",
  "color_primary": "#1A5F3F",
  "color_accent":  "#88C540",
  "logo_texto":    "IBERDROLA",
  "titulo_cabecera": "FACTURA ELECTRICA",
  "subtitulo_izq":   "Energia para un futuro sostenible",
  "subtitulo_der":   "Documento con validez fiscal",
  "datos_extra_titulo": "PUNTO DE SUMINISTRO",
  "datos_extra": {"CUPS": "...", "Tarifa": "..."}
}
"""
import json
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.pdfgen import canvas


def fmt_eur(n):
    s = f"{n:,.2f}"
    s = s.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{s} EUR"


def build(cfg: dict, out_path: str):
    PRIMARY = colors.HexColor(cfg.get("color_primary", "#1A5F3F"))
    ACCENT = colors.HexColor(cfg.get("color_accent", "#88C540"))
    DARK = colors.HexColor("#1F2937")
    GRAY = colors.HexColor("#6B7280")
    LIGHT = colors.HexColor("#F3F4F6")

    emisor = cfg["emisor"]
    receptor = cfg["receptor"]
    logo = cfg.get("logo_texto", emisor["nombre"].split()[0].upper())
    titulo = cfg.get("titulo_cabecera", "FACTURA")
    subtitulo_izq = cfg.get("subtitulo_izq", "")
    subtitulo_der = cfg.get("subtitulo_der", "Documento con validez fiscal")

    def header_footer(c: canvas.Canvas, doc):
        w, h = A4
        c.setFillColor(PRIMARY)
        c.rect(0, h - 30 * mm, w, 30 * mm, fill=1, stroke=0)
        c.setFillColor(ACCENT)
        c.rect(0, h - 32 * mm, w, 2 * mm, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 22)
        c.drawString(20 * mm, h - 18 * mm, logo)
        c.setFont("Helvetica", 9)
        c.drawString(20 * mm, h - 24 * mm, subtitulo_izq)
        c.setFont("Helvetica-Bold", 14)
        c.drawRightString(w - 20 * mm, h - 17 * mm, titulo)
        c.setFont("Helvetica", 9)
        c.drawRightString(w - 20 * mm, h - 23 * mm, subtitulo_der)
        c.setFillColor(GRAY)
        c.setFont("Helvetica", 8)
        foot = f'{emisor["nombre"]} - CIF {emisor["cif"]} - {emisor.get("direccion", "")}, {emisor.get("cp_ciudad", "")}'
        c.drawString(20 * mm, 15 * mm, foot)
        c.drawRightString(w - 20 * mm, 15 * mm, "Pagina 1 de 1")
        c.setStrokeColor(PRIMARY)
        c.setLineWidth(0.5)
        c.line(20 * mm, 18 * mm, w - 20 * mm, 18 * mm)

    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=40 * mm, bottomMargin=25 * mm,
        title=f'Factura {cfg["numero"]}', author=emisor["nombre"],
    )

    styles = getSampleStyleSheet()
    normal = ParagraphStyle("normal", parent=styles["Normal"], fontSize=9, textColor=DARK)
    label = ParagraphStyle("label", parent=styles["Normal"], fontSize=8, textColor=GRAY, spaceAfter=2)
    bold = ParagraphStyle("bold", parent=styles["Normal"], fontSize=9, textColor=DARK, fontName="Helvetica-Bold")
    section = ParagraphStyle("section", parent=styles["Normal"], fontSize=11, textColor=PRIMARY, fontName="Helvetica-Bold", spaceAfter=6)

    story = []

    info_rows = [
        [Paragraph("No FACTURA", label), Paragraph(cfg["numero"], bold)],
        [Paragraph("FECHA EMISION", label), Paragraph(cfg.get("fecha_emision", ""), bold)],
    ]
    if cfg.get("fecha_vencimiento"):
        info_rows.append([Paragraph("FECHA VENCIMIENTO", label), Paragraph(cfg["fecha_vencimiento"], bold)])
    if cfg.get("periodo"):
        info_rows.append([Paragraph("PERIODO FACTURADO", label), Paragraph(cfg["periodo"], normal)])
    t = Table(info_rows, colWidths=[50 * mm, 60 * mm])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(t)
    story.append(Spacer(1, 10 * mm))

    emisor_html = (
        f"<b>EMISOR</b><br/>{emisor['nombre']}<br/>CIF: {emisor['cif']}<br/>"
        f"{emisor.get('direccion', '')}<br/>{emisor.get('cp_ciudad', '')}"
    )
    receptor_html = (
        f"<b>CLIENTE</b><br/>{receptor['nombre']}<br/>CIF: {receptor['cif']}<br/>"
        f"{receptor.get('direccion', '')}<br/>{receptor.get('cp_ciudad', '')}"
    )
    parties = Table(
        [[Paragraph(emisor_html, normal), Paragraph(receptor_html, normal)]],
        colWidths=[85 * mm, 85 * mm],
    )
    parties.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, GRAY),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, GRAY),
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(parties)
    story.append(Spacer(1, 10 * mm))

    extra = cfg.get("datos_extra")
    if extra:
        story.append(Paragraph(cfg.get("datos_extra_titulo", "DATOS ADICIONALES"), section))
        rows = [[k, v] for k, v in extra.items()]
        tbl = Table(rows, colWidths=[45 * mm, 125 * mm])
        tbl.setStyle(TableStyle([
            ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9),
            ("FONT", (1, 0), (1, -1), "Helvetica", 9),
            ("TEXTCOLOR", (0, 0), (-1, -1), DARK),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 8 * mm))

    story.append(Paragraph("DETALLE DE LA FACTURACION", section))
    items = [["CONCEPTO", "CANTIDAD", "PRECIO UNIT.", "IMPORTE"]] + cfg["conceptos"]
    items_tbl = Table(items, colWidths=[75 * mm, 30 * mm, 35 * mm, 30 * mm])
    items_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("ALIGN", (1, 0), (-1, 0), "RIGHT"),
        ("ALIGN", (0, 0), (0, 0), "LEFT"),
        ("TOPPADDING", (0, 0), (-1, 0), 7),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 7),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("TEXTCOLOR", (0, 1), (-1, -1), DARK),
        ("LINEBELOW", (0, 1), (-1, -2), 0.25, colors.HexColor("#E5E7EB")),
        ("TOPPADDING", (0, 1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(items_tbl)
    story.append(Spacer(1, 6 * mm))

    iva_rate = cfg.get("iva_rate", 21)
    totals = Table([
        ["Base imponible:", fmt_eur(cfg["base"])],
        [f"IVA ({iva_rate}%):", fmt_eur(cfg["iva"])],
        ["TOTAL A PAGAR:", fmt_eur(cfg["total"])],
    ], colWidths=[40 * mm, 35 * mm], hAlign="RIGHT")
    totals.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 1), "Helvetica", 9),
        ("FONT", (0, 2), (-1, 2), "Helvetica-Bold", 11),
        ("TEXTCOLOR", (0, 0), (-1, 1), DARK),
        ("TEXTCOLOR", (0, 2), (-1, 2), PRIMARY),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("LINEABOVE", (0, 2), (-1, 2), 1, PRIMARY),
        ("TOPPADDING", (0, 2), (-1, 2), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(totals)
    story.append(Spacer(1, 12 * mm))

    if cfg.get("forma_pago"):
        story.append(Paragraph("FORMA DE PAGO", section))
        story.append(Paragraph(cfg["forma_pago"], normal))
        story.append(Spacer(1, 10 * mm))

    legal = ParagraphStyle("legal", parent=normal, fontSize=7, textColor=GRAY, leading=9)
    story.append(Paragraph(cfg.get(
        "nota_legal",
        "Factura emitida electronicamente conforme al Real Decreto 1619/2012. Conserve este documento durante el periodo legal establecido.",
    ), legal))

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Uso: python gen-sample-invoice.py <config.json> <output.pdf>")
        sys.exit(1)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cfg = json.load(f)
    build(cfg, sys.argv[2])
    print(f"OK {sys.argv[2]}")
