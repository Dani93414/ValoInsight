import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Search, ShieldCheck, X } from "lucide-react";
import { searchPlayers } from "../../api/playerApi";
import { useAuth } from "../../context/AuthContext";
import LoadingModal from "../ui/LoadingModal";
import "./AuthModal.css";

type AuthMode = "login" | "register";

type PlayerOption = {
  id: string;
  gameName: string;
  tagLine: string;
  displayName: string;
};

type AuthModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [gameName, setGameName] = useState("");
  const [tagLine, setTagLine] = useState("");
  const [playerResults, setPlayerResults] = useState<PlayerOption[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerOption | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const searchSequenceRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setError("");
  }, [isOpen, mode]);

  useEffect(() => {
    if (!isOpen || mode !== "register") return;

    const trimmedGameName = gameName.trim();
    const trimmedTagLine = tagLine.trim();
    searchSequenceRef.current += 1;
    const requestId = searchSequenceRef.current;

    if (!trimmedGameName && !trimmedTagLine) {
      setPlayerResults([]);
      setIsSearching(false);
      return;
    }

    if (trimmedGameName.length < 3 && trimmedTagLine.length < 3) {
      setPlayerResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timeoutId = window.setTimeout(async () => {
      try {
        const results = await searchPlayers(trimmedGameName, trimmedTagLine);
        if (requestId === searchSequenceRef.current) {
          setPlayerResults(results);
        }
      } catch {
        if (requestId === searchSequenceRef.current) {
          setPlayerResults([]);
        }
      } finally {
        if (requestId === searchSequenceRef.current) {
          setIsSearching(false);
        }
      }
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [gameName, isOpen, mode, tagLine]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isRegister = mode === "register";
  const selectedPlayerName = selectedPlayer
    ? selectedPlayer.displayName
    : "Ningun jugador seleccionado";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      if (isRegister) {
        if (!selectedPlayer) {
          setError("Selecciona un jugador para asociar la cuenta");
          return;
        }
        await register(email, password, selectedPlayer.id);
      } else {
        await login(email, password);
      }
      onClose();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "No se pudo iniciar sesion",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBackdropKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClose();
    }
  };

  if (isSubmitting) {
    return <LoadingModal placement="overlay" />;
  }

  return (
    <div
      className="home-auth-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleBackdropKeyDown}
    >
      <section
        className="home-auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-auth-title"
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
          <ShieldCheck size={24} aria-hidden="true" />
          <div>
            <span className="home-panel-label">Cuenta ValoInsight</span>
            <h2 id="home-auth-title">
              {isRegister ? "Crear cuenta" : "Iniciar sesion"}
            </h2>
          </div>
        </div>

        <div className="home-auth-mode" role="tablist" aria-label="Modo de acceso">
          <button
            className={mode === "login" ? "home-auth-mode__button--active" : ""}
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            onClick={() => setMode("login")}
          >
            Login
          </button>
          <button
            className={mode === "register" ? "home-auth-mode__button--active" : ""}
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            onClick={() => setMode("register")}
          >
            Registro
          </button>
        </div>

        <form className="home-auth-form" onSubmit={handleSubmit}>
          <label className="home-field">
            <span>Email</span>
            <div className="home-field__control">
              <input
                autoComplete="email"
                inputMode="email"
                placeholder="tu@email.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </label>

          <label className="home-field">
            <span>Contrasena</span>
            <div className="home-field__control">
              <input
                autoComplete={isRegister ? "new-password" : "current-password"}
                minLength={isRegister ? 8 : undefined}
                placeholder="Minimo 8 caracteres"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </label>

          {isRegister && (
            <div className="home-auth-player">
              <div className="home-auth-player__grid">
                <label className="home-field">
                  <span>gameName</span>
                  <div className="home-field__control">
                    <Search size={17} aria-hidden="true" />
                    <input
                      placeholder="TenZ"
                      value={gameName}
                      onChange={(event) => {
                        setGameName(event.target.value);
                        setSelectedPlayer(null);
                      }}
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
                      onChange={(event) => {
                        setTagLine(event.target.value);
                        setSelectedPlayer(null);
                      }}
                    />
                  </div>
                </label>
              </div>

              <div className="home-auth-player__selected">
                <Check size={16} aria-hidden="true" />
                <span>{selectedPlayerName}</span>
              </div>

              {isSearching && (
                <LoadingModal placement="section" />
              )}

              {!isSearching && playerResults.length > 0 && (
                <ul className="home-auth-player__results">
                  {playerResults.map((player) => (
                    <li key={player.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPlayer(player);
                          setPlayerResults([]);
                        }}
                      >
                        <strong>{player.displayName}</strong>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && (
            <div className="home-auth-error" role="alert">
              {error}
            </div>
          )}

          <button
            className="home-search-button home-auth-submit"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting
              ? "Procesando..."
              : isRegister
                ? "Crear cuenta"
                : "Entrar"}
          </button>
        </form>
      </section>
    </div>
  );
}
