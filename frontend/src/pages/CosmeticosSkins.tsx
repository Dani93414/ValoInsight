import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useArmas, useBundles, useContentTiers, useSkins, useThemes } from "../api/hooks";
import type {
  BundleContent,
  SkinChromaContent,
  SkinContent,
  SkinLevelContent,
  ThemeContent,
} from "../types/content";
import {
  getImageDerivative,
  hideBrokenImage,
  normalizeText,
  type ImageDerivative,
} from "./contentFormatters";
import {
  ClearableSearchInput,
  ContentEmpty,
  ContentError,
  ContentLoading,
  ContentShell,
} from "./contentPageUtils";
import { useProgressiveList } from "../hooks/useProgressiveList";
import "./ContentPages.css";

type OrganizationMode = "skins" | "collections" | "weapons";

type SkinGroup = {
  key: string;
  label: string;
  image?: string | null;
  source?: "bundle" | "theme" | "none";
  items: SkinContent[];
};

type ResolvedCollection = {
  uuid?: string | null;
  name: string;
  source: "bundle" | "theme" | "none";
  image?: string | null;
};

type SearchFolderSuggestion = {
  type: "collection" | "weapon";
  key: string;
  label: string;
  image?: string | null;
  count: number;
};

type SearchSkinSuggestion = {
  type: "skin";
  key: string;
  label: string;
  image?: string | null;
  meta: string;
};

type SearchSuggestion = SearchFolderSuggestion | SearchSkinSuggestion;

type WeaponLite = {
  uuid?: string | null;
  displayName?: string | null;
  displayIcon?: string | null;
};

const NO_COLLECTION_KEY = "none:Sin coleccion";

function uniqueImages(images: Array<string | null | undefined>) {
  return [...new Set(images.filter((image): image is string => Boolean(image)))];
}

function getBundleIcon(bundle?: BundleContent | null) {
  return bundle?.displayIcon || null;
}

function normalizeCollectionKey(value?: string | null) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function themeAssetToken(assetPath?: string | null) {
  const tail = (assetPath ?? "").split("/").pop() ?? "";
  return normalizeCollectionKey(
    tail.replace(/^Theme_/i, "").replace(/_PrimaryAsset$/i, ""),
  );
}

function bundleAssetToken(assetPath?: string | null) {
  const tail = (assetPath ?? "").split("/").pop() ?? "";
  return normalizeCollectionKey(
    tail
      .replace(/^StorefrontItem_/i, "")
      .replace(/_ThemeBundle_DataAsset$/i, "")
      .replace(/ThemeBundle_DataAsset$/i, ""),
  );
}

function getSkinKey(item: SkinContent) {
  return item.uuid ?? item.displayName;
}

function isExcludedSkin(item: SkinContent) {
  const name = normalizeText(item.displayName);
  return (
    name.includes("diseño favorito aleatorio")
    || name.includes("diseno favorito aleatorio")
    || name.includes("random favorite")
    || name.includes("estandar")
    || name.includes("standard")
  );
}

function getPrimarySkinImage(item: SkinContent) {
  return getSkinImageCandidates(item)[0] ?? null;
}

function getSkinImageCandidates(item: SkinContent) {
  const chromaImage = (item.chromas ?? []).find((chroma) =>
    Boolean(chroma.fullRender || chroma.displayIcon),
  );
  const levelImage = (item.levels ?? []).find((level) =>
    Boolean(level.displayIcon),
  );
  return uniqueImages([
    item.displayIcon ||
      null,
    chromaImage?.fullRender,
    chromaImage?.displayIcon,
    item.wallpaper,
    levelImage?.displayIcon,
  ]);
}

function getSkinPreviewImage(item: SkinContent) {
  return getSkinImageCandidates(item)[0] ?? null;
}

