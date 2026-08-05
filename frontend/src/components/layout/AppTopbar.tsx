import { lazy, Suspense, useMemo, useState } from "react";
import { ChevronDown, LogIn, LogOut, Search } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import LoadingModal from "../ui/LoadingModal";
import "./AppTopbar.css";

const loadAuthModal = () =>
  import("../auth/AuthModal").then((module) => ({ default: module.AuthModal }));
const loadPlayerSearchModal = () =>
  import("../search/PlayerSearchModal").then((module) => ({
    default: module.PlayerSearchModal,
  }));
const AuthModal = lazy(loadAuthModal);
const PlayerSearchModal = lazy(loadPlayerSearchModal);

type NavLink = {
  label: string;
  path: string;
};

type CurrentPage = NavLink & {
  id: string;
};

const LOGO_SRC = "/content/site/brand/valoinsight-logo.png";

const primaryLinks: NavLink[] = [
  { label: "Inicio", path: "/" },
  { label: "Estadísticas", path: "/estadisticas-globales" },
  { label: "Agentes", path: "/agentes" },
  { label: "Armas", path: "/armas" },
  { label: "Mapas", path: "/mapas" },
];

const moreLinks: NavLink[] = [
  { label: "Actos", path: "/actos" },
  { label: "Eventos", path: "/eventos" },
  { label: "Modos", path: "/modos" },
  { label: "Información", path: "/informacion" },
  { label: "Skins", path: "/cosmeticos/skins" },
  { label: "Llaveros", path: "/cosmeticos/llaveros" },
  { label: "Flex", path: "/cosmeticos/flex" },
  { label: "Bordes de nivel", path: "/cosmeticos/bordes" },
  { label: "Títulos y tarjetas", path: "/cosmeticos/titulos-tarjetas" },
  { label: "Sprays", path: "/cosmeticos/sprays" },
];

const routeLabels: NavLink[] = [...primaryLinks, ...moreLinks];

function normalizePath(pathname: string) {
  if (pathname.length > 1) return pathname.replace(/\/+$/, "");
  return pathname;
}

function getCurrentPage(pathname: string): CurrentPage {
  const normalizedPath = normalizePath(pathname);

  const staticPage = routeLabels.find((link) => link.path === normalizedPath);
  if (staticPage) {
    return { ...staticPage, id: staticPage.path };
  }

  if (/^\/estadisticas\/[^/]+\/heatmap$/.test(normalizedPath)) {
    return {
      id: "player-heatmap",
      label: "Heatmap",
      path: normalizedPath,
    };
  }

  if (/^\/estadisticas\/[^/]+$/.test(normalizedPath)) {
    return {
      id: "player-profile",
      label: "Perfil de jugador",
      path: normalizedPath,
    };
  }

  return { id: normalizedPath, label: "ValoInsight", path: normalizedPath };
}

