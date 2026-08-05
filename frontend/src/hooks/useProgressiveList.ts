import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_BATCH_SIZE = 72;

/**
 * Keeps large catalogues searchable in full while mounting only an initial
 * window of cards. More rows are appended as the sentinel approaches.
 */
export function useProgressiveList<T>(
  items: T[],
  resetKey: unknown,
  batchSize = DEFAULT_BATCH_SIZE,
) {
  const [visibleCount, setVisibleCount] = useState(batchSize);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(batchSize);
  }, [batchSize, resetKey]);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || visibleCount >= items.length) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) =>
            Math.min(items.length, current + batchSize),
          );
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [batchSize, items.length, visibleCount]);

  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  );
  const showMore = useCallback(
    () =>
      setVisibleCount((current) =>
        Math.min(items.length, current + batchSize),
      ),
    [batchSize, items.length],
  );
  const revealThrough = useCallback(
    (index: number) =>
      setVisibleCount((current) =>
        Math.max(current, Math.min(items.length, index + 1)),
      ),
    [items.length],
  );

  return {
    visibleItems,
    visibleCount,
    hasMore: visibleCount < items.length,
    sentinelRef,
    showMore,
    revealThrough,
  };
}
