import { describe, it, expect } from "vitest";
import { adminUploadClientsWhere } from "@/lib/uploadClients";

describe("adminUploadClientsWhere", () => {
  it("acota a la asesoría de la sesión y quita el buzón Sin clasificar", () => {
    expect(adminUploadClientsWhere("firm-a")).toEqual({
      advisoryFirmId: "firm-a",
      isUnclassifiedBucket: false,
    });
  });

  it.each([null, undefined, ""])(
    "sin asesoría (%j) no hay filtro abierto: lista vacía",
    (firmId) => {
      expect(adminUploadClientsWhere(firmId)).toBeNull();
    },
  );
});