export function AppTopbar() {
  const { user, isLoggedIn, logout } = useAuth();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isPlayerSearchOpen, setIsPlayerSearchOpen] = useState(false);
  const [isAuthActionLoading, setIsAuthActionLoading] = useState(false);
  const [moreMenuMode, setMoreMenuMode] = useState<"default" | "open" | "closed">(
    "default",
  );
  const navigate = useNavigate();
  const location = useLocation();
  const currentPage = useMemo(
    () => getCurrentPage(location.pathname),
    [location.pathname],
  );

  const profilePath = user?.puuid ? `/estadisticas/${user.puuid}` : "";
  const profileLabel = `${user?.gameName ?? "Jugador"}${
    user?.tagLine ? `#${user.tagLine}` : ""
  }`;
  const isProfileActive = Boolean(
    profilePath && normalizePath(location.pathname) === profilePath,
  );
  const isPrimaryCurrent = primaryLinks.some(
    (link) => link.path === currentPage.path,
  );
  const temporaryLink =
    !isPrimaryCurrent && !isProfileActive && currentPage.label !== "ValoInsight"
      ? currentPage
      : null;
  const visibleLinks = temporaryLink
    ? [...primaryLinks, temporaryLink]
    : primaryLinks;
  const menuLinks = moreLinks.filter((link) => link.path !== temporaryLink?.path);
  const isMoreActive = moreLinks.some(
    (link) => link.path === currentPage.path && link.path !== temporaryLink?.path,
  );

  const handleNavigate = (path: string) => {
    setMoreMenuMode("default");
    navigate(path);
  };

  const handleAuthAction = async () => {
    if (!isLoggedIn) {
      setIsAuthModalOpen(true);
      return;
    }
    setIsAuthActionLoading(true);
    try {
      await logout();
    } finally {
      setIsAuthActionLoading(false);
    }
  };

  const handleToggleMoreMenu = () => {
    setMoreMenuMode((current) => (current === "open" ? "closed" : "open"));
  };

  return (
    <>
      <header className="app-topbar" aria-label="Navegación principal">
        <button
          className="app-topbar__brand"
          type="button"
          onClick={() => handleNavigate("/")}
          aria-label="Ir al inicio de ValoInsight"
        >
          <img src={LOGO_SRC} alt="" className="app-topbar__logo" />
          <span className="app-topbar__brand-name">ValoInsight</span>
        </button>

        <nav className="app-topbar__nav" aria-label="Accesos rápidos">
          {visibleLinks.map((link) => {
            const isActive =
              link.path === currentPage.path ||
              (link.path === "/" && location.pathname === "/");
            return (
              <button
                key={`${link.path}-${link.label}`}
                className={`app-topbar__nav-button${
                  isActive ? " app-topbar__nav-button--active" : ""
                }`}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => handleNavigate(link.path)}
              >
                {link.label}
              </button>
            );
          })}

          <div
            className={`app-topbar__more app-topbar__more--${moreMenuMode}`}
            onMouseLeave={() => {
              if (moreMenuMode === "closed") setMoreMenuMode("default");
            }}
          >
            <button
              className={`app-topbar__nav-button${
                isMoreActive ? " app-topbar__nav-button--active" : ""
              }`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreMenuMode === "open"}
              onClick={handleToggleMoreMenu}
            >
              Más
              <ChevronDown size={15} aria-hidden="true" />
            </button>

            <div className="app-topbar__more-menu" role="menu">
              {menuLinks.map((link) => (
                <button
                  key={link.path}
                  className={`app-topbar__nav-button${
                    link.path === currentPage.path
                      ? " app-topbar__nav-button--active"
                      : ""
                  }`}
                  type="button"
                  role="menuitem"
                  onClick={() => handleNavigate(link.path)}
                >
                  {link.label}
                </button>
              ))}
            </div>
          </div>
        </nav>

        <div className="app-topbar__actions">
          <button
            className="app-topbar__search-button"
            type="button"
            onMouseEnter={loadPlayerSearchModal}
            onFocus={loadPlayerSearchModal}
            onClick={() => setIsPlayerSearchOpen(true)}
            aria-label="Buscar jugador"
          >
            <Search size={16} aria-hidden="true" />
            <span>Buscar jugador</span>
          </button>

          {isLoggedIn && user?.puuid && (
            <button
              className={`app-topbar__nav-button app-topbar__profile-button${
                isProfileActive ? " app-topbar__nav-button--active" : ""
              }`}
              type="button"
              aria-current={isProfileActive ? "page" : undefined}
              title="Ir a mi perfil"
              onClick={() => handleNavigate(`/estadisticas/${user.puuid}`)}
            >
              {profileLabel}
            </button>
          )}

          <button
            className={`app-topbar__login-button${
              isLoggedIn ? " app-topbar__login-button--icon-only" : ""
            }`}
            type="button"
            onMouseEnter={!isLoggedIn ? loadAuthModal : undefined}
            onFocus={!isLoggedIn ? loadAuthModal : undefined}
            onClick={handleAuthAction}
            aria-label={isLoggedIn ? "Cerrar sesion" : undefined}
            title={isLoggedIn ? "Cerrar sesion" : undefined}
          >
            {isLoggedIn ? (
              <LogOut size={17} aria-hidden="true" />
            ) : (
              <LogIn size={17} aria-hidden="true" />
            )}
            {!isLoggedIn && (
              <span className="app-topbar__login-label">Iniciar sesión</span>
            )}
          </button>
        </div>
      </header>

      <Suspense fallback={<LoadingModal placement="overlay" />}>
        {isAuthModalOpen && (
          <AuthModal
            isOpen
            onClose={() => setIsAuthModalOpen(false)}
          />
        )}
        {isPlayerSearchOpen && (
          <PlayerSearchModal
            isOpen
            onClose={() => setIsPlayerSearchOpen(false)}
          />
        )}
      </Suspense>
      {isAuthActionLoading && <LoadingModal placement="overlay" />}
    </>
  );
}
