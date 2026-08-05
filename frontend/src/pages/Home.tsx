import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  Crosshair,
  Gem,
  Info,
  Layers3,
  Lock,
  Map,
  Medal,
  Search,
  Shield,
  Sparkles,
  Star,
  Swords,
  Trophy,
  UserRoundSearch,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCompetitiveTiers, useRegionSummaries } from "../api/hooks";
import { searchPlayers } from "../api/stats.ts";
import { useAuth } from "../context/AuthContext";
import LoadingModal from "../components/ui/LoadingModal";
import PageLoadingScreen from "../components/ui/PageLoadingScreen";
import { canSearchPlayer, PLAYER_SEARCH_DEBOUNCE_MS } from "../utils/playerSearch";
import {
  addFavorite,
  addRecentPlayer,
  getFavorites,
  getFrequentPlayers,
  getRecentPlayers,
  removeFavorite,
  type UserPlayer,
} from "../api/userApi";
import {
  getRankNameFromTier,
  applyUnrankedRankIconFallback,
  normalizeCompetitiveTierIconPath,
  resolveCompetitiveTierIcon,
} from "../utils/rankUtils";
import "./Home.css";

type SearchResult = {
  id: string;
  gameName: string;
  tagLine: string;
  displayName: string;
  accountLevel?: number | null;
  lastMatchStartMillis?: number | null;
  lastMatchDurationMillis?: number | null;
  lastCompetitiveTier?: number | null;
  lastCompetitiveTierImage?: string | null;
};

type NavItem = {
  title: string;
  description: string;
  path: string;
  icon: LucideIcon;
  className?: string;
};

type GlobalInsightCard = {
  label: string;
  value: string;
  detail: string;
  accent: "red" | "teal" | "gold" | "white";
};

type SearchSectionId = "search" | "favorites" | "recent" | "frequent" | "premier";

type SearchSection = {
  id: SearchSectionId;
  label: string;
};

type RevealStyle = CSSProperties & {
  "--reveal-index"?: number;
};

const numberFormatters = new globalThis.Map<number, Intl.NumberFormat>();
const dateFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const analysisCards: NavItem[] = [
  {
    title: "Agentes",
    description: "Roles, habilidades y lectura táctica para cada composición.",
    path: "/agentes",
    icon: Shield,
    className: "home-analysis-card--agents",
  },
  {
    title: "Armas",
    description: "Daño, cadencia, economía y rendimiento por rango.",
    path: "/armas",
    icon: Crosshair,
    className: "home-analysis-card--weapons",
  },
  {
    title: "Mapas",
    description: "Zonas, sites y contexto competitivo por escenario.",
    path: "/mapas",
    icon: Map,
    className: "home-analysis-card--maps",
  },
];

const exploreCards: NavItem[] = [
  {
    title: "Actos",
    description: "Episodios competitivos, rangos y leaderboards.",
    path: "/actos",
    icon: Trophy,
  },
  {
    title: "Eventos",
    description: "Contenido temporal, fechas y recompensas disponibles.",
    path: "/eventos",
    icon: CalendarDays,
  },
  {
    title: "Modos",
    description: "Reglas, duración y variantes de juego.",
    path: "/modos",
    icon: Swords,
  },
  {
    title: "Información",
    description: "Versión actual, monedas, rangos, contratos y tiers.",
    path: "/informacion",
    icon: Info,
  },
];

const cosmeticCards: NavItem[] = [
  {
    title: "Skins",
    description: "Aspectos de armas",
    path: "/cosmeticos/skins",
    icon: Sparkles,
  },
  {
    title: "Llaveros",
    description: "Detalles para tus armas",
    path: "/cosmeticos/llaveros",
    icon: Gem,
  },
  {
    title: "Flex",
    description: "Equipables animados",
    path: "/cosmeticos/flex",
    icon: Zap,
  },
  {
    title: "Bordes de nivel",
    description: "Progreso visual",
    path: "/cosmeticos/bordes",
    icon: Medal,
  },
  {
    title: "Títulos y tarjetas",
    description: "Identidad de perfil",
    path: "/cosmeticos/titulos-tarjetas",
    icon: Layers3,
  },
  {
    title: "Sprays",
    description: "Expresión durante el juego",
    path: "/cosmeticos/sprays",
    icon: Crosshair,
  },
];