function getVariantImage(item?: SkinChromaContent | SkinLevelContent | null) {
  return item?.fullRender || item?.displayIcon || null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLevelLabel(level: SkinLevelContent) {
  const match = level.displayName.match(/\b(?:nivel|level)\s*(\d+)\b/i);
  return `Nivel ${match?.[1] ?? "1"}`;
}

function getChromaLabel(chroma: SkinChromaContent, skinName: string, index: number) {
  let text = chroma.displayName;
  text = text.replace(new RegExp(escapeRegExp(skinName), "i"), "");
  text = text.replace(/\b(?:chroma|croma|variante|variant)\b/gi, "");
  text = text.replace(/\bde\s+(?:nivel|level)\s*\d*\b/gi, "");
  text = text.replace(/\b(?:nivel|level)\s*\d*\b/gi, "");
  text = text.replace(/\b\d+\b/g, "");
  text = text.replace(/[()[\]]/g, " ");
  text = text.replace(/^[\s\-:|/]+|[\s\-:|/]+$/g, "").trim();

  const normalized = normalizeText(text);
  if (
    !normalized
    || normalized.includes("default")
    || normalized.includes("standard")
    || normalized.includes("estandar")
    || normalized.includes("predeterminado")
    || normalized.includes("base")
  ) {
    return "Por defecto";
  }

  if (index === 0 && normalizeText(chroma.displayName) === normalizeText(skinName)) {
    return "Por defecto";
  }

  return text
    .toLocaleLowerCase()
    .replace(/(^|\s)\S/g, (match) => match.toLocaleUpperCase());
}

function getLevelInfo(level: SkinLevelContent, skinName: string) {
  let text = level.displayName;
  text = text.replace(new RegExp(escapeRegExp(skinName), "i"), "");
  text = text.replace(/\b(?:nivel|level)\s*\d+\b/i, "");
  text = text.replace(/(?:^|[\s\-:|/])de(?:$|[\s\-:|/])/i, " ");
  text = text.replace(/^[\s\-:|/]+|[\s\-:|/]+$/g, "").trim();
  return text || null;
}

function formatLevelItem(value?: string | null) {
  const normalized = normalizeText(value ?? "");
  if (!normalized) return null;
  if (normalized.includes("transformation")) return "Transformacion";
  if (normalized.includes("finisher")) return "Remate";
  if (normalized.includes("animation")) return "Animacion";
  if (normalized.includes("vfx")) return "VFX";
  if (normalized.includes("sound") || normalized.includes("audio")) return "Sonido";
  if (normalized.includes("killbanner")) return "Banner de baja";
  if (normalized.includes("killcounter")) return "Contador de bajas";
  if (normalized.includes("kill")) return "Efecto de baja";
  if (normalized.includes("inspect")) return "Inspeccion";
  if (normalized.includes("reload")) return "Recarga";
  if (normalized.includes("equip")) return "Equipado";
  if (normalized.includes("voice")) return "Voz";
  return value
    ?.split("::")
    .pop()
    ?.replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    ?? null;
}

function getLevelVideoCandidates(level: SkinLevelContent) {
  return [level.streamedVideo];
}

function getLevelCards(levels: SkinLevelContent[], skin: SkinContent) {
  let previousLevelImage: string | null = null;
  return levels.map((level) => {
    const ownImage = getVariantImage(level);
    const image = ownImage || previousLevelImage;
    if (ownImage) previousLevelImage = ownImage;
    return {
      level,
      image,
      info: getLevelInfo(level, skin.displayName),
      item: formatLevelItem(level.levelItem),
      videos: getLevelVideoCandidates(level),
    };
  });
}

function FallbackImage({
  sources,
  alt,
  className,
  loading,
  derivative = "thumb",
}: {
  sources: Array<string | null | undefined>;
  alt: string;
  className?: string;
  loading?: "eager" | "lazy";
  derivative?: ImageDerivative;
}) {
  const sourcesKey = sources.filter(Boolean).join("|");
  const originalSources = uniqueImages(sources);
  const resolvedSources = uniqueImages(
    originalSources.flatMap((source) => [
      getImageDerivative(source, derivative),
      source,
    ]),
  );
  const [imageState, setImageState] = useState({ key: sourcesKey, index: 0 });
  const index = imageState.key === sourcesKey ? imageState.index : 0;

  const src = resolvedSources[index];
  if (!src) return null;

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      onError={(event) => {
        if (index < resolvedSources.length - 1) {
          setImageState({ key: sourcesKey, index: index + 1 });
          return;
        }
        hideBrokenImage(event);
      }}
    />
  );
}

function LevelVideoButton({
  sources,
  onPlay,
}: {
  sources: Array<string | null | undefined>;
  onPlay: (source: string) => void;
}) {
  const resolvedSources = uniqueImages(sources);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [playableSource, setPlayableSource] = useState<string | null>(null);
  const candidate = playableSource ? null : resolvedSources[candidateIndex];

  return (
    <>
      {playableSource && (
        <button
          className="cskins-video-button"
          type="button"
          onClick={() => onPlay(playableSource)}
        >
          Play
        </button>
      )}
      {candidate && (
        <video
          className="cskins-video-probe"
          src={candidate}
          preload="metadata"
          muted
          onLoadedMetadata={() => setPlayableSource(candidate)}
          onError={() => setCandidateIndex((index) => index + 1)}
        />
      )}
    </>
  );
}

function resolveCollectionName(item: SkinContent) {
  return item.collectionName || item.themeName || "Sin coleccion";
}

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

function getWeaponImageForSkin(item: SkinContent, weaponByUuid: Map<string, WeaponLite>) {
  if (!item.weaponUuid) return null;
  const fromApi = item.weaponImage || weaponByUuid.get(item.weaponUuid)?.displayIcon;
  return fromApi || `/content/weapons/${item.weaponUuid}/displayIcon.png`;
}

