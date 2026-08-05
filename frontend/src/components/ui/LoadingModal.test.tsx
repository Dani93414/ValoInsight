import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoadingModal from "./LoadingModal";

describe("LoadingModal", () => {
  it("keeps the same accessible card and label in every placement", () => {
    for (const placement of ["section", "overlay"] as const) {
      const markup = renderToStaticMarkup(
        <LoadingModal placement={placement} />,
      );

      expect(markup).toContain(`loading-modal--${placement}`);
      expect(markup).toContain('aria-label="Cargando"');
      expect(markup).toContain(">Cargando</span>");
      expect(markup).toContain("loading-modal__mascot");
      expect(markup).toContain('src="/content/loader/Mosh_Image.png"');
    }
  });
});
