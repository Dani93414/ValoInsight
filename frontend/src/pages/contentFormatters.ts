import type { SyntheticEvent } from "react";

export function hideBrokenImage(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.display = "none";
}

export type ImageDerivative = "thumb" | "medium";

export function getImageDerivative(
  source: string | null | undefined,
  derivative: ImageDerivative,
) {
  if (!source || !source.startsWith("/content/")) return source ?? "";
  if (/\.(?:thumb|medium)\.webp(?:[?#].*)?$/i.test(source)) return source;
  return source.replace(
    /\.(?:png|jpe?g|webp|bmp|tiff?)(?=([?#].*)?$)/i,
    `.${derivative}.webp`,
  );
}

export function fallbackToOriginalImage(
  event: SyntheticEvent<HTMLImageElement>,
  originalSource: string,
) {
  const image = event.currentTarget;
  if (image.src !== new URL(originalSource, window.location.href).href) {
    image.src = originalSource;
    return;
  }
  hideBrokenImage(event);
}

export function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Si" : "No";
  if (Array.isArray(value)) return `${value.length} elementos`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function formatNumber(value?: number | null, digits = 0) {
  if (value === undefined || value === null || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function formatCompactNumber(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("es-ES", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(value?: number | null, digits = 1) {
  if (value === undefined || value === null || Number.isNaN(value)) return "-";
  return `${formatNumber(value, digits)}%`;
}

export function formatDate(value?: string | null) {
  if (!value || value === "-") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
