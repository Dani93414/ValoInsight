import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerCards, usePlayerTitles } from "../api/hooks";
import type { PlayerCardContent, PlayerTitleContent } from "../types/content";
import {
  ClearableSearchInput,
  ContentEmpty,
  ContentError,
  ContentLoading,
  ContentShell,
} from "./contentPageUtils";
import {
  fallbackToOriginalImage,
  getImageDerivative,
  normalizeText,
} from "./contentFormatters";
import { useProgressiveList } from "../hooks/useProgressiveList";
import "./ContentPages.css";

type ViewMode = "card" | "title";
type TitleEntry = PlayerTitleContent & { kind: "title" };
type CardEntry = PlayerCardContent & { kind: "card" };

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

function getCardPreview(item: PlayerCardContent) {
  return item.wideArt || item.displayIcon || item.smallArt || item.largeArt;
}

function CardAsset({
  label,
  src,
  alt,
  variant,
}: {
  label: string;
  src?: string | null;
  alt: string;
  variant: "icon" | "banner" | "large";
}) {
  return (
    <section className={`ctitles-card-asset ctitles-card-asset--${variant}`}>
      <span>{label}</span>
      <div className="ctitles-preview-box">
        {src ? (
          <img
            src={getImageDerivative(src, "medium")}
            alt={`${label} de ${alt}`}
            decoding="async"
            onError={(event) => fallbackToOriginalImage(event, src)}
          />
        ) : (
          <div className="ctitles-card-asset-empty">Sin imagen</div>
        )}
      </div>
    </section>
  );
}

