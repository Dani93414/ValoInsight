import { useEffect, useRef, useState } from "react";
import { ArrowRight, Lock, Search, Star, UserRoundSearch, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCompetitiveTiers } from "../../api/hooks";
import { searchPlayers } from "../../api/stats";
import {
  addFavorite,
  addRecentPlayer,
  getFavorites,
  getFrequentPlayers,
  getRecentPlayers,
  removeFavorite,
  type UserPlayer,
} from "../../api/userApi";
import { useAuth } from "../../context/AuthContext";
import LoadingModal from "../ui/LoadingModal";
import {
  getRankNameFromTier,
  applyUnrankedRankIconFallback,
  resolveCompetitiveTierIcon,
} from "../../utils/rankUtils";
import { canSearchPlayer, PLAYER_SEARCH_DEBOUNCE_MS } from "../../utils/playerSearch";
import "../auth/AuthModal.css";
import "./PlayerSearchModal.css";

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

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

type SearchSectionId = "search" | "favorites" | "recent" | "frequent" | "premier";

type SearchSection = {
  id: SearchSectionId;
  label: string;
};

const searchSections: SearchSection[] = [
  { id: "search", label: "Búsqueda" },
  { id: "favorites", label: "Favoritos" },
  { id: "recent", label: "Recientes" },
  { id: "frequent", label: "Jugadores Frecuentes" },
  { id: "premier", label: "Premier" },
];

const authenticatedSectionMessages: Record<Exclude<SearchSectionId, "search">, string> = {
  favorites: "Todavía no tienes favoritos",
  recent: "Todavía no hay jugadores recientes",
  frequent: "Todavía no hay datos suficientes",
  premier: "Todavía no has configurado tu equipo premier",
};

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
  if (elapsedHours < 24) return elapsedHours === 1 ? "Hace 1 hora" : `Hace ${elapsedHours} horas`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? "Hace 1 día" : `Hace ${elapsedDays} días`;
}