function SkinDetail({
  skin,
  tierLabel,
  themeIcon,
  onClose,
}: {
  skin: SkinContent;
  tierLabel: string;
  themeIcon?: string | null;
  onClose: () => void;
}) {
  const chromas = skin.chromas ?? [];
  const levels = skin.levels ?? [];
  const [showChromas, setShowChromas] = useState(false);
  const [showLevels, setShowLevels] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);

  const primaryImage = getPrimarySkinImage(skin);
  const wallpaperStyle = skin.wallpaper
    ? ({ "--cskins-wallpaper": `url("${skin.wallpaper}")` } as CSSProperties)
    : undefined;
  const levelCards = getLevelCards(levels, skin);

  return (
    <article
      className="content-detail skin-inline-detail cskins-detail"
      key={getSkinKey(skin)}
    >
      <button
        className="content-detail-close"
        type="button"
        aria-label="Cerrar detalle"
        onClick={onClose}
      >
        <span className="content-detail-close-icon" aria-hidden="true" />
      </button>
      <div className="content-detail-grid cskins-detail-grid">
        <div
          className={`cskins-detail-media ${skin.wallpaper ? "cskins-detail-media--wallpaper" : ""}`}
          style={wallpaperStyle}
        >
          {primaryImage ? (
            <FallbackImage
              className="cskins-detail-main-image"
              sources={getSkinImageCandidates(skin)}
              alt={skin.displayName}
              derivative="medium"
            />
          ) : (
            <div className="cskins-image-fallback">Sin imagen</div>
          )}
        </div>

        <div className="cskins-detail-summary">
          <h2 className="content-detail-title">{skin.displayName}</h2>
          <div className="content-badge-row">
            <span className="content-badge">{skin.weaponName || "Arma"}</span>
            <span className="content-badge">{resolveCollectionName(skin)}</span>
            <span className="content-badge">{tierLabel}</span>
          </div>

          {themeIcon && (
            <section className="cskins-theme-kill-icon">
              <span>Icono de baja</span>
              <FallbackImage
                sources={[themeIcon]}
                alt={`Icono de baja de ${resolveCollectionName(skin)}`}
                loading="lazy"
              />
            </section>
          )}
        </div>
      </div>

      <div className="cskins-detail-accordions">
        {chromas.length > 1 && (
          <section className={`cskins-accordion ${showChromas ? "is-open" : ""}`}>
            <button type="button" className="cskins-accordion-toggle" onClick={() => setShowChromas((v) => !v)} aria-expanded={showChromas}>
              <span>Chromas</span>
              <strong>{chromas.length}</strong>
              <i className={`cskins-toggle-indicator ${showChromas ? "is-open" : ""}`} />
            </button>
            {showChromas && (
              <div className="cskins-accordion-panel">
                  <div className="cskins-variant-grid">
                    {chromas.map((chroma, index) => {
                      const image = getVariantImage(chroma) || chroma.swatch;
                      const previewSource = uniqueImages([
                        chroma.fullRender,
                        chroma.displayIcon,
                        chroma.swatch,
                      ])[0];
                      return (
                        <button
                          className="cskins-variant-card cskins-chroma-card"
                          key={chroma.uuid ?? chroma.displayName}
                          type="button"
                          onClick={() => {
                            if (previewSource) {
                              setPreviewImage({ src: previewSource, alt: chroma.displayName });
                            }
                          }}
                          disabled={!previewSource}
                        >
                          {image && (
                            <FallbackImage
                              sources={[chroma.fullRender, chroma.displayIcon, chroma.swatch]}
                              alt={chroma.displayName}
                              loading="lazy"
                            />
                          )}
                          <h4>{getChromaLabel(chroma, skin.displayName, index)}</h4>
                        </button>
                      );
                    })}
                  </div>
              </div>
            )}
          </section>
        )}

        {levels.length > 1 && (
          <section className={`cskins-accordion ${showLevels ? "is-open" : ""}`}>
            <button type="button" className="cskins-accordion-toggle" onClick={() => setShowLevels((v) => !v)} aria-expanded={showLevels}>
              <span>Levels</span>
              <strong>{levels.length}</strong>
              <i className={`cskins-toggle-indicator ${showLevels ? "is-open" : ""}`} />
            </button>
            {showLevels && (
              <div className="cskins-accordion-panel">
                  <div className="cskins-variant-grid">
                    {levelCards.map(({ level, image, info, item, videos }) => {
                      const hasVideo = videos.some(Boolean);
                      return (
                        <article
                          className={`cskins-variant-card cskins-level-card ${hasVideo ? "cskins-level-card--has-video" : ""}`}
                          key={level.uuid ?? level.displayName}
                        >
                          {image && (
                            <FallbackImage
                              sources={[image]}
                              alt={level.displayName}
                              loading="lazy"
                            />
                          )}
                          <h4>{getLevelLabel(level)}</h4>
                          <div className="cskins-level-meta-copy">
                            {item && <p>{item}</p>}
                            {info && <small>Informacion: {info}</small>}
                          </div>
                          <LevelVideoButton sources={videos} onPlay={setVideoUrl} />
                        </article>
                      );
                    })}
                  </div>
              </div>
            )}
          </section>
        )}
      </div>

      {videoUrl && (
        <div className="cskins-video-modal" role="dialog" aria-modal="true">
          <button
            className="content-detail-close"
            type="button"
            aria-label="Cerrar video"
            onClick={() => setVideoUrl(null)}
          >
            <span className="content-detail-close-icon" aria-hidden="true" />
          </button>
          <video src={videoUrl} controls autoPlay />
        </div>
      )}
      {previewImage && (
        <div className="cskins-image-modal" role="dialog" aria-modal="true">
          <button
            className="content-detail-close"
            type="button"
            aria-label="Cerrar imagen"
            onClick={() => setPreviewImage(null)}
          >
            <span className="content-detail-close-icon" aria-hidden="true" />
          </button>
          <img src={previewImage.src} alt={previewImage.alt} />
        </div>
      )}
    </article>
  );
}

