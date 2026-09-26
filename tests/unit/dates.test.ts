import { describe, it, expect } from "vitest";
import { madridDayBounds, startOfDayInMadrid, startOfTodayInMadrid } from "@/lib/dates";

const HORA = 3600_000;

describe("startOfDayInMadrid", () => {
  it("en verano la medianoche de Madrid son las 22:00 UTC del dia anterior", () => {
    expect(startOfDayInMadrid(2026, 9, 25).toISOString()).toBe("2026-09-24T22:00:00.000Z");
  });

  it("en invierno son las 23:00 UTC del dia anterior", () => {
    expect(startOfDayInMadrid(2026, 1, 15).toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });
});

describe("startOfTodayInMadrid", () => {
  it("a las 00:30 de Madrid (22:30 UTC del dia antes) hoy ya es el dia nuevo", () => {
    expect(startOfTodayInMadrid(new Date("2026-09-25T22:30:00Z")).toISOString())
      .toBe("2026-09-25T22:00:00.000Z");
  });

  it("a las 23:30 de Madrid sigue siendo el mismo dia", () => {
    expect(startOfTodayInMadrid(new Date("2026-01-15T22:30:00Z")).toISOString())
      .toBe("2026-01-14T23:00:00.000Z");
  });
});

describe("madridDayBounds", () => {
  it("un dia de verano va de medianoche a medianoche de Madrid", () => {
    const bounds = madridDayBounds("2026-09-25");
    expect(bounds?.start.toISOString()).toBe("2026-09-24T22:00:00.000Z");
    expect(bounds?.end.toISOString()).toBe("2026-09-25T22:00:00.000Z");
  });

  it("un dia de invierno", () => {
    const bounds = madridDayBounds("2026-01-15");
    expect(bounds?.start.toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(bounds?.end.toISOString()).toBe("2026-01-15T23:00:00.000Z");
  });

  it("el dia que se adelanta la hora dura 23 horas", () => {
    const bounds = madridDayBounds("2026-03-29")!;
    expect(bounds.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(bounds.end.getTime() - bounds.start.getTime()).toBe(23 * HORA);
  });

  it("el dia que se atrasa la hora dura 25 horas", () => {
    const bounds = madridDayBounds("2026-10-25")!;
    expect(bounds.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(bounds.end.getTime() - bounds.start.getTime()).toBe(25 * HORA);
  });

  it("el 31 de diciembre termina en el 1 de enero del ano siguiente", () => {
    const bounds = madridDayBounds("2026-12-31");
    expect(bounds?.start.toISOString()).toBe("2026-12-30T23:00:00.000Z");
    expect(bounds?.end.toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });

  it("fin de mes pasa al dia 1 del siguiente", () => {
    expect(madridDayBounds("2026-02-28")?.end.toISOString()).toBe("2026-02-28T23:00:00.000Z");
  });

  it("los cambios de las 01:15 y las 00:30 de Madrid caen en su dia, no en el UTC", () => {
    const bounds = madridDayBounds("2026-09-25")!;
    const madrugada = new Date("2026-09-24T23:15:00Z"); // 25/09 01:15 en Madrid
    const diaSiguiente = new Date("2026-09-25T22:30:00Z"); // 26/09 00:30 en Madrid
    expect(madrugada >= bounds.start && madrugada < bounds.end).toBe(true);
    expect(diaSiguiente >= bounds.start && diaSiguiente < bounds.end).toBe(false);
  });

  it("lo que no es una fecha AAAA-MM-DD valida da null", () => {
    expect(madridDayBounds("")).toBeNull();
    expect(madridDayBounds("25/09/2026")).toBeNull();
    expect(madridDayBounds("2026-9-25")).toBeNull();
    expect(madridDayBounds("2026-02-30")).toBeNull();
    expect(madridDayBounds("2026-13-01")).toBeNull();
  });
});
