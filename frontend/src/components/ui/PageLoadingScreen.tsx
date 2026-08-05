import { useEffect, useState } from "react";
import "./PageLoadingScreen.css";

const PAGE_LOADING_PHRASES = [
  "Preparando la siguiente ronda...",
  "Comprobando cada esquina...",
  "Coordinando la entrada al site...",
  "Ajustando la mira antes del combate...",
  "Analizando la economía del equipo...",
  "Esperando a que caiga la barrera...",
  "Recopilando información del mapa...",
  "Planeando la mejor ejecución...",
];

function getRandomPhrase(previous?: string) {
  const available = PAGE_LOADING_PHRASES.filter((phrase) => phrase !== previous);
  return available[Math.floor(Math.random() * available.length)] ?? PAGE_LOADING_PHRASES[0];
}

export default function PageLoadingScreen() {
  const [phrase, setPhrase] = useState(() => getRandomPhrase());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setPhrase((current) => getRandomPhrase(current));
    }, 2400);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <main
      className="page-loading-screen"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Cargando página"
    >
      <div className="page-loading-screen__ambient" aria-hidden="true" />
      <section className="page-loading-screen__content">
        <span className="page-loading-screen__eyebrow">ValoInsight</span>
        <video
          className="page-loading-screen__video"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = 1.5;
          }}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        >
          <source src="/content/loader/wingman-side-clear-loader.webm" type="video/webm" />
        </video>
        <h1>Cargando</h1>
        <p key={phrase}>{phrase}</p>
        <div className="page-loading-screen__progress" aria-hidden="true">
          <span />
        </div>
      </section>
    </main>
  );
}