export default function CosmeticosSkins() {
  const skinsQuery = useSkins();
  const tiersQuery = useContentTiers();
  const armasQuery = useArmas();
  const bundlesQuery = useBundles();
  const themesQuery = useThemes();

  const [mode, setMode] = useState<OrganizationMode>("collections");
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [searchMenuOpen, setSearchMenuOpen] = useState(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [selectedSkinKey, setSelectedSkinKey] = useState<string | null>(null);
  const [groupGridColumns, setGroupGridColumns] = useState(1);
  const [groupSkinGridColumns, setGroupSkinGridColumns] = useState(1);
  const [allSkinGridColumns, setAllSkinGridColumns] = useState(1);
  const groupGridRef = useRef<HTMLDivElement | null>(null);
  const groupSkinGridRef = useRef<HTMLDivElement | null>(null);
  const allSkinGridRef = useRef<HTMLDivElement | null>(null);
  const inlineGroupRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const groupCardRefs = useRef(new Map<string, HTMLButtonElement>());
  const skinCardRefs = useRef(new Map<string, HTMLButtonElement>());

  const skins = useMemo(
    () => [...(skinsQuery.data ?? [])]
      .filter((skin) => !isExcludedSkin(skin))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [skinsQuery.data],
  );

  const tierNames = useMemo(() => {
    const map = new Map<string, string>();
    (tiersQuery.data ?? []).forEach((tier) => {
      if (tier.uuid) map.set(tier.uuid, tier.displayName);
    });
    return map;
  }, [tiersQuery.data]);

  const weaponByUuid = useMemo(() => {
    const map = new Map<string, WeaponLite>();
    ((armasQuery.data ?? []) as WeaponLite[]).forEach((weapon) => {
      if (weapon.uuid) map.set(weapon.uuid, weapon);
    });
    return map;
  }, [armasQuery.data]);

  const themeByUuid = useMemo(() => {
    const map = new Map<string, ThemeContent>();
    (themesQuery.data ?? []).forEach((theme) => {
      if (theme.uuid) map.set(theme.uuid, theme);
    });
    return map;
  }, [themesQuery.data]);

  const bundleIndexes = useMemo(() => {
    const byUuid = new Map<string, BundleContent>();
    const byThemeToken = new Map<string, BundleContent>();
    const byName = new Map<string, BundleContent[]>();
    const lastDisplayIconByName = new Map<string, string>();

    (bundlesQuery.data ?? []).forEach((bundle) => {
      if (bundle.uuid) byUuid.set(bundle.uuid, bundle);

      const nameKey = normalizeCollectionKey(bundle.displayName);
      const displayIcon = getBundleIcon(bundle);
      const token = bundleAssetToken(bundle.assetPath);
      if (nameKey && token) {
        byThemeToken.set(`${nameKey}:${token}`, bundle);
      }
      if (nameKey) {
        byName.set(nameKey, [...(byName.get(nameKey) ?? []), bundle]);
        if (displayIcon) {
          lastDisplayIconByName.set(nameKey, displayIcon);
        }
      }
    });

    return { byUuid, byThemeToken, byName, lastDisplayIconByName };
  }, [bundlesQuery.data]);

  const resolveCollection = useMemo(() => {
    return (skin: SkinContent): ResolvedCollection => {
      if (skin.collectionSource === "bundle" && skin.collectionUuid) {
        const bundle = bundleIndexes.byUuid.get(skin.collectionUuid);
        return {
          uuid: skin.collectionUuid,
          name: bundle?.displayName || skin.collectionName || skin.themeName || "Sin coleccion",
          source: "bundle",
          image: getBundleIcon(bundle),
        };
      }

      const theme = skin.themeUuid ? themeByUuid.get(skin.themeUuid) : null;
      const themeName = theme?.displayName || skin.themeName || skin.collectionName;
      const nameKey = normalizeCollectionKey(themeName);
      const token = themeAssetToken(theme?.assetPath);
      const bundle =
        nameKey && token
          ? bundleIndexes.byThemeToken.get(`${nameKey}:${token}`)
          : null;
      const uniqueNameBundle =
        !bundle && nameKey && (bundleIndexes.byName.get(nameKey)?.length ?? 0) === 1
          ? bundleIndexes.byName.get(nameKey)?.[0]
          : null;
      const matchedBundle = bundle || uniqueNameBundle || null;

      if (matchedBundle?.uuid) {
        return {
          uuid: matchedBundle.uuid,
          name: matchedBundle.displayName,
          source: "bundle",
          image: getBundleIcon(matchedBundle),
        };
      }

      if (skin.collectionSource === "theme" || themeName || skin.themeUuid) {
        return {
          uuid: skin.themeUuid || skin.collectionUuid,
          name: themeName || "Sin coleccion",
          source: "theme",
          image: getSkinPreviewImage(skin),
        };
      }

      return {
        uuid: null,
        name: "Sin coleccion",
        source: "none",
        image: getSkinPreviewImage(skin),
      };
    };
  }, [bundleIndexes, themeByUuid]);

  const filteredSkins = useMemo(() => {
    const needle = normalizeText(search);
    return skins.filter((skin) => {
      if (tierFilter !== "all" && skin.contentTierUuid !== tierFilter) {
        return false;
      }

      const tier = skin.contentTierUuid ? tierNames.get(skin.contentTierUuid) : "";
      const collection = resolveCollection(skin).name;
      const text = `${skin.displayName} ${skin.weaponName ?? ""} ${collection} ${tier ?? ""}`;
      return normalizeText(text).includes(needle);
    });
  }, [resolveCollection, search, skins, tierFilter, tierNames]);

  const groups = useMemo(() => {
    if (mode === "skins") {
      return [{ key: "all-skins", label: "Skins", items: filteredSkins }] as SkinGroup[];
    }

    if (mode === "collections") {
      const map = new Map<string, SkinGroup>();
      filteredSkins.forEach((skin) => {
        const collection = resolveCollection(skin);
        const groupSource = collection.source;
        const label = collection.name || "Sin coleccion";
        const labelKey = normalizeCollectionKey(label);
        const latestBundleIcon = bundleIndexes.lastDisplayIconByName.get(labelKey);

        const groupKey =
          groupSource === "none" && label === "Sin coleccion"
            ? NO_COLLECTION_KEY
            : `collection:${labelKey || label}`;
        const collectionImage =
          groupSource === "bundle" || latestBundleIcon
            ? latestBundleIcon
              ?? collection.image
              ?? skin.collectionPromoImage
              ?? getSkinPreviewImage(skin)
            : collection.image ?? getSkinPreviewImage(skin);

        const current = map.get(groupKey);
        if (current) {
          current.items.push(skin);
          if (latestBundleIcon || (!current.image && collectionImage)) {
            current.image = collectionImage;
          }
          if (current.source !== "bundle" && groupSource === "bundle") {
            current.source = "bundle";
          }
          return;
        }

        map.set(groupKey, {
          key: groupKey,
          label,
          image: collectionImage,
          source: groupSource,
          items: [skin],
        });
      });

      return [...map.values()]
        .sort((a, b) => {
          if (a.key === NO_COLLECTION_KEY) return 1;
          if (b.key === NO_COLLECTION_KEY) return -1;
          return a.label.localeCompare(b.label);
        });
    }

    const map = new Map<string, SkinGroup>();
    filteredSkins.forEach((skin) => {
      const weapon = (skin.weaponUuid && weaponByUuid.get(skin.weaponUuid)) || null;
      const label = weapon?.displayName || skin.weaponName || "Sin arma";
      const key = `weapon:${skin.weaponUuid ?? label}`;
      const current = map.get(key);
      if (current) {
        current.items.push(skin);
        return;
      }
      map.set(key, {
        key,
        label,
        image: weapon?.displayIcon || getWeaponImageForSkin(skin, weaponByUuid),
        items: [skin],
      });
    });

    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [bundleIndexes, filteredSkins, mode, resolveCollection, weaponByUuid]);

  const searchSuggestions = useMemo(() => {
    const needle = normalizeText(search);
    if (!needle) return [] as SearchSuggestion[];

    const collectionMap = new Map<string, SearchFolderSuggestion>();
    const weaponMap = new Map<string, SearchFolderSuggestion>();
    const skinMatches: SearchSkinSuggestion[] = [];

    skins.forEach((skin) => {
      const collection = resolveCollection(skin);
      const collectionLabel = collection.name || "Sin coleccion";
      const collectionKey =
        collection.source === "none" && collectionLabel === "Sin coleccion"
          ? NO_COLLECTION_KEY
          : `collection:${normalizeCollectionKey(collectionLabel) || collectionLabel}`;
      const collectionMatch = normalizeText(collectionLabel).includes(needle);
      const collectionImage =
        bundleIndexes.lastDisplayIconByName.get(normalizeCollectionKey(collectionLabel))
          ?? collection.image
          ?? skin.collectionPromoImage
          ?? getSkinPreviewImage(skin);

      if (collectionMatch) {
        const current = collectionMap.get(collectionKey);
        if (current) {
          current.count += 1;
          if (!current.image && collectionImage) current.image = collectionImage;
        } else {
          collectionMap.set(collectionKey, {
            type: "collection",
            key: collectionKey,
            label: collectionLabel,
            image: collectionImage,
            count: 1,
          });
        }
      }

      const weapon = (skin.weaponUuid && weaponByUuid.get(skin.weaponUuid)) || null;
      const weaponLabel = weapon?.displayName || skin.weaponName || "Sin arma";
      const weaponKey = `weapon:${skin.weaponUuid ?? weaponLabel}`;
      const weaponMatch = normalizeText(weaponLabel).includes(needle);
      const weaponImage = weapon?.displayIcon || getWeaponImageForSkin(skin, weaponByUuid);

      if (weaponMatch) {
        const current = weaponMap.get(weaponKey);
        if (current) {
          current.count += 1;
          if (!current.image && weaponImage) current.image = weaponImage;
        } else {
          weaponMap.set(weaponKey, {
            type: "weapon",
            key: weaponKey,
            label: weaponLabel,
            image: weaponImage,
            count: 1,
          });
        }
      }

      const tier = skin.contentTierUuid ? tierNames.get(skin.contentTierUuid) : "";
      const skinText = `${skin.displayName} ${skin.weaponName ?? ""} ${collectionLabel} ${tier ?? ""}`;
      if (normalizeText(skinText).includes(needle)) {
        skinMatches.push({
          type: "skin",
          key: getSkinKey(skin),
          label: skin.displayName,
          image: getSkinPreviewImage(skin),
          meta: `${skin.weaponName || "Arma"} - ${collectionLabel}${tier ? ` - ${tier}` : ""}`,
        });
      }
    });

    return [
      ...collectionMap.values(),
      ...weaponMap.values(),
      ...skinMatches.slice(0, 20),
    ].slice(0, 32);
  }, [bundleIndexes, resolveCollection, search, skins, tierNames, weaponByUuid]);

  const effectiveSelectedGroupKey = selectedGroupKey;
  const selectedGroup = groups.find((group) => group.key === effectiveSelectedGroupKey) ?? null;
  const selectedItems = mode === "skins" ? filteredSkins : selectedGroup?.items ?? [];
  const progressiveSkins = useProgressiveList(
    selectedItems,
    `${mode}:${search}:${tierFilter}:${selectedItems.length}`,
  );
  const selectedSkin =
    selectedSkinKey
      ? filteredSkins.find((skin) => getSkinKey(skin) === selectedSkinKey) ?? null
      : null;
  const selectedSkinTierLabel =
    selectedSkin?.contentTierUuid && tierNames.get(selectedSkin.contentTierUuid)
      ? tierNames.get(selectedSkin.contentTierUuid)!
      : "Sin rareza";
  const selectedSkinThemeUuid =
    selectedSkin?.themeUuid
      || (selectedSkin?.collectionSource === "theme" ? selectedSkin.collectionUuid : null);
  const selectedSkinThemeIcon =
    selectedSkinThemeUuid
      ? themeByUuid.get(selectedSkinThemeUuid)?.displayIcon
      : null;
  const selectedGroupIndex = groups.findIndex((group) => group.key === selectedGroupKey);
  const groupPanelInsertIndex =
    selectedGroup && selectedGroupIndex >= 0
      ? getInsertIndex(selectedGroupIndex, groupGridColumns, groups.length)
      : -1;
  const selectedGroupSkinIndex = selectedGroup
    ? selectedGroup.items.findIndex((skin) => getSkinKey(skin) === selectedSkinKey)
    : -1;
  const groupSkinDetailInsertIndex =
    selectedGroup && selectedGroupSkinIndex >= 0
      ? getInsertIndex(selectedGroupSkinIndex, groupSkinGridColumns, selectedGroup.items.length)
      : -1;
  const allSkinIndex = mode === "skins"
    ? selectedItems.findIndex((skin) => getSkinKey(skin) === selectedSkinKey)
    : -1;
  const allSkinDetailInsertIndex =
    allSkinIndex >= 0 ? getInsertIndex(allSkinIndex, allSkinGridColumns, selectedItems.length) : -1;

  useEffect(() => {
    if (mode === "skins" && allSkinIndex >= 0) {
      progressiveSkins.revealThrough(allSkinIndex);
    }
  }, [allSkinIndex, mode, progressiveSkins.revealThrough]);

  const setGroupCardRef = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) groupCardRefs.current.set(key, element);
    else groupCardRefs.current.delete(key);
  };

  const setSkinCardRef = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) skinCardRefs.current.set(key, element);
    else skinCardRefs.current.delete(key);
  };

  const closeGroupPanel = () => {
    const target = selectedGroupKey ? groupCardRefs.current.get(selectedGroupKey) ?? null : null;
    setSelectedGroupKey(null);
    setSelectedSkinKey(null);
    window.requestAnimationFrame(() => scrollToElement(target));
  };

  const closeSkinDetail = () => {
    const target = selectedSkinKey ? skinCardRefs.current.get(selectedSkinKey) ?? null : null;
    setSelectedSkinKey(null);
    window.requestAnimationFrame(() => scrollToElement(target));
  };

  const selectSkin = (key: string) => {
    if (selectedSkinKey === key) {
      closeSkinDetail();
      return;
    }
    setSelectedSkinKey(key);
  };

  const selectSearchSuggestion = (suggestion: SearchSuggestion) => {
    setSearchMenuOpen(false);

    if (suggestion.type === "collection") {
      setMode("collections");
      setSelectedGroupKey(suggestion.key);
      setSelectedSkinKey(null);
      return;
    }

    if (suggestion.type === "weapon") {
      setMode("weapons");
      setSelectedGroupKey(suggestion.key);
      setSelectedSkinKey(null);
      return;
    }

    setMode("skins");
    setSelectedGroupKey(null);
    setSelectedSkinKey(suggestion.key);
  };

  useLayoutEffect(() => {
    const measurements: Array<[HTMLDivElement | null, (columns: number) => void]> = [
      [groupGridRef.current, setGroupGridColumns],
      [groupSkinGridRef.current, setGroupSkinGridColumns],
      [allSkinGridRef.current, setAllSkinGridColumns],
    ];

    const updateColumns = () => {
      measurements.forEach(([element, setter]) => setter(getGridColumns(element)));
    };

    updateColumns();

    const observers =
      typeof ResizeObserver === "undefined"
        ? []
        : measurements
            .map(([element]) => {
              if (!element) return null;
              const observer = new ResizeObserver(updateColumns);
              observer.observe(element);
              return observer;
            })
            .filter((observer): observer is ResizeObserver => Boolean(observer));

    window.addEventListener("resize", updateColumns);
    return () => {
      observers.forEach((observer) => observer.disconnect());
      window.removeEventListener("resize", updateColumns);
    };
  }, [groups.length, mode, selectedGroupKey, selectedItems.length]);

  useEffect(() => {
    if (!selectedGroupKey) return;
    window.requestAnimationFrame(() => scrollToElement(groupCardRefs.current.get(selectedGroupKey) ?? null));
  }, [selectedGroupKey]);

  useEffect(() => {
    if (!selectedSkinKey) return;
    window.requestAnimationFrame(() => scrollToElement(skinCardRefs.current.get(selectedSkinKey) ?? null));
  }, [selectedSkinKey]);

  if (skinsQuery.isLoading) return <ContentLoading title="Cargando skins" />;

  return (
    <ContentShell title="Skins" subtitle="Catalogo moderno de skins con organizacion por skin, coleccion o arma.">
      {skinsQuery.isError && (
        <ContentError message="No se pudo cargar esta categoria de cosmeticos." onRetry={() => skinsQuery.refetch()} />
      )}

      {!skinsQuery.isError && skins.length === 0 && <ContentEmpty message="No hay skins disponibles." />}

      {!skinsQuery.isError && skins.length > 0 && (
        <>
          <div className="content-toolbar content-toolbar--skins">
            <label className="content-select-label content-select-label--premium content-filter-field--search">
              Buscar
              <ClearableSearchInput
                inputClassName="content-search--premium"
                placeholder="Buscar skins, colecciones o armas"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSearchMenuOpen(true);
                  setSelectedGroupKey(null);
                  setSelectedSkinKey(null);
                }}
                onClear={() => {
                  setSearch("");
                  setSearchMenuOpen(false);
                  setSelectedGroupKey(null);
                  setSelectedSkinKey(null);
                }}
                onFocus={() => setSearchMenuOpen(true)}
                onBlur={() => window.setTimeout(() => setSearchMenuOpen(false), 120)}
              />
              {searchMenuOpen && searchSuggestions.length > 0 && (
                <div className="cskins-search-menu" role="listbox">
                  {searchSuggestions.map((suggestion) => (
                    <button
                      key={`${suggestion.type}:${suggestion.key}`}
                      type="button"
                      className="cskins-search-option"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectSearchSuggestion(suggestion)}
                    >
                      <span className="cskins-search-option-thumb">
                        {suggestion.type === "skin" && suggestion.image ? (
                          <FallbackImage
                            sources={[suggestion.image]}
                            alt={suggestion.label}
                            loading="lazy"
                          />
                        ) : suggestion.type === "skin" ? (
                          <span>SK</span>
                        ) : (
                          <span className="cskins-search-folder-icon" aria-hidden="true" />
                        )}
                      </span>
                      <span className="cskins-search-option-copy">
                        <strong>{suggestion.label}</strong>
                        <small>
                          {suggestion.type === "skin"
                            ? suggestion.meta
                            : `${suggestion.count} skins`}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </label>

            <div className="content-inline-controls content-inline-controls--premium">
              <label className="content-select-label content-select-label--premium">
                Agrupar
                <select
                  className="content-select content-select--premium"
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value as OrganizationMode);
                    setSelectedGroupKey(null);
                    setSelectedSkinKey(null);
                  }}
                >
                  <option value="collections">Por coleccion</option>
                  <option value="weapons">Por arma</option>
                  <option value="skins">Todas</option>
                </select>
              </label>

              <label className="content-select-label content-select-label--premium">
                Edicion
                <select
                  className="content-select content-select--premium"
                  value={tierFilter}
                  onChange={(event) => {
                    setTierFilter(event.target.value);
                    setSelectedGroupKey(null);
                    setSelectedSkinKey(null);
                  }}
                >
                  <option value="all">Todas</option>
                  {[...tierNames.entries()]
                    .sort((a, b) => a[1].localeCompare(b[1]))
                    .map(([uuid, name]) => (
                      <option key={uuid} value={uuid}>
                        {name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </div>

          {groups.length === 0 && <ContentEmpty message="No hay resultados con ese filtro." />}

          {groups.length > 0 && mode !== "skins" && (
            <section className="content-section cskins-content-section">
              <h2 className="content-section-title">{mode === "collections" ? "Colecciones" : "Armas"}</h2>
              <div className="content-grid cskins-group-grid" ref={groupGridRef}>
                {groups.map((group, index) => {
                  const isOpen = effectiveSelectedGroupKey === group.key;
                  const firstSkin = group.items[0];
                  const groupImageSources = firstSkin
                    ? [
                        group.image,
                        getSkinPreviewImage(firstSkin),
                      ]
                    : [group.image];
                  return (
                    <div key={group.key} className="cskins-group-slot">
                      <button
                        ref={setGroupCardRef(group.key)}
                        type="button"
                        className={`content-card cskins-group-card cskins-group-card--${mode === "weapons" ? "weapon" : group.source ?? "none"} ${isOpen ? "active" : ""}`}
                        onClick={() => {
                          if (isOpen) {
                            closeGroupPanel();
                            return;
                          }
                          setSelectedGroupKey(group.key);
                          setSelectedSkinKey(null);
                        }}
                      >
                        <span className={`content-card-image-wrap cskins-group-image-wrap ${mode === "weapons" ? "cskins-group-image-wrap--weapon" : ""}`}>
                          {groupImageSources.some(Boolean) ? (
                            <FallbackImage
                              className={`content-card-image cskins-group-image ${mode === "weapons" ? "cskins-group-image--weapon" : ""}`}
                              sources={groupImageSources}
                              alt={group.label}
                              loading="lazy"
                            />
                          ) : (
                            <span className="cskins-image-fallback">{group.label.slice(0, 2).toUpperCase()}</span>
                          )}
                        </span>
                        <h3 className="content-card-title">{group.label}</h3>
                        <p className="content-card-meta">
                          <span>{group.items.length} skins</span>
                          <i className={`cskins-toggle-indicator ${isOpen ? "is-open" : ""}`} />
                        </p>
                      </button>
                      {selectedGroup && index + 1 === groupPanelInsertIndex && (
                        <div className="cskins-inline-panel" ref={inlineGroupRef}>
                          <button
                            className="content-detail-close"
                            type="button"
                            aria-label="Cerrar grupo"
                            onClick={closeGroupPanel}
                          >
                            <span className="content-detail-close-icon" aria-hidden="true" />
                          </button>
                          <div className="content-grid cskins-skin-grid" ref={groupSkinGridRef}>
                            {selectedGroup.items.map((skin, skinIndex) => {
                              const key = getSkinKey(skin);
                              const skinOpen = selectedSkinKey === key;
                              const imageSources = [
                                ...getSkinImageCandidates(skin),
                                getWeaponImageForSkin(skin, weaponByUuid),
                              ];
                              const image = imageSources[0] ?? null;
                              const tierLabel = (skin.contentTierUuid && tierNames.get(skin.contentTierUuid)) || "Sin rareza";
                              return (
                                <div key={key} className="cskins-skin-slot">
                                  <button
                                    ref={setSkinCardRef(key)}
                                    type="button"
                                    className={`content-card cskins-skin-card ${skinOpen ? "active" : ""}`}
                                    onClick={() => selectSkin(key)}
                                  >
                                    <span className="content-card-image-wrap cskins-skin-image-wrap">
                                      {image ? (
                                        <FallbackImage
                                          className="content-card-image cskins-skin-image"
                                          sources={imageSources}
                                          alt={skin.displayName}
                                          loading="lazy"
                                        />
                                      ) : (
                                        <span className="cskins-image-fallback">SK</span>
                                      )}
                                    </span>
                                    <h3 className="content-card-title">{skin.displayName}</h3>
                                    <p className="content-card-meta">{skin.weaponName || "Arma"} - {tierLabel}</p>
                                    <p className="content-card-meta">{resolveCollectionName(skin)}</p>
                                  </button>
                                  {selectedSkin && skinIndex + 1 === groupSkinDetailInsertIndex && (
                                    <div className="cskins-detail-slot" ref={detailRef}>
                                      <SkinDetail
                                        skin={selectedSkin}
                                        tierLabel={selectedSkinTierLabel}
                                        themeIcon={selectedSkinThemeIcon}
                                        onClose={closeSkinDetail}
                                      />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {mode === "skins" && (
            <section className="content-section cskins-content-section">
              <h2 className="content-section-title">Skins</h2>
              <div className="content-grid cskins-skin-grid" ref={allSkinGridRef}>
                {progressiveSkins.visibleItems.map((skin, index) => {
                  const key = getSkinKey(skin);
                  const skinOpen = selectedSkinKey === key;
                  const imageSources = [
                    ...getSkinImageCandidates(skin),
                    getWeaponImageForSkin(skin, weaponByUuid),
                  ];
                  const image = imageSources[0] ?? null;
                  const tierLabel = (skin.contentTierUuid && tierNames.get(skin.contentTierUuid)) || "Sin rareza";
                  return (
                    <div key={key} className="cskins-skin-slot">
                      <button
                        ref={setSkinCardRef(key)}
                        type="button"
                        className={`content-card cskins-skin-card ${skinOpen ? "active" : ""}`}
                        onClick={() => selectSkin(key)}
                      >
                        <span className="content-card-image-wrap cskins-skin-image-wrap">
                          {image ? (
                            <FallbackImage
                              className="content-card-image cskins-skin-image"
                              sources={imageSources}
                              alt={skin.displayName}
                              loading="lazy"
                            />
                          ) : (
                            <span className="cskins-image-fallback">SK</span>
                          )}
                        </span>
                        <h3 className="content-card-title">{skin.displayName}</h3>
                        <p className="content-card-meta">{skin.weaponName || "Arma"} - {tierLabel}</p>
                        <p className="content-card-meta">{resolveCollectionName(skin)}</p>
                      </button>
                      {selectedSkin && index + 1 === allSkinDetailInsertIndex && (
                        <div className="cskins-detail-slot" ref={detailRef}>
                          <SkinDetail
                            skin={selectedSkin}
                            tierLabel={selectedSkinTierLabel}
                            themeIcon={selectedSkinThemeIcon}
                            onClose={closeSkinDetail}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {progressiveSkins.hasMore && (
                <div ref={progressiveSkins.sentinelRef} className="content-load-more">
                  <button type="button" onClick={progressiveSkins.showMore}>
                    Mostrar más ({selectedItems.length - progressiveSkins.visibleCount})
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </ContentShell>
  );
}
