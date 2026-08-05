import { describe, expect, it } from "vitest";
import { calculateGlobalWeaponHeadshotPct, formatWeaponValue, getWeaponProfileTags } from "./weaponUtils";

describe("weaponUtils translations", () => {
  it.each([
    ["ROFIncrease", "Cadencia progresiva: aumenta al mantener el disparo."],
    ["ADS", "Mira: permite apuntar para mejorar el control y la precisión."],
    ["DualZoom", "Zoom doble: permite alternar entre dos aumentos de mira."],
    ["AirBurst", "Explosión aérea: detona en el aire o por tiempo."],
    ["Silenced", "Silenciador: reduce traza sonora y visual de disparo."],
    ["Shotgun", "Disparo de escopeta: lanza varios perdigones."],
  ])("translates %s", (source, expected) => {
    expect(formatWeaponValue(source)).toBe(expected);
  });

  it("uses Spanish wording for weapons with aim-down-sights data", () => {
    expect(getWeaponProfileTags({
      displayName: "Vandal",
      category: "Rifle",
      adsStats: { zoomMultiplier: 1.25 },
    })).toContain("tiene mira");
  });
});

describe("global weapon headshot percentage", () => {
  it("uses every filtered impact as the denominator", () => {
    expect(calculateGlobalWeaponHeadshotPct({
      headshots: 30,
      bodyshots: 50,
      legshots: 20,
    })).toBe(30);
  });

  it("does not invent a percentage for incomplete historical distributions", () => {
    expect(calculateGlobalWeaponHeadshotPct({ headshots: 12 })).toBeUndefined();
  });

  it("recovers the impact denominator from historical regional aggregates", () => {
    expect(calculateGlobalWeaponHeadshotPct({
      headshots: 111464,
      headshot_pct: 28.0468,
    })).toBeCloseTo(28.0468, 4);
  });
});
