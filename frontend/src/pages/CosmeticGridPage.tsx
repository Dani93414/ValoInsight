import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { NamedContentItem } from "../types/content";
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

type CosmeticGridPageProps<T extends NamedContentItem> = {
  title: string;
  subtitle: string;
  query: UseQueryResult<T[], Error>;
  searchPlaceholder: string;
  searchLabel?: string;
  searchWrapperClassName?: string;
  toolbarClassName?: string;
  searchClassName?: string;
  gridClassName?: string;
  slotClassName?: string;
  detailSlotClassName?: string;
  cardClassName?: string;
  detailClassName?: string;
  getImage?: (item: T) => string | null | undefined;
  getMeta?: (item: T) => string | null | undefined;
  getSearchText?: (item: T) => string;
  sortItems?: (a: T, b: T) => number;
  extraFilter?: (item: T) => boolean;
  filterControls?: ReactNode;
  renderHero?: (state: { items: T[]; filtered: T[]; selected: T | null }) => ReactNode;
  filterHeading?: ReactNode | ((state: { items: T[]; filtered: T[]; selected: T | null }) => ReactNode);
  inlineDetail?: boolean;
  disableDetail?: boolean;
  renderDetail?: (item: T) => ReactNode;
};

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

export default function CosmeticGridPage<T extends NamedContentItem>({
  title,
  subtitle,
  query,
  searchPlaceholder,
  searchLabel,
  searchWrapperClassName,
  toolbarClassName,
  searchClassName,
  gridClassName,
  slotClassName,
  detailSlotClassName,
  cardClassName,
  detailClassName,
  getImage = (item) => item.displayIcon,
  getMeta,
  getSearchText = (item) => item.displayName,
  sortItems,
  extraFilter,
  filterControls,
  renderHero,
  filterHeading,
  inlineDetail = false,
  disableDetail = false,
  renderDetail,
}: CosmeticGridPageProps<T>) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<T | null>(null);
  const [gridColumns, setGridColumns] = useState(1);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const items = useMemo(
    () =>
      [...(query.data ?? [])].sort((a, b) =>
        sortItems ? sortItems(a, b) : a.displayName.localeCompare(b.displayName),
      ),
    [query.data, sortItems],
  );

  const filtered = useMemo(() => {
    const needle = normalizeText(search);
    return items.filter(
      (item) =>
        normalizeText(getSearchText(item)).includes(needle) &&
        (!extraFilter || extraFilter(item)),
    );
  }, [extraFilter, getSearchText, items, search]);
  const progressive = useProgressiveList(
    filtered,
    `${search}:${filtered.length}`,
  );
  const viewState = { items, filtered, selected };
  const canOpenDetail = !disableDetail;
  const selectedKey = canOpenDetail && selected ? selected.uuid ?? selected.displayName : null;
  const selectedIndex = selectedKey
    ? filtered.findIndex((item) => (item.uuid ?? item.displayName) === selectedKey)
    : -1;
  const detailInsertIndex =
    inlineDetail && selected && selectedIndex >= 0
      ? getInsertIndex(selectedIndex, gridColumns, filtered.length)
      : -1;

  useEffect(() => {
    if (!inlineDetail) return;

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
  }, [filtered.length, inlineDetail]);

  useEffect(() => {
    if (!inlineDetail || !selectedKey) return;
    window.requestAnimationFrame(() => scrollToElement(cardRefs.current.get(selectedKey) ?? null));
  }, [inlineDetail, selectedKey]);

  if (query.isLoading) {
    return <ContentLoading title={`Cargando ${title.toLowerCase()}`} />;
  }

  const detail = selected ? (
    <article className={`content-detail ${detailClassName ?? ""}`.trim()}>
      <button
        className="content-detail-close"
        type="button"
        aria-label="Cerrar detalle"
        onClick={() => setSelected(null)}
      >
        <span className="content-detail-close-icon" aria-hidden="true" />
      </button>
      {renderDetail ? (
        renderDetail(selected)
      ) : (
        <div className="content-detail-grid">
          <div>
            <h2 className="content-detail-title">
              {selected.displayName}
            </h2>
            {getMeta?.(selected) && (
              <div className="content-badge-row">
                <span className="content-badge">
                  {getMeta(selected)}
                </span>
              </div>
            )}
          </div>
          <div className="content-detail-media">
            {getImage(selected) && (
              <img
                className="content-detail-image"
                src={getImageDerivative(getImage(selected), "medium")}
                alt={selected.displayName}
                decoding="async"
                onError={(event) =>
                  fallbackToOriginalImage(event, getImage(selected) ?? "")
                }
              />
            )}
          </div>
        </div>
      )}
    </article>
  ) : null;

  const searchInput = (
    <ClearableSearchInput
      inputClassName={searchClassName ?? ""}
      placeholder={searchPlaceholder}
      value={search}
      onChange={(event) => {
        setSearch(event.target.value);
        if (inlineDetail) {
          setSelected(null);
        }
      }}
      onClear={() => {
        setSearch("");
        if (inlineDetail) {
          setSelected(null);
        }
      }}
    />
  );

  return (
    <ContentShell title={title} subtitle={subtitle}>
      {query.isError && (
        <ContentError
          message="No se pudo cargar esta categoria de cosmeticos."
          onRetry={() => query.refetch()}
        />
      )}

      {!query.isError && items.length === 0 && (
        <ContentEmpty message="No hay elementos disponibles en esta categoria." />
      )}

      {!query.isError && items.length > 0 && (
        <>
          {renderHero?.(viewState)}

          <div className={`content-toolbar ${toolbarClassName ?? ""}`.trim()}>
            {searchLabel ? (
              <label className={`content-select-label ${searchWrapperClassName ?? ""}`.trim()}>
                {searchLabel}
                {searchInput}
              </label>
            ) : (
              searchInput
            )}
            {typeof filterHeading === "function" ? filterHeading(viewState) : filterHeading}
            {filterControls}
          </div>

          {!inlineDetail && canOpenDetail && detail}

          {filtered.length === 0 ? (
            <ContentEmpty message="No hay resultados con ese filtro." />
          ) : (
            <>
              <div className={`content-grid ${gridClassName ?? ""}`.trim()} ref={gridRef}>
              {progressive.visibleItems.map((item, index) => {
                const itemKey = item.uuid ?? item.displayName;
                const active = canOpenDetail && selectedKey === itemKey;
                const image = getImage(item);
                const cardContent = (
                  <>
                    {image && (
                      <span className="content-card-image-wrap">
                        <img
                          className="content-card-image"
                          src={getImageDerivative(image, "thumb")}
                          alt={item.displayName}
                          loading="lazy"
                          decoding="async"
                          onError={(event) => fallbackToOriginalImage(event, image)}
                        />
                      </span>
                    )}
                    <h2 className="content-card-title">{item.displayName}</h2>
                    {getMeta?.(item) && (
                      <p className="content-card-meta">{getMeta(item)}</p>
                    )}
                  </>
                );
                const card = canOpenDetail ? (
                  <button
                    key={itemKey}
                    ref={(element) => {
                      if (element) cardRefs.current.set(itemKey, element);
                      else cardRefs.current.delete(itemKey);
                    }}
                    className={`content-card ${cardClassName ?? ""} ${active ? "active" : ""}`.trim()}
                    type="button"
                    onClick={() => setSelected(active ? null : item)}
                  >
                    {cardContent}
                  </button>
                ) : (
                  <article
                    key={itemKey}
                    className={`content-card content-card--static ${cardClassName ?? ""}`.trim()}
                  >
                    {cardContent}
                  </article>
                );

                if (!inlineDetail) {
                  return card;
                }

                return (
                  <div key={itemKey} className={slotClassName}>
                    {card}
                    {detail && detailInsertIndex === index + 1 && (
                      <div className={detailSlotClassName} ref={detailRef}>
                        {detail}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
              {progressive.hasMore && (
                <div ref={progressive.sentinelRef} className="content-load-more">
                  <button type="button" onClick={progressive.showMore}>
                    Mostrar más ({filtered.length - progressive.visibleCount})
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
