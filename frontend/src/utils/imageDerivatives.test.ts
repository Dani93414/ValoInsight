import { describe, expect, it } from "vitest";
import { getImageDerivative } from "../pages/contentFormatters";

describe("getImageDerivative", () => {
  it("maps local raster content to the requested WebP variant", () => {
    expect(
      getImageDerivative("/content/sprays/example/displayIcon.png", "thumb"),
    ).toBe("/content/sprays/example/displayIcon.thumb.webp");
  });

  it("preserves query strings and already optimized variants", () => {
    expect(
      getImageDerivative("/content/cards/card.jpg?v=2", "medium"),
    ).toBe("/content/cards/card.medium.webp?v=2");
    expect(
      getImageDerivative("/content/cards/card.thumb.webp", "medium"),
    ).toBe("/content/cards/card.thumb.webp");
  });

  it("does not rewrite remote or unsupported assets", () => {
    expect(getImageDerivative("https://cdn.example/card.png", "thumb")).toBe(
      "https://cdn.example/card.png",
    );
    expect(getImageDerivative("/content/sprays/animated.gif", "thumb")).toBe(
      "/content/sprays/animated.gif",
    );
  });
});