export function PlayerSearchModal({ isOpen, onClose }: Props) {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuth();
  const [gameName, setGameName] = useState("");
  const [tagLine, setTagLine] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeSearchSection, setActiveSearchSection] = useState<SearchSectionId>("search");
  const [favoritePlayers, setFavoritePlayers] = useState<UserPlayer[]>([]);
  const [recentPlayers, setRecentPlayers] = useState<UserPlayer[]>([]);
  const [frequentPlayers, setFrequentPlayers] = useState<UserPlayer[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loadingUserSection, setLoadingUserSection] = useState<SearchSectionId | null>(null);
  const requestSequenceRef = useRef(0);
  const competitiveTiersQuery = useCompetitiveTiers();

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const trimmedGameName = gameName.trim();
    const trimmedTagLine = tagLine.trim();
    requestSequenceRef.current += 1;
    const requestId = requestSequenceRef.current;

    if (!trimmedGameName && !trimmedTagLine) {
      setResults([]);
      setIsLoading(false);
      return;
    }
    if (!canSearchPlayer(trimmedGameName, trimmedTagLine)) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      setIsLoading(true);
      try {
        const response = await searchPlayers(trimmedGameName, trimmedTagLine);
        if (requestId === requestSequenceRef.current) {
          setResults(response ?? []);
        }
      } catch {
        if (requestId === requestSequenceRef.current) {
          setResults([]);
        }
      } finally {
        if (requestId === requestSequenceRef.current) {
          setIsLoading(false);
        }
      }
    }, PLAYER_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [gameName, isOpen, tagLine]);

  useEffect(() => {
    if (!isOpen) return;
    if (!isLoggedIn && activeSearchSection !== "search") {
      setActiveSearchSection("search");
    }
  }, [activeSearchSection, isLoggedIn, isOpen]);

  useEffect(() => {
    if (!isOpen || !isLoggedIn) return;
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
  }, [activeSearchSection, isLoggedIn, isOpen]);

  if (!isOpen) return null;
  const trimmedGameName = gameName.trim();
  const trimmedTagLine = tagLine.trim();
  const hasSearch = Boolean(trimmedGameName || trimmedTagLine);
  const canSearch = canSearchPlayer(trimmedGameName, trimmedTagLine);

  const openPlayer = (playerId: string) => {
    if (isLoggedIn) {
      void addRecentPlayer(playerId).catch(() => {
        // non-blocking
      });
    }
    navigate(`/estadisticas/${playerId}`);
    onClose();
  };

  const handleSubmitSearch = () => {
    const firstResult = results[0];
    if (firstResult) openPlayer(firstResult.id);
  };

  const handleToggleFavorite = async (playerId: string) => {
    if (!isLoggedIn || !playerId) return;
    const wasFavorite = favoriteIds.has(playerId);
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (wasFavorite) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
    try {
      if (wasFavorite) {
        await removeFavorite(playerId);
        setFavoritePlayers((current) =>
          current.filter((player) => (player.puuid || player.id) !== playerId),
        );
      } else {
        await addFavorite(playerId);
        const players = await getFavorites();
        setFavoritePlayers(players);
        setFavoriteIds(new Set(players.map((player) => player.puuid || player.id)));
      }
    } catch {
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (wasFavorite) next.add(playerId);
        else next.delete(playerId);
        return next;
      });
    }
  };

  const renderPlayerList = (
    players: Array<SearchResult | UserPlayer>,
    emptyMessage: string,
    options: { showFavoriteButton?: boolean; showSharedMatches?: boolean } = {},
  ) => {
    if (players.length === 0) {
      return <div className="home-search-coming-soon">{emptyMessage}</div>;
    }

    return (
      <ul className="home-search-results topbar-player-search-modal__results">
        {players.map((player) => {
          const playerId = "puuid" in player ? player.puuid : player.id;
          const playerNameTag = player.tagLine
            ? `${player.gameName}#${player.tagLine}`
            : player.gameName;
          const displayTitle = player.displayName || playerNameTag;
          const isFavorite = favoriteIds.has(playerId);
          const competitiveTier = player.lastCompetitiveTier;
          const rankName = getRankNameFromTier(competitiveTier);
          const tierFromContent =
            (competitiveTiersQuery.data ?? []).find(
              (item) => Number(item.tier) === Number(competitiveTier),
            ) ?? null;
          const rankIcon = resolveCompetitiveTierIcon(
            competitiveTier,
            player.lastCompetitiveTierImage ?? tierFromContent?.smallIcon ?? tierFromContent?.largeIcon,
            competitiveTiersQuery.data ?? [],
          );

          return (
            <li key={playerId}>
              <button type="button" onClick={() => openPlayer(playerId)}>
                <span className="home-search-result__main">
                  <strong>{displayTitle}</strong>
                </span>
                <span className="home-search-result__last-seen">
                  Última conexión ·{" "}
                  {formatLastSeen(player.lastMatchStartMillis, player.lastMatchDurationMillis)}
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
                      isFavorite ? " home-search-result__favorite-button--active" : ""
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
                      void handleToggleFavorite(playerId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      void handleToggleFavorite(playerId);
                    }}
                  >
                    <Star size={16} aria-hidden="true" />
                  </span>
                )}
                <ArrowRight className="home-search-result__arrow" size={18} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  const renderSearchResultList = () =>
    renderPlayerList(results, "No se encontraron jugadores con esos filtros.", {
      showFavoriteButton: true,
    });

  return (
    <div
      className="home-auth-modal topbar-player-search-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="home-auth-dialog topbar-player-search-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="topbar-player-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="home-auth-dialog__close"
          type="button"
          aria-label="Cerrar"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>

        <div className="home-auth-dialog__header">
          <UserRoundSearch size={24} aria-hidden="true" />
          <div>
            <span className="home-panel-label">Búsqueda rápida</span>
            <h2 id="topbar-player-search-title">Buscar jugador</h2>
          </div>
        </div>

        <form
          className="topbar-player-search-modal__grid"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmitSearch();
          }}
        >
          <label className="home-field">
            <span>gameName</span>
            <div className="home-field__control">
              <Search size={17} aria-hidden="true" />
              <input
                placeholder="TenZ"
                value={gameName}
                onChange={(event) => setGameName(event.target.value)}
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
                onChange={(event) => setTagLine(event.target.value)}
              />
            </div>
          </label>

          <button className="home-search-button" type="submit">
            <Search size={18} aria-hidden="true" />
            Buscar
          </button>
        </form>

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
                onClick={() => setActiveSearchSection(section.id)}
              >
                <span>{section.label}</span>
                {isLocked && <Lock size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {activeSearchSection === "search" ? (
          <>
            {isLoading && (
              <LoadingModal placement="section" />
            )}
            {!isLoading && !canSearch && hasSearch && (
              <div className="home-search-coming-soon">Mínimo escribe 3 letras</div>
            )}
            {!isLoading && canSearch && renderSearchResultList()}
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
    </div>
  );
}
