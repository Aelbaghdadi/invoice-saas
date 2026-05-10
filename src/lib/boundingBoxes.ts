export type BoundingBox = {
  page: number;   // 0-indexed (Document AI)
  x: number;      // normalized 0-1
  y: number;      // normalized 0-1
  width: number;  // normalized 0-1
  height: number; // normalized 0-1
};

export type FieldBoundingBoxes = Partial<Record<string, BoundingBox>>;

const ENTITY_TO_FIELD: Record<string, string> = {
  supplier_name:    "issuerName",
  supplier_tax_id:  "issuerCif",
  receiver_name:    "receiverName",
  receiver_tax_id:  "receiverCif",
  invoice_id:       "invoiceNumber",
  invoice_date:     "invoiceDate",
  net_amount:       "taxBase",
  vat_tax_amount:   "vatAmount",
  total_tax_amount: "vatAmount",
  total_amount:     "totalAmount",
};

export function extractBoundingBoxes(rawJson: string): FieldBoundingBoxes {
  try {
    const { entities } = JSON.parse(rawJson) as { entities: any[] };
    const result: FieldBoundingBoxes = {};

    for (const entity of entities ?? []) {
      const field = ENTITY_TO_FIELD[entity.type];
      if (!field || result[field]) continue;

      const pageRef = entity.pageAnchor?.pageRefs?.[0];
      if (!pageRef) continue;

      const verts: { x?: number; y?: number }[] =
        pageRef.boundingPoly?.normalizedVertices ?? [];
      if (verts.length < 2) continue;

      const xs = verts.map((v) => v.x ?? 0);
      const ys = verts.map((v) => v.y ?? 0);
      const x      = Math.min(...xs);
      const y      = Math.min(...ys);
      const width  = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;

      result[field] = { page: Number(pageRef.page ?? 0), x, y, width, height };
    }

    return result;
  } catch {
    return {};
  }
}
