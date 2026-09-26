import { describe, it, expect } from "vitest";
import { NoSuchKey, NotFound, S3ServiceException } from "@aws-sdk/client-s3";
import { isStorageNotFound } from "@/lib/storage";

describe("isStorageNotFound", () => {
  it("NoSuchKey de un GET es 'no existe'", () => {
    expect(isStorageNotFound(new NoSuchKey({ message: "no", $metadata: { httpStatusCode: 404 } }))).toBe(true);
  });

  it("NotFound de un HEAD (sin cuerpo) es 'no existe'", () => {
    expect(isStorageNotFound(new NotFound({ message: "no", $metadata: { httpStatusCode: 404 } }))).toBe(true);
  });

  it("un 404 solo en los metadatos también", () => {
    const err = new S3ServiceException({ name: "Unknown", $fault: "client", $metadata: { httpStatusCode: 404 } });
    expect(isStorageNotFound(err)).toBe(true);
  });

  it("un fallo del almacenamiento no se confunde con 'no existe'", () => {
    const err = new S3ServiceException({ name: "InternalError", $fault: "server", $metadata: { httpStatusCode: 500 } });
    expect(isStorageNotFound(err)).toBe(false);
    expect(isStorageNotFound(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isStorageNotFound(new DOMException("timeout", "TimeoutError"))).toBe(false);
    expect(isStorageNotFound(null)).toBe(false);
  });
});
