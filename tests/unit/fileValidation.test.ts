import { describe, it, expect } from "vitest";
import {
  detectFileKind,
  validateUploadedFile,
  canonicalMime,
} from "@/lib/fileValidation";

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

function padTo(b: Uint8Array, n: number): Uint8Array {
  if (b.length >= n) return b;
  const out = new Uint8Array(n);
  out.set(b);
  return out;
}

describe("detectFileKind", () => {
  it("detects PDF", () => {
    const pdf = padTo(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34), 16);
    expect(detectFileKind(pdf)).toBe("pdf");
  });

  it("detects JPEG", () => {
    const jpg = padTo(bytes(0xff, 0xd8, 0xff, 0xe0), 16);
    expect(detectFileKind(jpg)).toBe("jpeg");
  });

  it("detects PNG", () => {
    const png = padTo(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 16);
    expect(detectFileKind(png)).toBe("png");
  });

  it("detects WebP", () => {
    const webp = padTo(
      bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
      16,
    );
    expect(detectFileKind(webp)).toBe("webp");
  });

  it("detects HEIC", () => {
    const heic = padTo(
      bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63),
      16,
    );
    expect(detectFileKind(heic)).toBe("heic");
  });

  it("detects XML with BOM and declaration", () => {
    const xml = padTo(
      bytes(0xef, 0xbb, 0xbf, 0x3c, 0x3f, 0x78, 0x6d, 0x6c),
      16,
    );
    expect(detectFileKind(xml)).toBe("xml");
  });

  it("detects bare XML starting with <", () => {
    const xml = padTo(bytes(0x3c, 0x66, 0x65, 0x3a, 0x46, 0x61, 0x63), 16);
    expect(detectFileKind(xml)).toBe("xml");
  });

  it("returns null for too-short buffer", () => {
    expect(detectFileKind(bytes(0x25, 0x50))).toBeNull();
  });

  it("returns null for unknown signature", () => {
    const garbage = padTo(bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07), 16);
    expect(detectFileKind(garbage)).toBeNull();
  });

  it("returns null for text file", () => {
    const txt = padTo(bytes(0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64), 16);
    expect(detectFileKind(txt)).toBeNull();
  });
});

describe("validateUploadedFile", () => {
  const pdf = padTo(bytes(0x25, 0x50, 0x44, 0x46, 0x2d), 16);
  const jpg = padTo(bytes(0xff, 0xd8, 0xff, 0xe0), 16);

  it("accepts when content and extension match", () => {
    const r = validateUploadedFile({ buffer: pdf, filename: "factura.pdf" });
    expect(r).toEqual({ ok: true, kind: "pdf" });
  });

  it("rejects when extension does not match content", () => {
    const r = validateUploadedFile({ buffer: pdf, filename: "factura.jpg" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no coincide/i);
  });

  it("accepts jpg and jpeg extensions for JPEG", () => {
    expect(validateUploadedFile({ buffer: jpg, filename: "a.jpg" }).ok).toBe(true);
    expect(validateUploadedFile({ buffer: jpg, filename: "a.jpeg" }).ok).toBe(true);
  });

  it("rejects unknown content even with valid extension", () => {
    const garbage = padTo(bytes(0, 0, 0, 0, 0, 0, 0, 0), 16);
    const r = validateUploadedFile({ buffer: garbage, filename: "x.pdf" });
    expect(r.ok).toBe(false);
  });

  it("rejects filename whose extension does not match content", () => {
    const r = validateUploadedFile({ buffer: pdf, filename: "factura.docx" });
    expect(r.ok).toBe(false);
  });
});

describe("canonicalMime", () => {
  it("returns correct MIME types", () => {
    expect(canonicalMime("pdf")).toBe("application/pdf");
    expect(canonicalMime("jpeg")).toBe("image/jpeg");
    expect(canonicalMime("png")).toBe("image/png");
    expect(canonicalMime("webp")).toBe("image/webp");
    expect(canonicalMime("heic")).toBe("image/heic");
    expect(canonicalMime("xml")).toBe("application/xml");
  });
});
