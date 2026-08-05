import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { usePlayerDashboard } from "../api/hooks";
import BackButton from "../components/BackButton";
import FloatingActionButton from "../components/FloatingActionButton";
import PageLoadingScreen from "../components/ui/PageLoadingScreen";
import HeatmapModal, {
  type HeatmapEntryFilters,
} from "../components/modals/HeatmapModal";
import type { DashboardPayload } from "../types/dashboard";
import "./Estadisticas.scss";

function parseSeasonIds(rawValue: string | null): string[] | undefined {
  if (!rawValue) return undefined;
  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function parseSide(
  rawValue: string | null,
): "" | "attack" | "defense" | undefined {
  if (!rawValue) return undefined;
  if (rawValue === "attack" || rawValue === "defense") return rawValue;
  return "";
}

export default function HeatmapPage() {
  const { playerId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const { data: dashboardRaw, isLoading: loading } =
    usePlayerDashboard(playerId);
  const dashboard = (dashboardRaw as DashboardPayload) ?? null;

  const initialFilters = useMemo<HeatmapEntryFilters>(
    () => ({
      mapId: searchParams.get("mapId") ?? undefined,
      mapName: searchParams.get("mapName") ?? undefined,
      agentId: searchParams.get("agentId") ?? undefined,
      seasonIds: parseSeasonIds(searchParams.get("seasonIds")),
      side: parseSide(searchParams.get("side")),
    }),
    [searchParams],
  );

  if (!playerId) {
    return (
      <div className="stats-container">
        <BackButton />
        <div className="empty-panel">
          No se encontro el jugador para el heatmap.
        </div>
      </div>
    );
  }

  if (loading) {
    return <PageLoadingScreen />;
  }

  if (!dashboard) {
    return (
      <div className="stats-container">
        <BackButton />
        <div className="empty-panel">
          No se pudieron cargar los datos para mostrar el heatmap.
        </div>
      </div>
    );
  }

  return (
    <div className="stats-container heatmap-page-container">
      <FloatingActionButton
        label="Volver"
        onClick={() => navigate(`/estadisticas/${playerId}`)}
        ariaLabel="Volver a estadisticas"
      />

      <section className="heatmap-page-header">
        <div className="heatmap-page-heading">
          <span className="stats-eyebrow">Valorant</span>
          <h1 className="heatmap-page-title">Rendimiento en mapas</h1>
          <p className="heatmap-page-subtitle">
            Explora el visor completo de heatmaps con tus filtros iniciales y
            ajusta cualquier parametro en tiempo real.
          </p>
        </div>
      </section>

      <HeatmapModal
        mode="page"
        startWithSetup={false}
        playerId={playerId}
        agentNameMap={dashboard.agentNameMap}
        actOptions={dashboard.actOptions ?? []}
        initialFilters={initialFilters}
      />
    </div>
  );
}