export default function CosmeticosTitulosTarjetas() {
  const titlesQuery = usePlayerTitles();
  const cardsQuery = usePlayerCards();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [selectedCard, setSelectedCard] = useState<CardEntry | null>(null);
  const [gridColumns, setGridColumns] = useState(1);
  const cardGridRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const titles = useMemo<TitleEntry[]>(
    () =>
      [...(titlesQuery.data ?? [])]
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((item) => ({ ...item, kind: "title" })),
    [titlesQuery.data],
  );
  const cards = useMemo<CardEntry[]>(
    () =>
      [...(cardsQuery.data ?? [])]
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((item) => ({ ...item, kind: "card" })),
    [cardsQuery.data],
  );

  const filteredTitles = useMemo(() => {
    const needle = normalizeText(search);
    return titles.filter((item) =>
      normalizeText(`${item.displayName} ${item.titleText ?? ""}`).includes(needle),
    );
  }, [search, titles]);

  const filteredCards = useMemo(() => {
    const needle = normalizeText(search);
    return cards.filter((item) =>
      normalizeText(`${item.displayName} ${item.themeUuid ?? ""}`).includes(needle),
    );
  }, [cards, search]);
  const progressiveTitles = useProgressiveList(
    filteredTitles,
    `titles:${search}:${filteredTitles.length}`,
  );
  const progressiveCards = useProgressiveList(
    filteredCards,
    `cards:${search}:${filteredCards.length}`,
  );

  const activeItems = viewMode === "card" ? filteredCards : filteredTitles;
  const selectedCardKey = selectedCard ? selectedCard.uuid ?? selectedCard.displayName : null;
  const selectedCardIndex = selectedCardKey
    ? filteredCards.findIndex((item) => (item.uuid ?? item.displayName) === selectedCardKey)
    : -1;
  const detailInsertIndex =
    viewMode === "card" && selectedCard && selectedCardIndex >= 0
      ? getInsertIndex(selectedCardIndex, gridColumns, filteredCards.length)
      : -1;

  useEffect(() => {
    if (viewMode !== "card") return;

    const updateColumns = () => setGridColumns(getGridColumns(cardGridRef.current));
    updateColumns();

    const observer =
      typeof ResizeObserver === "undefined" || !cardGridRef.current
        ? null
        : new ResizeObserver(updateColumns);

    if (observer && cardGridRef.current) {
      observer.observe(cardGridRef.current);
    }

    window.addEventListener("resize", updateColumns);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateColumns);
    };
  }, [filteredCards.length, viewMode]);

  useEffect(() => {
    if (!selectedCardKey) return;
    window.requestAnimationFrame(() => scrollToElement(cardRefs.current.get(selectedCardKey) ?? null));
  }, [selectedCardKey]);

  const closeSelectedCard = (cardKey?: string) => {
    const targetKey = cardKey ?? selectedCardKey;
    setSelectedCard(null);
    window.requestAnimationFrame(() => {
      if (targetKey) {
        scrollToElement(cardRefs.current.get(targetKey) ?? null);
      }
    });
  };

  const selectCard = (item: CardEntry) => {
    const itemKey = item.uuid ?? item.displayName;
    if (selectedCardKey === itemKey) {
      closeSelectedCard(itemKey);
      return;
    }
    setSelectedCard(item);
  };

  const selectedDetail =
    selectedCard && viewMode === "card" ? (
      <article className="content-detail cskins-detail ctitles-card-detail">
        <button
          className="content-detail-close"
          type="button"
          aria-label="Cerrar detalle"
          onClick={() => closeSelectedCard()}
        >
          <span className="content-detail-close-icon" aria-hidden="true" />
        </button>
        <div>
          <h2 className="content-detail-title">{selectedCard.displayName}</h2>
          <div className="content-badge-row">
            <span className="content-badge">Tarjeta</span>
          </div>
        </div>
        <div className="ctitles-card-assets">
          <CardAsset
            label="Icono"
            src={selectedCard.smallArt}
            alt={selectedCard.displayName}
            variant="icon"
          />
          <CardAsset
            label="Banner"
            src={selectedCard.wideArt}
            alt={selectedCard.displayName}
            variant="banner"
          />
          <CardAsset
            label="Tarjeta"
            src={selectedCard.largeArt}
            alt={selectedCard.displayName}
            variant="large"
          />
        </div>
      </article>
    ) : null;

  if (titlesQuery.isLoading || cardsQuery.isLoading) {
    return <ContentLoading title="Cargando titulos y tarjetas" />;
  }

  return (
    <ContentShell
      title="Titulos y tarjetas"
      subtitle="Titulos de jugador y tarjetas de perfil."
    >
      {(titlesQuery.isError || cardsQuery.isError) && (
        <ContentError
          message="No se pudieron cargar titulos o tarjetas."
          onRetry={() => {
            titlesQuery.refetch();
            cardsQuery.refetch();
          }}
        />
      )}

      {!titlesQuery.isError && !cardsQuery.isError && (
        <>
          <div className="content-toolbar content-toolbar--catalog ctitles-toolbar">
            <ClearableSearchInput
              inputClassName="content-search--catalog"
              placeholder={viewMode === "card" ? "Buscar tarjeta..." : "Buscar titulo..."}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedCard(null);
              }}
              onClear={() => {
                setSearch("");
                setSelectedCard(null);
              }}
            />

            <span className="content-result-count">
              {activeItems.length}
            </span>

            <div className="ctitles-view-toggle" aria-label="Tipo de contenido">
              <button
                type="button"
                className={viewMode === "title" ? "active" : ""}
                onClick={() => {
                  setViewMode("title");
                  setSelectedCard(null);
                }}
              >
                Titulos
              </button>
              <button
                type="button"
                className={viewMode === "card" ? "active" : ""}
                onClick={() => {
                  setViewMode("card");
                  setSelectedCard(null);
                }}
              >
                Tarjetas
              </button>
            </div>
          </div>

          {titles.length + cards.length === 0 ? (
            <ContentEmpty message="No hay titulos ni tarjetas disponibles." />
          ) : activeItems.length === 0 ? (
            <ContentEmpty message="No hay resultados con esa busqueda." />
          ) : viewMode === "title" ? (
            <>
              <div className="content-grid ctitles-grid">
              {progressiveTitles.visibleItems.map((item) => (
                <article
                  key={item.uuid ?? item.displayName}
                  className="content-card content-card--static ctitles-title-card"
                >
                  <h2 className="content-card-title">{item.displayName}</h2>
                  <p className="content-card-meta">{item.titleText || "Titulo"}</p>
                </article>
              ))}
              </div>
              {progressiveTitles.hasMore && (
                <div ref={progressiveTitles.sentinelRef} className="content-load-more">
                  <button type="button" onClick={progressiveTitles.showMore}>
                    Mostrar más ({filteredTitles.length - progressiveTitles.visibleCount})
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="content-grid ctitles-grid" ref={cardGridRef}>
              {progressiveCards.visibleItems.map((item, index) => {
                const itemKey = item.uuid ?? item.displayName;
                const active = selectedCardKey === itemKey;
                const image = getCardPreview(item);
                return (
                  <div key={itemKey} className="ctitles-card-slot">
                    <button
                      ref={(element) => {
                        if (element) cardRefs.current.set(itemKey, element);
                        else cardRefs.current.delete(itemKey);
                      }}
                      className={`content-card ctitles-player-card ${active ? "active" : ""}`}
                      type="button"
                      onClick={() => selectCard(item)}
                    >
                      {image && (
                        <span className="content-card-image-wrap ctitles-card-image-wrap">
                          <img
                            className="content-card-image ctitles-card-image"
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
                      <p className="content-card-meta">Tarjeta</p>
                    </button>
                    {selectedDetail && detailInsertIndex === index + 1 && (
                      <div className="ctitles-detail-slot" ref={detailRef}>
                        {selectedDetail}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
              {progressiveCards.hasMore && (
                <div ref={progressiveCards.sentinelRef} className="content-load-more">
                  <button type="button" onClick={progressiveCards.showMore}>
                    Mostrar más ({filteredCards.length - progressiveCards.visibleCount})
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
