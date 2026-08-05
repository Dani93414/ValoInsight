import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import type { AnalyticsMatch } from "../../../types/dashboard";
import LoadingModal from "../../ui/LoadingModal";
import { formatNumber, formatPercent } from "../../../utils/formatters";
import {
  RECHARTS_TOOLTIP_CLAMP_VIEWBOX,
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
} from "../../../utils/tooltipPositioning";
import { useMapDetailStats } from "./useMapDetailStats";
import "../DetailModals.css";

type Props = {
  mapName: string;
  mapImage?: string | null;
  analyticsList: AnalyticsMatch[];
  onOpenHeatmap: (mapName: string) => void;
  onClose: () => void;
};

const TOOLTIP_STYLE = {
  background: "rgba(20,22,28,0.95)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "10px",
  fontSize: "0.85rem",
};

export default function MapDetailModal({
  mapName,
  mapImage,
  analyticsList,
  onOpenHeatmap,
  onClose,
}: Props) {
  const [chartsReady, setChartsReady] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setChartsReady(true);
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  const {
    stats,
    primaryInsight,
    recentTrendData,
    sideRows,
    topAgentsData,
    topWeaponsData,
    hasSideData,
  } = useMapDetailStats({ mapName, analyticsList });

  const agentsChartData = topAgentsData.map((entry) => ({
    ...entry,
    color: "#ff4655",
  }));
  const weaponsChartData = topWeaponsData.map((entry) => ({
    ...entry,
    color: "#64a0ff",
  }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel map-detail-modal-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose}>
          ✕
        </button>

        <div className="modal-header-block">
          <div className="map-detail-header">
            {mapImage ? (
              <img src={mapImage} alt={mapName} className="match-map-banner" />
            ) : (
              <div className="match-map-banner map-detail-banner-placeholder">
                {mapName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="map-detail-header-copy">
              <span className="stats-eyebrow">Mapa</span>
              <h2 className="stats-title modal-title-small">{mapName}</h2>
              <p className="stats-subtitle">
                Rendimiento agregado del jugador con los filtros actuales.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="detail-view-btn"
            onClick={() => onOpenHeatmap(mapName)}
          >
            Abrir heatmap
          </button>
        </div>

        {stats.matches === 0 ? (
          <div className="empty-chart">
            Sin datos suficientes para este mapa.
          </div>
        ) : (
          <>
            <div className="stats-kpis modal-kpis">
              <div className="kpi-card">
                <span className="kpi-label">Partidas</span>
                <strong className="kpi-value">
                  {formatNumber(stats.matches)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Victorias</span>
                <strong className="kpi-value">
                  {formatNumber(stats.wins)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Win Rate</span>
                <strong className="kpi-value">
                  {formatPercent(stats.winRate, 1)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">KD</span>
                <strong className="kpi-value">
                  {formatNumber(stats.kd, 2)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">ACS medio</span>
                <strong className="kpi-value">
                  {formatNumber(stats.acsAvg, 1)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Headshot</span>
                <strong className="kpi-value">
                  {formatPercent(stats.hsPct, 1)}
                </strong>
              </div>
            </div>

            <div className="detail-grid">
              <section className="detail-card detail-card-full">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Resumen del mapa</h3>
                    <p className="panel-subtitle">
                      Datos globales e insight principal en este escenario.
                    </p>
                  </div>
                </div>

                <div className="map-insight-banner">{primaryInsight}</div>

                <div className="summary-grid summary-grid--compact">
                  <div className="summary-item">
                    <span>Derrotas</span>
                    <strong>{formatNumber(stats.losses)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>KDA</span>
                    <strong>{formatNumber(stats.kda, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>ADR medio</span>
                    <strong>{formatNumber(stats.adrAvg, 1)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Kills / partida</span>
                    <strong>{formatNumber(stats.killsPerMatch, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Deaths / partida</span>
                    <strong>{formatNumber(stats.deathsPerMatch, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Assists / partida</span>
                    <strong>{formatNumber(stats.assistsPerMatch, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Trade kills / partida</span>
                    <strong>{formatNumber(stats.tradeKillsPerMatch, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>First bloods / partida</span>
                    <strong>{formatNumber(stats.firstKillsPerMatch, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Rondas jugadas</span>
                    <strong>{formatNumber(stats.rounds)}</strong>
                  </div>
                </div>
              </section>

              <section className="detail-card detail-card-half">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Tendencia reciente</h3>
                    <p className="panel-subtitle">
                      Últimas {recentTrendData.length} partidas en este mapa.
                    </p>
                  </div>
                </div>
                <div className="modal-chart-box modal-chart-box--tall">
                  {recentTrendData.length > 0 ? (
                    chartsReady ? (
                      <ResponsiveContainer width="100%" height={300}>
                        <LineChart
                          data={recentTrendData}
                          margin={{ top: 10, right: 14, bottom: 4, left: -6 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="rgba(255,255,255,0.06)"
                          />
                          <XAxis
                            dataKey="shortLabel"
                            tick={{
                              fill: "#b5b5b5",
                              fontSize: 13,
                              fontWeight: 700,
                            }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            tick={{ fill: "#b5b5b5", fontSize: 12 }}
                            axisLine={false}
                            tickLine={false}
                            domain={["dataMin - 20", "dataMax + 20"]}
                          />
                          <ReTooltip
                            contentStyle={TOOLTIP_STYLE}
                            formatter={(
                              value: unknown,
                              _name: unknown,
                              props: unknown,
                            ) => {
                              const payload = (
                                props as {
                                  payload?: { won?: boolean; label?: string };
                                }
                              )?.payload;
                              return [
                                `ACS: ${formatNumber(Number(value), 1)} · ${payload?.won ? "Victoria" : "Derrota"}`,
                                payload?.label ?? "",
                              ];
                            }}
                            labelFormatter={() => ""}
                            allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX}
                            wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                          />
                          <Line
                            type="monotone"
                            dataKey="acs"
                            stroke="#ff4655"
                            strokeWidth={2.5}
                            dot={{ r: 4, fill: "#ff4655", strokeWidth: 0 }}
                            activeDot={{
                              r: 6,
                              fill: "#ff7a85",
                              strokeWidth: 0,
                            }}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <LoadingModal placement="section" />
                    )
                  ) : (
                    <div className="empty-chart">Sin suficientes partidas.</div>
                  )}
                </div>
              </section>

              <section className="detail-card detail-card-half">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Ataque vs defensa</h3>
                    <p className="panel-subtitle">
                      Comparativa de rendimiento por lado usando las rondas del
                      mapa filtrado.
                    </p>
                  </div>
                </div>

                {hasSideData ? (
                  <div className="side-comparison">
                    <div className="side-comparison-header">
                      <span className="side-comp-metric">Metrica</span>
                      <span className="side-comp-side side-comp-side--atk">
                        Ataque
                      </span>
                      <span className="side-comp-side side-comp-side--def">
                        Defensa
                      </span>
                    </div>

                    {sideRows.map((row) => (
                      <div key={row.label} className="side-comparison-row">
                        <span className="side-comp-metric">{row.label}</span>
                        <span className="side-comp-value">
                          {row.kind === "percent"
                            ? formatPercent(row.attackValue, row.decimals ?? 1)
                            : formatNumber(row.attackValue, row.decimals ?? 0)}
                        </span>
                        <span className="side-comp-value">
                          {row.kind === "percent"
                            ? formatPercent(row.defenseValue, row.decimals ?? 1)
                            : formatNumber(row.defenseValue, row.decimals ?? 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-chart">
                    Sin desglose de lados para este mapa.
                  </div>
                )}
              </section>

              <section className="detail-card detail-card-half">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Agentes en este mapa</h3>
                    <p className="panel-subtitle">
                      Tus agentes más usados aquí con contexto de win rate y
                      ACS.
                    </p>
                  </div>
                </div>
                <div className="modal-chart-box">
                  {agentsChartData.length > 0 ? (
                    chartsReady ? (
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart
                          data={agentsChartData}
                          margin={{ top: 10, right: 14, bottom: 6, left: -16 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="rgba(255,255,255,0.06)"
                          />
                          <XAxis
                            dataKey="shortName"
                            tick={{
                              fill: "#b5b5b5",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            tick={{ fill: "#b5b5b5", fontSize: 11 }}
                            axisLine={false}
                            tickLine={false}
                            allowDecimals={false}
                          />
                          <ReTooltip
                            contentStyle={TOOLTIP_STYLE}
                            formatter={(
                              value: unknown,
                              _name: unknown,
                              props: unknown,
                            ) => {
                              const payload = (
                                props as {
                                  payload?: {
                                    name?: string;
                                    winRate?: number;
                                    acsAvg?: number;
                                  };
                                }
                              )?.payload;
                              return [
                                `${formatNumber(Number(value))} partidas · ${formatPercent(payload?.winRate ?? 0, 1)} WR · ${formatNumber(payload?.acsAvg ?? 0, 1)} ACS`,
                                payload?.name ?? "",
                              ];
                            }}
                            labelFormatter={() => ""}
                            allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX}
                            wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                          />
                          <Bar
                            dataKey="matches"
                            radius={[6, 6, 0, 0]}
                            isAnimationActive={false}
                          >
                            {agentsChartData.map((item) => (
                              <Cell key={item.name} fill={item.color} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <LoadingModal placement="section" />
                    )
                  ) : (
                    <div className="empty-chart">
                      Sin datos de agentes para este mapa.
                    </div>
                  )}
                </div>
              </section>

              <section className="detail-card detail-card-half">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Armas más efectivas</h3>
                    <p className="panel-subtitle">
                      Armas con más kills acumuladas en este mapa.
                    </p>
                  </div>
                </div>
                <div className="modal-chart-box">
                  {weaponsChartData.length > 0 ? (
                    chartsReady ? (
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart
                          data={weaponsChartData}
                          margin={{ top: 10, right: 14, bottom: 6, left: -16 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="rgba(255,255,255,0.06)"
                          />
                          <XAxis
                            dataKey="shortName"
                            tick={{
                              fill: "#b5b5b5",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            tick={{ fill: "#b5b5b5", fontSize: 11 }}
                            axisLine={false}
                            tickLine={false}
                            allowDecimals={false}
                          />
                          <ReTooltip
                            contentStyle={TOOLTIP_STYLE}
                            formatter={(
                              value: unknown,
                              _name: unknown,
                              props: unknown,
                            ) => {
                              const payload = (
                                props as {
                                  payload?: {
                                    name?: string;
                                    matches?: number;
                                    headshotPct?: number;
                                  };
                                }
                              )?.payload;
                              return [
                                `${formatNumber(Number(value))} kills · ${formatNumber(payload?.matches ?? 0)} partidas · ${formatPercent(payload?.headshotPct ?? 0, 1)} HS`,
                                payload?.name ?? "",
                              ];
                            }}
                            labelFormatter={() => ""}
                            allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX}
                            wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                          />
                          <Bar
                            dataKey="kills"
                            radius={[6, 6, 0, 0]}
                            isAnimationActive={false}
                          >
                            {weaponsChartData.map((item) => (
                              <Cell key={item.name} fill={item.color} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <LoadingModal placement="section" />
                    )
                  ) : (
                    <div className="empty-chart">
                      Sin datos de armas para este mapa.
                    </div>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
