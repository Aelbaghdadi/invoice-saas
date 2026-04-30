"""
Generate a realistic Spanish electricity invoice PDF for OCR testing
with Google Document AI. Output: scripts/sample-invoice.pdf
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle, Frame
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

OUTPUT = r"C:\Users\Azeddine\Invoice SAAS\invoice-saas\scripts\sample-invoice.pdf"

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm

# Colores estilo factura electrica
GREEN_DARK = colors.HexColor("#0a7a3b")
GREEN_LIGHT = colors.HexColor("#e6f4ec")
GREY_DARK = colors.HexColor("#333333")
GREY_MID = colors.HexColor("#666666")
GREY_LIGHT = colors.HexColor("#f5f5f5")
GREY_BORDER = colors.HexColor("#cccccc")


def euro(v: float) -> str:
    return f"{v:,.2f} EUR".replace(",", "X").replace(".", ",").replace("X", ".")


def draw_header(c: canvas.Canvas):
    # Banda superior verde
    c.setFillColor(GREEN_DARK)
    c.rect(0, PAGE_H - 30 * mm, PAGE_W, 30 * mm, fill=1, stroke=0)

    # Logo / nombre emisor en blanco
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(MARGIN, PAGE_H - 16 * mm, "IBERDROLA")
    c.setFont("Helvetica", 9)
    c.drawString(MARGIN, PAGE_H - 21 * mm, "Iberdrola Clientes S.A.U.")
    c.drawString(MARGIN, PAGE_H - 25 * mm, "CIF: A95758389")

    # Titulo factura a la derecha
    c.setFont("Helvetica-Bold", 18)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 16 * mm, "FACTURA ELECTRICA")
    c.setFont("Helvetica", 9)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 21 * mm, "Calle Tomas Redondo, 1")
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 25 * mm, "28033 Madrid")


def draw_invoice_meta(c: canvas.Canvas, y_top: float) -> float:
    """Caja con datos de la factura (numero, fechas)"""
    box_h = 22 * mm
    box_w = 80 * mm
    x = PAGE_W - MARGIN - box_w
    y = y_top - box_h

    c.setFillColor(GREEN_LIGHT)
    c.setStrokeColor(GREEN_DARK)
    c.setLineWidth(0.7)
    c.rect(x, y, box_w, box_h, fill=1, stroke=1)

    c.setFillColor(GREY_DARK)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 4 * mm, y + box_h - 6 * mm, "Datos de la factura")

    c.setFont("Helvetica", 9)
    c.drawString(x + 4 * mm, y + box_h - 11 * mm, "Numero de factura:")
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(x + box_w - 4 * mm, y + box_h - 11 * mm, "F-2026-04889")

    c.setFont("Helvetica", 9)
    c.drawString(x + 4 * mm, y + box_h - 15 * mm, "Fecha de emision:")
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(x + box_w - 4 * mm, y + box_h - 15 * mm, "15/04/2026")

    c.setFont("Helvetica", 9)
    c.drawString(x + 4 * mm, y + box_h - 19 * mm, "Fecha de vencimiento:")
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(x + box_w - 4 * mm, y + box_h - 19 * mm, "30/04/2026")

    return y


def draw_parties(c: canvas.Canvas, y_top: float) -> float:
    """Bloques EMISOR y RECEPTOR lado a lado"""
    block_w = 85 * mm
    block_h = 30 * mm
    gap = 5 * mm

    # EMISOR
    x1 = MARGIN
    y = y_top - block_h
    c.setStrokeColor(GREY_BORDER)
    c.setFillColor(GREY_LIGHT)
    c.setLineWidth(0.5)
    c.rect(x1, y, block_w, block_h, fill=1, stroke=1)

    c.setFillColor(GREEN_DARK)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x1 + 4 * mm, y + block_h - 6 * mm, "EMISOR")

    c.setFillColor(GREY_DARK)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x1 + 4 * mm, y + block_h - 12 * mm, "Iberdrola Clientes S.A.U.")
    c.setFont("Helvetica", 9)
    c.drawString(x1 + 4 * mm, y + block_h - 17 * mm, "CIF: A95758389")
    c.drawString(x1 + 4 * mm, y + block_h - 22 * mm, "Calle Tomas Redondo, 1")
    c.drawString(x1 + 4 * mm, y + block_h - 27 * mm, "28033 Madrid")

    # RECEPTOR
    x2 = MARGIN + block_w + gap
    c.setFillColor(GREY_LIGHT)
    c.rect(x2, y, block_w, block_h, fill=1, stroke=1)

    c.setFillColor(GREEN_DARK)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x2 + 4 * mm, y + block_h - 6 * mm, "CLIENTE")

    c.setFillColor(GREY_DARK)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x2 + 4 * mm, y + block_h - 12 * mm, "Panaderia La Espiga S.L.")
    c.setFont("Helvetica", 9)
    c.drawString(x2 + 4 * mm, y + block_h - 17 * mm, "CIF: B12345674")
    c.drawString(x2 + 4 * mm, y + block_h - 22 * mm, "Calle Mayor 42")
    c.drawString(x2 + 4 * mm, y + block_h - 27 * mm, "28013 Madrid")

    return y


def draw_supply_info(c: canvas.Canvas, y_top: float) -> float:
    """Datos del suministro (bloque tipico de factura electrica)"""
    box_h = 18 * mm
    x = MARGIN
    w = PAGE_W - 2 * MARGIN
    y = y_top - box_h

    c.setStrokeColor(GREY_BORDER)
    c.setFillColor(colors.white)
    c.setLineWidth(0.5)
    c.rect(x, y, w, box_h, fill=1, stroke=1)

    c.setFillColor(GREEN_DARK)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x + 4 * mm, y + box_h - 5 * mm, "DATOS DEL SUMINISTRO")

    c.setFillColor(GREY_DARK)
    c.setFont("Helvetica", 9)
    c.drawString(x + 4 * mm, y + box_h - 10 * mm, "Direccion suministro:")
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x + 40 * mm, y + box_h - 10 * mm, "Calle Mayor 42, 28013 Madrid")

    c.setFont("Helvetica", 9)
    c.drawString(x + 4 * mm, y + box_h - 14 * mm, "CUPS:")
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x + 40 * mm, y + box_h - 14 * mm, "ES0021000004567890XY1F")

    c.setFont("Helvetica", 9)
    c.drawString(x + 110 * mm, y + box_h - 10 * mm, "Tarifa:")
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x + 130 * mm, y + box_h - 10 * mm, "2.0TD")

    c.setFont("Helvetica", 9)
    c.drawString(x + 110 * mm, y + box_h - 14 * mm, "Periodo:")
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x + 130 * mm, y + box_h - 14 * mm, "01/03/2026 - 31/03/2026")

    return y


def draw_concepts_table(c: canvas.Canvas, y_top: float) -> float:
    """Tabla de conceptos"""
    data = [
        ["Descripcion", "Cantidad", "Precio unit.", "Importe"],
        ["Suministro electrico marzo 2026", "1.250 kWh", "0,148 EUR/kWh", "185,00 EUR"],
        ["Termino de potencia (30 dias)", "4,6 kW", "0,2065 EUR/kW/dia", "28,50 EUR"],
        ["Alquiler equipo de medida", "1 ud.", "2,50 EUR/mes", "2,50 EUR"],
    ]

    col_widths = [85 * mm, 27 * mm, 32 * mm, 30 * mm]
    table = Table(data, colWidths=col_widths, rowHeights=8 * mm)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN_DARK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), 9),
        ("TEXTCOLOR", (0, 1), (-1, -1), GREY_DARK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, GREY_LIGHT]),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, GREEN_DARK),
        ("BOX", (0, 0), (-1, -1), 0.5, GREY_BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))

    table_w = sum(col_widths)
    table_h = 8 * mm * len(data)
    table.wrapOn(c, table_w, table_h)
    table.drawOn(c, MARGIN, y_top - table_h)

    return y_top - table_h


def draw_totals(c: canvas.Canvas, y_top: float) -> float:
    """Tabla de totales a la derecha"""
    data = [
        ["Base imponible", "216,00 EUR"],
        ["IVA (21%)", "45,36 EUR"],
        ["TOTAL FACTURA", "261,36 EUR"],
    ]
    col_widths = [40 * mm, 35 * mm]
    table = Table(data, colWidths=col_widths, rowHeights=9 * mm)
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -2), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -2), 10),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, -1), (-1, -1), 12),
        ("BACKGROUND", (0, -1), (-1, -1), GREEN_DARK),
        ("TEXTCOLOR", (0, -1), (-1, -1), colors.white),
        ("TEXTCOLOR", (0, 0), (-1, -2), GREY_DARK),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEABOVE", (0, 0), (-1, 0), 0.5, GREY_BORDER),
        ("LINEBELOW", (0, -2), (-1, -2), 0.5, GREY_BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))

    table_w = sum(col_widths)
    table_h = 9 * mm * len(data)
    x = PAGE_W - MARGIN - table_w
    table.wrapOn(c, table_w, table_h)
    table.drawOn(c, x, y_top - table_h)

    return y_top - table_h


def draw_payment(c: canvas.Canvas, y_top: float) -> float:
    """Bloque forma de pago"""
    box_h = 18 * mm
    box_w = 95 * mm
    x = MARGIN
    y = y_top - box_h

    c.setStrokeColor(GREY_BORDER)
    c.setFillColor(GREY_LIGHT)
    c.setLineWidth(0.5)
    c.rect(x, y, box_w, box_h, fill=1, stroke=1)

    c.setFillColor(GREEN_DARK)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x + 4 * mm, y + box_h - 5 * mm, "FORMA DE PAGO")

    c.setFillColor(GREY_DARK)
    c.setFont("Helvetica", 9)
    c.drawString(x + 4 * mm, y + box_h - 10 * mm, "Domiciliacion bancaria")
    c.drawString(x + 4 * mm, y + box_h - 14 * mm, "Cuenta: ES** **** **** **** **** 4521")

    return y


def draw_footer(c: canvas.Canvas):
    c.setStrokeColor(GREY_BORDER)
    c.setLineWidth(0.5)
    c.line(MARGIN, 22 * mm, PAGE_W - MARGIN, 22 * mm)

    c.setFillColor(GREY_MID)
    c.setFont("Helvetica", 7)
    c.drawString(MARGIN, 17 * mm, "Iberdrola Clientes S.A.U. - CIF A95758389 - Calle Tomas Redondo, 1, 28033 Madrid")
    c.drawString(MARGIN, 13 * mm, "Inscrita en el Registro Mercantil de Madrid")
    c.drawRightString(PAGE_W - MARGIN, 17 * mm, "Atencion al cliente: 900 22 45 22")
    c.drawRightString(PAGE_W - MARGIN, 13 * mm, "www.iberdrola.es")

    c.setFont("Helvetica-Oblique", 7)
    c.drawCentredString(PAGE_W / 2, 8 * mm, "Pagina 1 de 1")


def main():
    c = canvas.Canvas(OUTPUT, pagesize=A4)
    c.setTitle("Factura F-2026-04889")
    c.setAuthor("Iberdrola Clientes S.A.U.")

    draw_header(c)

    y = PAGE_H - 35 * mm
    y_meta = draw_invoice_meta(c, y)
    y_parties = draw_parties(c, y_meta - 4 * mm)
    y_supply = draw_supply_info(c, y_parties - 6 * mm)

    # Etiqueta de seccion
    c.setFillColor(GREEN_DARK)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(MARGIN, y_supply - 8 * mm, "DETALLE DE LA FACTURA")

    y_table = draw_concepts_table(c, y_supply - 12 * mm)
    y_totals = draw_totals(c, y_table - 6 * mm)
    draw_payment(c, y_totals - 4 * mm)

    draw_footer(c)
    c.showPage()
    c.save()
    print(f"PDF generado: {OUTPUT}")


if __name__ == "__main__":
    main()