const searchSections: SearchSection[] = [
  { id: "search", label: "Búsqueda" },
  { id: "favorites", label: "Favoritos" },
  { id: "recent", label: "Recientes" },
  { id: "frequent", label: "Jugadores más frecuentes" },
  { id: "premier", label: "Equipo de premier" },
];

const authenticatedSectionMessages: Record<Exclude<SearchSectionId, "search">, string> = {
  favorites: "Todavia no tienes favoritos",
  recent: "Todavia no hay jugadores recientes",
  frequent: "Todavia no hay datos suficientes",
  premier: "Todavia no has configurado tu equipo premier",
};

function revealStyle(index: number): RevealStyle {
  return { "--reveal-index": index };
}

function formatNumber(value?: number, decimals = 0) {
  if (value === undefined || value === null || Number.isNaN(value)) return "-";
  let formatter = numberFormatters.get(decimals);
  if (!formatter) {
    formatter = new Intl.NumberFormat("es-ES", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormatters.set(decimals, formatter);
  }
  return formatter.format(value);
}

function formatPercent(value?: number, decimals = 1) {
  if (value === undefined || value === null || Number.isNaN(value)) return "-";
  return `${formatNumber(value, decimals)}%`;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date);
}

function formatLastSeen(
  startMillis?: number | null,
  durationMillis?: number | null,
) {
  if (typeof startMillis !== "number" || !Number.isFinite(startMillis)) {
    return "Sin partidas registradas";
  }

  const safeDuration =
    typeof durationMillis === "number" && Number.isFinite(durationMillis)
      ? durationMillis
      : 0;
  const elapsedMillis = Math.max(0, Date.now() - (startMillis + safeDuration));
  const elapsedHours = Math.floor(elapsedMillis / (60 * 60 * 1000));

  if (elapsedHours < 1) return "Hace menos de 1 hora";
  if (elapsedHours < 24) {
    return elapsedHours === 1 ? "Hace 1 hora" : `Hace ${elapsedHours} horas`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? "Hace 1 día" : `Hace ${elapsedDays} días`;
}

export default function Home() {
  const { isLoggedIn } = useAuth();
  const [gameName, setGameName] = useState("");
  const [tagLine, setTagLine] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState("");
  const [showScrollHint, setShowScrollHint] = useState(false);
  const [activeSearchSection, setActiveSearchSection] =
    useState<SearchSectionId>("search");
  const [favoritePlayers, setFavoritePlayers] = useState<UserPlayer[]>([]);
  const [recentPlayers, setRecentPlayers] = useState<UserPlayer[]>([]);
  const [frequentPlayers, setFrequentPlayers] = useState<UserPlayer[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loadingUserSection, setLoadingUserSection] =
    useState<SearchSectionId | null>(null);
  const regionsQuery = useRegionSummaries();
  const competitiveTiersQuery = useCompetitiveTiers();
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSequenceRef = useRef(0);
  const navigate = useNavigate();

  const handleSearch = (nextGameName: string, nextTagLine: string) => {
    setGameName(nextGameName);
    setTagLine(nextTagLine);
    requestSequenceRef.current += 1;
    const scheduledRequestId = requestSequenceRef.current;

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }

    const trimmedGameName = nextGameName.trim();
    const trimmedTagLine = nextTagLine.trim();

    if (!trimmedGameName && !trimmedTagLine) {
      setResults([]);
      setLoading(false);
      return;
    }

    if (!canSearchPlayer(trimmedGameName, trimmedTagLine)) {
      setResults([]);
      setLoading(false);
      return;
    }

    searchTimeoutRef.current = setTimeout(async () => {
      const requestId = scheduledRequestId;

      setLoading(true);
      try {
        const res = await searchPlayers(nextGameName, nextTagLine);
        if (requestId === requestSequenceRef.current) {
          setResults(res || []);
        }
      } catch {
        if (requestId === requestSequenceRef.current) {
          setResults([]);
        }
      } finally {
        if (requestId === requestSequenceRef.current) {
          setLoading(false);
        }
      }
    }, PLAYER_SEARCH_DEBOUNCE_MS);
  };

  const refreshFavorites = async () => {
    const players = await getFavorites();
    setFavoritePlayers(players);
    setFavoriteIds(new Set(players.map((player) => player.puuid || player.id)));
  };

  const handleOpenPlayer = (puuid: string) => {
    if (!puuid) return;
    if (isLoggedIn) {
      void addRecentPlayer(puuid).catch(() => {
        // Navigation should not be blocked by private activity tracking.
      });
    }
    navigate(`/estadisticas/${puuid}`);
  };

  const handleToggleFavorite = async (puuid: string) => {
    if (!isLoggedIn || !puuid) return;

    const wasFavorite = favoriteIds.has(puuid);
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (wasFavorite) next.delete(puuid);
      else next.add(puuid);
      return next;
    });

    try {
      if (wasFavorite) {
        await removeFavorite(puuid);
        setFavoritePlayers((current) =>
          current.filter((player) => (player.puuid || player.id) !== puuid),
        );
      } else {
        await addFavorite(puuid);
        await refreshFavorites();
      }
    } catch {
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (wasFavorite) next.add(puuid);
        else next.delete(puuid);
        return next;
      });
    }
  };

  const handleSubmitSearch = () => {
    const firstResult = results[0];
    if (firstResult) {
      handleOpenPlayer(firstResult.id);
      return;
    }

    if (canSearchPlayer(gameName, tagLine)) {
      handleSearch(gameName, tagLine);
    }
  };

  const handleSelectSearchSection = (section: SearchSection) => {
    const isLocked = !isLoggedIn && section.id !== "search";
    if (isLocked) return;
    setActiveSearchSection(section.id);
  };

  const handleGlobalCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigate("/estadisticas-globales");
    }
  };

  const handleScrollHintClick = () => {
    window.scrollBy({
      top: window.innerHeight * 0.85,
      behavior: "smooth",
    });
  };

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isLoggedIn && activeSearchSection !== "search") {
      setActiveSearchSection("search");
    }
    if (!isLoggedIn) {
      setFavoritePlayers([]);
      setRecentPlayers([]);
      setFrequentPlayers([]);
      setFavoriteIds(new Set());
      setLoadingUserSection(null);
    }
  }, [activeSearchSection, isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) return;

    let isCancelled = false;

    const loadPrivateSection = async () => {
      const sectionsToLoad =
        activeSearchSection === "search"
          ? (["favorites"] as const)
          : ([activeSearchSection] as const);

      setLoadingUserSection(activeSearchSection === "premier" ? null : activeSearchSection);

      try {
        for (const section of sectionsToLoad) {
          if (section === "favorites") {
            const players = await getFavorites();
            if (!isCancelled) {
              setFavoritePlayers(players);
              setFavoriteIds(new Set(players.map((player) => player.puuid || player.id)));
            }
          }
          if (section === "recent") {
            const players = await getRecentPlayers();
            if (!isCancelled) setRecentPlayers(players);
          }
          if (section === "frequent") {
            const players = await getFrequentPlayers();
            if (!isCancelled) setFrequentPlayers(players);
          }
        }
      } catch {
        if (!isCancelled) {
          if (activeSearchSection === "favorites") setFavoritePlayers([]);
          if (activeSearchSection === "recent") setRecentPlayers([]);
          if (activeSearchSection === "frequent") setFrequentPlayers([]);
        }
      } finally {
        if (!isCancelled) setLoadingUserSection(null);
      }
    };

    void loadPrivateSection();

    return () => {
      isCancelled = true;
    };
  }, [activeSearchSection, isLoggedIn]);

  useLayoutEffect(() => {
    const targets = document.querySelectorAll<HTMLElement>(".home-reveal");
    const homePage = document.querySelector<HTMLElement>(".home-page");

    if (
      !("IntersectionObserver" in window)
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      targets.forEach((target) => target.classList.add("home-is-visible"));
      return;
    }

    homePage?.classList.add("home-reveal-ready");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("home-is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
    );

    targets.forEach((target) => observer.observe(target));
    return () => {
      observer.disconnect();
      homePage?.classList.remove("home-reveal-ready");
    };
  }, [competitiveTiersQuery.isLoading, regionsQuery.isLoading]);

  useEffect(() => {
    const updateScrollHintVisibility = () => {
      const isNearBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 80;

      setShowScrollHint(!isNearBottom);
    };

    updateScrollHintVisibility();
    window.addEventListener("scroll", updateScrollHintVisibility, {
      passive: true,
    });
    window.addEventListener("resize", updateScrollHintVisibility);

    return () => {
      window.removeEventListener("scroll", updateScrollHintVisibility);
      window.removeEventListener("resize", updateScrollHintVisibility);
    };
  }, []);

  const trimmedGameName = gameName.trim();
  const trimmedTagLine = tagLine.trim();
  const hasSearch = Boolean(trimmedGameName || trimmedTagLine);
  const canSearch = trimmedGameName.length >= 3 || trimmedTagLine.length >= 3;
  const showMinCharactersMessage = hasSearch && !canSearch;
  const regions = useMemo(() => regionsQuery.data ?? [], [regionsQuery.data]);
  const rankIconByTier = useMemo(() => {
    const iconMap = new globalThis.Map<number, string>();
    for (const tier of competitiveTiersQuery.data ?? []) {
      const numericTier = Number(tier.tier);
      if (!Number.isFinite(numericTier)) continue;

      const icon = normalizeCompetitiveTierIconPath(
        tier.smallIcon ||
          tier.largeIcon ||
          tier.rankTriangleUpIcon ||
          tier.rankTriangleDownIcon,
      );
      if (icon) iconMap.set(numericTier, icon);
    }
    return iconMap;
  }, [competitiveTiersQuery.data]);
  const activeRegionCode = selectedRegion || regions[0]?.region || "";
  const activeRegion =
    regions.find((region) => region.region === activeRegionCode) ?? regions[0];
  const topAgent = activeRegion?.mostPlayedAgents?.[0];
  const topMap = activeRegion?.mostPlayedMaps?.[0];
  const topWeapon = activeRegion?.mostLethalWeapons?.[0];
  const averages = activeRegion?.averages;
  const isGlobalLoading = regionsQuery.isLoading;
  const updatedAt = formatDate(activeRegion?.updatedAt);

  useEffect(() => {
    if (!selectedRegion && regions.length > 0) {
      setSelectedRegion(regions[0].region);
    }
  }, [regions, selectedRegion]);

  const globalInsightCards = useMemo<GlobalInsightCard[]>(
    () => [
    {
      label: "Agente más jugado",
      value: isGlobalLoading ? "Cargando..." : topAgent?.agent_name ?? "-",
      detail: isGlobalLoading
        ? "Sincronizando datos globales"
        : `${formatNumber(topAgent?.picks)} picks · ${formatPercent(topAgent?.win_rate)} win rate`,
      accent: "red",
    },
    {
      label: "Mapa más jugado",
      value: isGlobalLoading ? "Cargando..." : topMap?.map_name ?? "-",
      detail: isGlobalLoading
        ? "Sincronizando datos globales"
        : `${formatNumber(topMap?.matches)} partidas`,
      accent: "teal",
    },
    {
      label: "Arma más letal",
      value: isGlobalLoading ? "Cargando..." : topWeapon?.weapon_name ?? "-",
      detail: isGlobalLoading
        ? "Sincronizando datos globales"
        : `${formatNumber(topWeapon?.kills)} kills · ${formatPercent(topWeapon?.headshot_pct)} HS`,
      accent: "gold",
    },
    {
      label: "Media global",
      value: isGlobalLoading ? "Cargando..." : `${formatNumber(averages?.acs, 1)} ACS`,
      detail: isGlobalLoading
        ? "Sincronizando datos globales"
        : `${formatNumber(averages?.adr, 1)} ADR · ${formatPercent(averages?.headshot_pct)} HS`,
      accent: "white",
    },
    ],
    [
      averages?.acs,
      averages?.adr,
      averages?.headshot_pct,
      isGlobalLoading,
      topAgent?.agent_name,
      topAgent?.picks,
      topAgent?.win_rate,
      topMap?.map_name,
      topMap?.matches,
      topWeapon?.headshot_pct,
      topWeapon?.kills,
      topWeapon?.weapon_name,
    ],
  );

  const renderPlayerList = (
    players: Array<SearchResult | UserPlayer>,
    emptyMessage: string,
    options: { showFavoriteButton?: boolean; showSharedMatches?: boolean } = {},
  ) => {
    if (players.length === 0) {
      return <div className="home-search-coming-soon">{emptyMessage}</div>;
    }

    return (
      <ul className="home-search-results">
        {players.map((player, index) => {
          const puuid = "puuid" in player ? player.puuid : player.id;
          const playerNameTag = player.tagLine
            ? `${player.gameName}#${player.tagLine}`
            : player.gameName;
          const displayTitle = player.displayName || playerNameTag;
          const competitiveTier = player.lastCompetitiveTier;
          const rankIcon = resolveCompetitiveTierIcon(
            competitiveTier,
            normalizeCompetitiveTierIconPath(player.lastCompetitiveTierImage) ??
              (typeof competitiveTier === "number" ? rankIconByTier.get(competitiveTier) : null),
            competitiveTiersQuery.data ?? [],
          );
          const rankName = getRankNameFromTier(competitiveTier);
          const isFavorite = favoriteIds.has(puuid);

          return (
            <li key={puuid} style={revealStyle(index)}>
              <button type="button" onClick={() => handleOpenPlayer(puuid)}>
                <span className="home-search-result__main">
                  <strong>{displayTitle}</strong>
                </span>

                <span className="home-search-result__last-seen">
                  Ultima conexion ·{" "}
                  {formatLastSeen(
                    player.lastMatchStartMillis,
                    player.lastMatchDurationMillis,
                  )}
                </span>

                <span className="home-search-result__level-wrap">
                  <img
                    className="home-search-result__rank-icon"
                    src={rankIcon}
                    alt={rankName}
                    onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
                  />
                  {options.showSharedMatches && "sharedMatches" in player ? (
                    <span className="home-search-result__meta-pill">
                      {player.sharedMatches ?? 0} partidas juntos
                    </span>
                  ) : (
                    <span className="home-search-result__level">
                      {typeof player.accountLevel === "number"
                        ? `Nivel ${player.accountLevel}`
                        : "Nivel -"}
                    </span>
                  )}
                </span>

                {options.showFavoriteButton && isLoggedIn && (
                  <span
                    className={`home-search-result__favorite-button${
                      isFavorite
                        ? " home-search-result__favorite-button--active"
                        : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    aria-label={
                      isFavorite
                        ? "Quitar jugador de favoritos"
                        : "Anadir jugador a favoritos"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleToggleFavorite(puuid);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      void handleToggleFavorite(puuid);
                    }}
                  >
                    <Star size={16} aria-hidden="true" />
                  </span>
                )}

                <ArrowRight
                  className="home-search-result__arrow"
                  size={18}
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  if (regionsQuery.isLoading || competitiveTiersQuery.isLoading) {
    return <PageLoadingScreen />;
  }

  return (
    <main className="home-page">
      <section className="home-hero" aria-labelledby="home-hero-title">
        <div className="home-hero__visual" aria-hidden="true">
          <span className="home-tactical-line home-tactical-line--one" />
          <span className="home-tactical-line home-tactical-line--two" />
          <span className="home-tactical-line home-tactical-line--three" />
          <span className="home-tactical-node home-tactical-node--one" />
          <span className="home-tactical-node home-tactical-node--two" />
          <span className="home-tactical-node home-tactical-node--three" />
        </div>

        <div className="home-hero__content">
          <span className="home-kicker">ValoInsight</span>
          <h1 id="home-hero-title">Tu centro táctico de Valorant</h1>
          <p>
            Busca jugadores, compara rendimiento y explora datos competitivos
            con una lectura clara.
          </p>
        </div>

        <section className="home-search-panel" aria-label="Buscar jugador">
          <div className="home-search-panel__header">
            <div className="home-search-panel__title">
              <UserRoundSearch size={24} aria-hidden="true" />
              <h2>Buscar jugador</h2>
            </div>
          </div>

          <div className="home-search-grid">
            <label className="home-field">
              <span>gameName</span>
              <div className="home-field__control">
                <Search size={17} aria-hidden="true" />
                <input
                  placeholder="TenZ"
                  value={gameName}
                  onChange={(event) => handleSearch(event.target.value, tagLine)}
                />
              </div>
            </label>

            <label className="home-field">
              <span>tagLine</span>
              <div className="home-field__control">
                <span className="home-field__hash">#</span>
                <input
                  placeholder="NA1"
                  value={tagLine}
                  onChange={(event) => handleSearch(gameName, event.target.value)}
                />
              </div>
            </label>

            <button
              className="home-search-button"
              type="button"
              onClick={handleSubmitSearch}
            >
              <Search size={18} aria-hidden="true" />
              Buscar
            </button>
          </div>

          <div className="home-search-tabs" role="tablist" aria-label="Apartados del buscador">
            {searchSections.map((section) => {
              const isLocked = !isLoggedIn && section.id !== "search";
              const isActive = activeSearchSection === section.id;
              return (
                <button
                  key={section.id}
                  className={`home-search-tab${isActive ? " home-search-tab--active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-disabled={isLocked}
                  disabled={isLocked}
                  onClick={() => handleSelectSearchSection(section)}
                >
                  <span>{section.label}</span>
                  {isLocked && <Lock size={14} aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          {activeSearchSection === "search" ? (
            <>
              <div className="home-search-status" aria-live="polite">
                {loading && (
                  <LoadingModal placement="section" />
                )}

                {!loading && showMinCharactersMessage && (
                  <div className="home-search-empty">Mínimo escribe 3 letras</div>
                )}

                {!loading && !showMinCharactersMessage && hasSearch && results.length === 0 && (
                  <div className="home-search-empty">
                    No se encontraron jugadores con esos filtros.
                  </div>
                )}
              </div>

              {!loading && results.length > 0 && (
                <ul className="home-search-results">
                  {results.map((result, index) => {
                    const playerNameTag = result.tagLine
                      ? `${result.gameName}#${result.tagLine}`
                      : result.gameName;
                    const displayTitle = result.displayName || playerNameTag;
                    const competitiveTier = result.lastCompetitiveTier;
                    const rankIcon = resolveCompetitiveTierIcon(
                      competitiveTier,
                      normalizeCompetitiveTierIconPath(result.lastCompetitiveTierImage) ??
                        (typeof competitiveTier === "number" ? rankIconByTier.get(competitiveTier) : null),
                      competitiveTiersQuery.data ?? [],
                    );
                    const rankName = getRankNameFromTier(
                      competitiveTier,
                    );

                    return (
                      <li key={result.id} style={revealStyle(index)}>
                        <button
                          type="button"
                          onClick={() => handleOpenPlayer(result.id)}
                        >
                          <span className="home-search-result__main">
                            <strong>{displayTitle}</strong>
                          </span>

                          <span className="home-search-result__last-seen">
                            Última conexión ·{" "}
                            {formatLastSeen(
                              result.lastMatchStartMillis,
                              result.lastMatchDurationMillis,
                            )}
                          </span>

                          <span className="home-search-result__level-wrap">
                            <img
                              className="home-search-result__rank-icon"
                              src={rankIcon}
                              alt={rankName}
                              onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
                            />
                            <span className="home-search-result__level">
                              {typeof result.accountLevel === "number"
                                ? `Nivel ${result.accountLevel}`
                                : "Nivel -"}
                            </span>
                          </span>

                          {isLoggedIn && (
                            <span
                              className={`home-search-result__favorite-button${
                                favoriteIds.has(result.id)
                                  ? " home-search-result__favorite-button--active"
                                  : ""
                              }`}
                              role="button"
                              tabIndex={0}
                              aria-label={
                                favoriteIds.has(result.id)
                                  ? "Quitar jugador de favoritos"
                                  : "Anadir jugador a favoritos"
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleToggleFavorite(result.id);
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                event.stopPropagation();
                                void handleToggleFavorite(result.id);
                              }}
                            >
                              <Star size={16} aria-hidden="true" />
                            </span>
                          )}

                          <ArrowRight
                            className="home-search-result__arrow"
                            size={18}
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : (
            <>
              {loadingUserSection === activeSearchSection && (
                <LoadingModal placement="section" />
              )}

              {loadingUserSection !== activeSearchSection &&
                activeSearchSection === "favorites" &&
                renderPlayerList(
                  favoritePlayers,
                  authenticatedSectionMessages.favorites,
                  { showFavoriteButton: true },
                )}

              {loadingUserSection !== activeSearchSection &&
                activeSearchSection === "recent" &&
                renderPlayerList(
                  recentPlayers,
                  authenticatedSectionMessages.recent,
                  { showFavoriteButton: true },
                )}

              {loadingUserSection !== activeSearchSection &&
                activeSearchSection === "frequent" &&
                renderPlayerList(
                  frequentPlayers,
                  authenticatedSectionMessages.frequent,
                  { showFavoriteButton: true, showSharedMatches: true },
                )}

              {activeSearchSection === "premier" && (
                <div className="home-search-coming-soon">
                  {authenticatedSectionMessages.premier}
                </div>
              )}
            </>
          )}
        </section>
      </section>

      <section
        className="home-section home-reveal"
        aria-labelledby="analysis-title"
      >
        <div className="home-section__header">
          <span className="home-kicker">Centro de análisis</span>
          <h2 id="analysis-title">Análisis competitivo y datos del juego</h2>
        </div>

        <div className="home-analysis-grid">
          <article
            className="home-global-card home-reveal"
            role="button"
            tabIndex={0}
            style={revealStyle(0)}
            onClick={() => navigate("/estadisticas-globales")}
            onKeyDown={handleGlobalCardKeyDown}
          >
            <div className="home-global-card__content">
              <div className="home-global-card__meta">
                <span className="home-panel-label">Data center</span>
                <span>
                  Región {activeRegion?.region ?? "-"}
                  {updatedAt ? ` · Actualizado ${updatedAt}` : ""}
                </span>
              </div>
              <div className="home-global-card__title-row">
                <h3>Estadísticas globales</h3>
                <label
                  className="home-global-card__region-selector"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <span>Región activa</span>
                  <select
                    value={activeRegionCode}
                    disabled={regions.length === 0}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      event.stopPropagation();
                      setSelectedRegion(event.target.value);
                    }}
                  >
                    {regions.length === 0 ? (
                      <option value="">Sin regiones</option>
                    ) : (
                      regions.map((region) => (
                        <option key={region.region} value={region.region}>
                          {region.region}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
              <p>
                Rankings, regiones, agentes, mapas, armas y economía reunidos
                en una vista pensada para detectar tendencias.
              </p>
              <span className="home-card-link">
                Abrir panel global <ArrowRight size={18} aria-hidden="true" />
              </span>
            </div>

            <div className="home-global-card__insights" aria-label="Resumen global">
              {globalInsightCards.map((card, index) => (
                <div
                  key={card.label}
                  className={`home-global-insight home-global-insight--${card.accent}`}
                  style={revealStyle(index)}
                >
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                  <small>{card.detail}</small>
                </div>
              ))}
            </div>
          </article>

          {analysisCards.map((card, index) => {
            const Icon = card.icon;
            return (
              <button
                key={card.path}
                className={`home-analysis-card home-reveal ${card.className ?? ""}`}
                type="button"
                style={revealStyle(index + 1)}
                onClick={() => navigate(card.path)}
              >
                <div className="home-card-overlay" />
                <div className="home-analysis-card__content">
                  <Icon size={26} aria-hidden="true" />
                  <h3>{card.title}</h3>
                  <p>{card.description}</p>
                </div>
                <ArrowRight className="home-card-arrow" size={22} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>

      <section
        className="home-section home-reveal"
        aria-labelledby="explore-title"
      >
        <div className="home-section__header home-section__header--inline">
          <div>
            <span className="home-kicker">Explorar Valorant</span>
            <h2 id="explore-title">Contenido, modos y contexto del juego</h2>
          </div>
        </div>

        <div className="home-explore-grid">
          {exploreCards.map((card, index) => {
            const Icon = card.icon;
            return (
              <button
                key={card.path}
                className="home-explore-card home-reveal"
                type="button"
                style={revealStyle(index)}
                onClick={() => navigate(card.path)}
              >
                <span className="home-explore-card__icon">
                  <Icon size={21} aria-hidden="true" />
                </span>
                <span className="home-explore-card__text">
                  <strong>{card.title}</strong>
                  <small>{card.description}</small>
                </span>
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>

      <section
        className="home-section home-reveal"
        aria-label="Cosméticos"
      >
        <div className="home-cosmetics-showcase">
          <article className="home-cosmetics-feature home-reveal" style={revealStyle(0)}>
            <div className="home-cosmetics-feature__content">
              <h3>Cosméticos</h3>
              <p>
                Explora skins, llaveros, sprays, flex y elementos de perfil desde
                un bloque visual dedicado.
              </p>
            </div>
          </article>

          <div className="home-cosmetics-grid">
            {cosmeticCards.map((card, index) => {
              const Icon = card.icon;
              return (
                <button
                  key={card.path}
                  className="home-cosmetic-card home-reveal"
                  type="button"
                  style={revealStyle(index + 1)}
                  onClick={() => navigate(card.path)}
                >
                  <span className="home-cosmetic-card__icon">
                    <Icon size={21} aria-hidden="true" />
                  </span>
                  <span className="home-cosmetic-card__text">
                    <strong className="home-cosmetic-card__name">
                      {card.title}
                    </strong>
                    <small>{card.description}</small>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {showScrollHint && (
        <button
          className="home-scroll-hint"
          type="button"
          aria-label="Ver más contenido"
          onClick={handleScrollHintClick}
        >
          <ChevronDown size={24} aria-hidden="true" />
        </button>
      )}
    </main>
  );
}
