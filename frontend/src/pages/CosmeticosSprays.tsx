import { useEffect, useMemo, useRef, useState } from "react";
import { useSprays } from "../api/hooks";
import type { SprayContent } from "../types/content";
import {
  ClearableSearchInput,
  ContentEmpty,
  ContentError,
  ContentLoading,
  ContentShell,
} from "./contentPageUtils";
import { useProgressiveList } from "../hooks/useProgressiveList";
import {
  fallbackToOriginalImage,
  getImageDerivative,
  normalizeText,
} from "./contentFormatters";
import "./ContentPages.css";

type AnimationFilter = "all" | "animated" | "static";

function getTopbarOffset() {
  const topbar = document.querySelector(".app-topbar");
  if (!(topbar instanceof HTMLElement)) {
    return 96;
  }
  return Math.ceil(topbar.getBoundingClientRect().height + 20);
}

function scrollToElement(element: HTMLElement | null) {
  if (!element) return;
  const top = element.getBoundingClientRect().top + window.scrollY - getTopbarOffset();
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function getGridColumns(container: HTMLElement | null) {
  if (!container) return 1;
  const template = window.getComputedStyle(container).gridTemplateColumns;
  return Math.max(1, template.split(" ").filter(Boolean).length);
}

function getInsertIndex(selectedIndex: number, columns: number, total: number) {
  const rowEnd = selectedIndex + (columns - (selectedIndex % columns));
  return Math.min(rowEnd, total);
}

function getSprayPreview(item: SprayContent) {
  return item.displayIcon || item.fullTransparentIcon || item.fullIcon;
}

function getSprayDetailImage(item: SprayContent) {
  if (item.isAnimated && item.animationGif) return item.animationGif;
  if (item.isAnimated && item.uuid) return `/content/sprays/${item.uuid}/animationGif.gif`;
  return item.fullTransparentIcon || item.fullIcon || item.displayIcon;
}

export default function CosmeticosSprays() {
  const query = useSprays();
  const [search, setSearch] = useState("");
  const [animationFilter, setAnimationFilter] = useState<AnimationFilter>("all");
  const [selectedSpray, setSelectedSpray] = useState<SprayContent | null>(null);
  const [gridColumns, setGridColumns] = useState(1);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const sprays = useMemo(
    () =>
      [...(query.data ?? [])].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      ),
    [query.data],
  );

  const filteredSprays = useMemo(() => {
    const needle = normalizeText(search);
    return sprays.filter((item) => {
      const matchesSearch = normalizeText(
        `${item.displayName} ${item.themeUuid ?? ""}`,
      ).includes(needle);
      const matchesAnimation =
        animationFilter === "all" ||
        (animationFilter === "animated" && item.isAnimated) ||
        (animationFilter === "static" && !item.isAnimated);
      return matchesSearch && matchesAnimation;
    });
  }, [animationFilter, search, sprays]);
  const progressive = useProgressiveList(
    filteredSprays,
    `${search}:${animationFilter}:${filteredSprays.length}`,
  );

  const selectedKey = selectedSpray ? selectedSpray.uuid ?? selectedSpray.displayName : null;
  const selectedIndex = selectedKey
    ? filteredSprays.findIndex((item) => (item.uuid ?? item.displayName) === selectedKey)
    : -1;
  const detailInsertIndex =
    selectedSpray && selectedIndex >= 0
      ? getInsertIndex(selectedIndex, gridColumns, filteredSprays.length)
      : -1;

  useEffect(() => {
    const updateColumns = () => setGridColumns(getGridColumns(gridRef.current));
    updateColumns();

    const observer =
      typeof ResizeObserver === "undefined" || !gridRef.current
        ? null
        : new ResizeObserver(updateColumns);

    if (observer && gridRef.current) {
      observer.observe(gridRef.current);
    }

    window.addEventListener("resize", updateColumns);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateColumns);
    };
  }, [filteredSprays.length]);

  useEffect(() => {
    if (!selectedKey) return;
    window.requestAnimationFrame(() => scrollToElement(cardRefs.current.get(selectedKey) ?? null));
  }, [selectedKey]);

  const closeSelectedSpray = (sprayKey?: string) => {
    const targetKey = sprayKey ?? selectedKey;
    setSelectedSpray(null);
    window.requestAnimationFrame(() => {
      if (targetKey) {
        scrollToElement(cardRefs.current.get(targetKey) ?? null);
      }
    });
  };

  const selectSpray = (item: SprayContent) => {
    const itemKey = item.uuid ?? item.displayName;
    if (selectedKey === itemKey) {
      closeSelectedSpray(itemKey);
      return;
    }
    setSelectedSpray(item);
  };

  const selectedDetail = selectedSpray ? (
    <article className="content-detail cskins-detail csprays-detail">
      <button
        className="content-detail-close"
        type="button"
        aria-label="Cerrar detalle"
        onClick={() => closeSelectedSpray()}
      >
        <span className="content-detail-close-icon" aria-hidden="true" />
      </button>
      <div>
        <h2 className="content-detail-title">{selectedSpray.displayName}</h2>
        <div className="content-badge-row">
          <span className="content-badge">
            {selectedSpray.isAnimated ? "Animado" : "Estatico"}
          </span>
        </div>
      </div>
      <div className="csprays-detail-media">
        <section className="csprays-asset csprays-asset--icon">
          <span>Icono</span>
          <div className="csprays-preview-box">
            {selectedSpray.displayIcon ? (
              <img
                src={getImageDerivative(selectedSpray.displayIcon, "medium")}
                alt={`Icono de ${selectedSpray.displayName}`}
                decoding="async"
                onError={(event) =>
                  fallbackToOriginalImage(event, selectedSpray.displayIcon ?? "")
                }
              />
            ) : (
              <div className="csprays-empty">Sin icono</div>
            )}
          </div>
        </section>
        <section className="csprays-asset csprays-asset--spray">
          <span>Spray</span>
          <div className="csprays-preview-box">
            {getSprayDetailImage(selectedSpray) ? (
              <img
                src={getImageDerivative(getSprayDetailImage(selectedSpray), "medium")}
                alt={selectedSpray.displayName}
                decoding="async"
                onError={(event) =>
                  fallbackToOriginalImage(
                    event,
                    getSprayDetailImage(selectedSpray) ?? "",
                  )
                }
              />
            ) : (
              <div className="csprays-empty">Sin imagen</div>
            )}
          </div>
        </section>
      </div>
    </article>
  ) : null;

  if (query.isLoading) {
    return <ContentLoading title="Cargando sprays" />;
  }

  return (
    <ContentShell
      title="Sprays"
      subtitle="Sprays y variantes animadas del contenido disponible."
    >
      {query.isError && (
        <ContentError
          message="No se pudo cargar esta categoria de cosmeticos."
          onRetry={() => query.refetch()}
        />
      )}

      {!query.isError && sprays.length === 0 && (
        <ContentEmpty message="No hay sprays disponibles." />
      )}

      {!query.isError && sprays.length > 0 && (
        <>
          <div className="content-toolbar content-toolbar--catalog csprays-toolbar">
            <ClearableSearchInput
              inputClassName="content-search--catalog"
              placeholder="Buscar spray..."
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedSpray(null);
              }}
              onClear={() => {
                setSearch("");
                setSelectedSpray(null);
              }}
            />

            <span className="content-result-count">{filteredSprays.length}</span>

            <label className="content-select-label content-level-selector">
              Animacion
              <select
                className="content-select content-level-select"
                value={animationFilter}
                onChange={(event) => {
                  setAnimationFilter(event.target.value as AnimationFilter);
                  setSelectedSpray(null);
                }}
              >
                <option value="all">Todos</option>
                <option value="animated">Animados</option>
                <option value="static">Estaticos</option>
              </select>
            </label>
          </div>

          {filteredSprays.length === 0 ? (
            <ContentEmpty message="No hay resultados con esa busqueda." />
          ) : (
            <>
              <div className="content-grid csprays-grid" ref={gridRef}>
              {progressive.visibleItems.map((item, index) => {
                const itemKey = item.uuid ?? item.displayName;
                const active = selectedKey === itemKey;
                const image = getSprayPreview(item);
                return (
                  <div key={itemKey} className="csprays-slot">
                    <button
                      ref={(element) => {
                        if (element) cardRefs.current.set(itemKey, element);
                        else cardRefs.current.delete(itemKey);
                      }}
                      className={`content-card csprays-card ${active ? "active" : ""}`}
                      type="button"
                      onClick={() => selectSpray(item)}
                    >
                      {image && (
                        <span className="content-card-image-wrap csprays-card-image-wrap">
                          <img
                            className="content-card-image csprays-card-image"
                            src={getImageDerivative(image, "thumb")}
                            alt={item.displayName}
                            loading="lazy"
                            decoding="async"
                            onError={(event) =>
                              fallbackToOriginalImage(event, image)
                            }
                          />
                        </span>
                      )}
                      <h2 className="content-card-title">{item.displayName}</h2>
                    </button>
                    {selectedDetail && detailInsertIndex === index + 1 && (
                      <div className="csprays-detail-slot" ref={detailRef}>
                        {selectedDetail}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
              {progressive.hasMore && (
                <div ref={progressive.sentinelRef} className="content-load-more">
                  <button type="button" onClick={progressive.showMore}>
                    Mostrar más ({filteredSprays.length - progressive.visibleCount})
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </ContentShell>
  );
}
