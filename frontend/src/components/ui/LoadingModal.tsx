import { useState } from "react";
import "./LoadingModal.css";

export type LoadingModalPlacement = "section" | "overlay";

type LoadingModalProps = {
  placement?: LoadingModalPlacement;
  className?: string;
};

const VALORANT_LOADING_PHRASES = [
  "Preparando la siguiente ronda...",
  "Comprobando cada esquina...",
  "Coordinando la entrada al site...",
  "Ajustando la mira antes del combate...",
  "Analizando la economía del equipo...",
  "Esperando a que caiga la barrera...",
  "Recopilando información del mapa...",
  "Planeando la mejor ejecución...",
];

export default function LoadingModal({
  placement = "section",
  className = "",
}: LoadingModalProps) {
  const [phrase] = useState(
    () => VALORANT_LOADING_PHRASES[Math.floor(Math.random() * VALORANT_LOADING_PHRASES.length)],
  );

  return (
    <div
      className={`loading-modal loading-modal--${placement} ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Cargando"
    >
      <div className="loading-modal__card">
        <div className="loading-modal__mascot" aria-hidden="true">
          <img
            className="loading-modal__mascot-image"
            src="/content/loader/Mosh_Image.png"
            alt=""
            draggable="false"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        </div>
        <span className="loading-modal__label">Cargando</span>
        <span className="loading-modal__phrase">{phrase}</span>
      </div>
    </div>
  );
}
