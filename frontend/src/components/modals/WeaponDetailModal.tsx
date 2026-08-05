import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { useLocation, useNavigate } from "react-router-dom";
import LoadingModal from "../ui/LoadingModal";
import {
  formatNumber,
  formatPercent,
} from "../../utils/formatters";
import {
  RECHARTS_TOOLTIP_CLAMP_VIEWBOX,
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
} from "../../utils/tooltipPositioning";
import type { AnalyticsMatch } from "../../types/dashboard";
import {
  calculateWeaponStats,
  type WeaponTimelinePoint,
} from "./WeaponDetailModalUtils";
import "./DetailModals.css";

type Props = {
  weaponId: string;
  weaponName: string;
  weaponImage?: string | null;
  analyticsList: AnalyticsMatch[];
  onClose: () => void;
};

export default function WeaponDetailModal({
  weaponId,
  weaponName,
  weaponImage,
  analyticsList,
  onClose,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [chartsReady, setChartsReady] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setChartsReady(true);
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  const stats = useMemo(
    () => calculateWeaponStats(analyticsList, weaponId),
    [analyticsList, weaponId],
  );

  const timelineHasData = stats.recentTimeline.length > 0;
  const shotHasData = stats.shotData.some((item) => item.value > 0);
  const visibleShotData = stats.shotData.filter((item) => item.value > 0);
  const totalShotImpacts = stats.shotData.reduce(
    (sum, item) => sum + item.value,
    0,
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel weapon-modal-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose}>
          ✕
        </button>

        <div className="modal-header-block">
          <div className="weapon-modal-header">
            {weaponImage ? (
              <img
                src={weaponImage}
                alt={weaponName}
                className="weapon-modal-icon"
              />
            ) : (
              <div className="weapon-modal-icon weapon-modal-icon-placeholder">
                {weaponName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <span className="stats-eyebrow">Arma</span>
              <h2 className="stats-title modal-title-small">{weaponName}</h2>
              <p className="stats-subtitle">
                Rendimiento agregado con los filtros actuales.
              </p>
              <span className="modal-sample-badge">{stats.sampleReliability}</span>
            </div>
          </div>

          <button
            type="button"
            className="detail-view-btn"
            onClick={() => {
              onClose();
              navigate("/armas", {
                state: {
                  weaponName,
                  returnTo: `${location.pathname}${location.search}${location.hash}`,
                  returnLabel: "Volver",
                },
              });
            }}
          >
            Ver el arma
          </button>
        </div>

        {stats.matchesUsed === 0 ? (
          <div className="empty-chart weapon-modal-empty">
            <strong>Sin uso registrado</strong>
            <span>
              No hay rondas, kills ni impactos para esta arma con los filtros
              actuales.
            </span>
          </div>
        ) : (
          <>
            <div className="stats-kpis modal-kpis">
              <div className="kpi-card">
                <span className="kpi-label">Partidas con uso</span>
                <strong className="kpi-value">
                  {formatNumber(stats.matchesUsed)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Kills</span>
                <strong className="kpi-value">
                  {formatNumber(stats.kills)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">KD</span>
                <strong className="kpi-value">
                  {formatNumber(stats.kd, 2)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Headshot</span>
                <strong className="kpi-value">
                  {formatPercent(stats.headshotPct, 1)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Daño / ronda</span>
                <strong className="kpi-value">
                  {formatNumber(stats.damagePerRound, 1)}
                </strong>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Win rate</span>
                <strong className="kpi-value">
                  {formatPercent(stats.winRate, 1)}
                </strong>
              </div>
            </div>

            <div className="detail-grid">
              <section className="detail-card detail-card-full">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Resumen de rendimiento</h3>
                    <p className="panel-subtitle">
                      Uso, eficacia y precision con esta arma.
                    </p>
                  </div>
                </div>
                <div className="summary-grid summary-grid--compact">
                  <div className="summary-item">
                    <span>Rondas con arma</span>
                    <strong>{formatNumber(stats.rounds)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Kills / ronda</span>
                    <strong>{formatNumber(stats.killsPerRound, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>KDA</span>
                    <strong>{formatNumber(stats.kda, 2)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Asistencias</span>
                    <strong>{formatNumber(stats.assists)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Muertes</span>
                    <strong>{formatNumber(stats.deaths)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Daño total</span>
                    <strong>{formatNumber(stats.damageDealt)}</strong>
                  </div>
                </div>
              </section>

              <section className="detail-card detail-card-half">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Kills y deaths recientes</h3>
                    <p className="panel-subtitle">
                      Ultimas {stats.recentTimeline.length} partidas con esta
                      arma.
                    </p>
                  </div>
                </div>
                <div className="modal-chart-box">
                  {timelineHasData ? (
                    chartsReady ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart
                          data={stats.recentTimeline}
                          margin={{ top: 8, right: 12, bottom: 4, left: -16 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="rgba(255,255,255,0.06)"
                          />
                          <XAxis
                            dataKey="shortLabel"
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
                            labelFormatter={(label, payload) => {
                              const point =
                                Array.isArray(payload) && payload.length > 0
                                  ? (
                                      payload[0] as {
                                        payload?: WeaponTimelinePoint;
                                      }
                                    ).payload
                                  : undefined;
                              return `${String(label)} · HS ${formatPercent(point?.hsPct, 1)}`;
                            }}
                            formatter={(value, name) => [
                              `${formatNumber(Number(value))}`,
                              String(name),
                            ]}
                            contentStyle={{
                              background: "rgba(20,22,28,0.95)",
                              border: "1px solid rgba(255,255,255,0.1)",
                              borderRadius: "10px",
                              fontSize: "0.82rem",
                            }}
                            allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX}
                            wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                          />
                          <Bar
                            dataKey="kills"
                            name="Kills"
                            fill="#46c878"
                            radius={[4, 4, 0, 0]}
                            isAnimationActive={false}
                          />
                          <Bar
                            dataKey="deaths"
                            name="Deaths"
                            fill="#ff4655"
                            radius={[4, 4, 0, 0]}
                            isAnimationActive={false}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <LoadingModal placement="section" />
                    )
                  ) : (
                    <div className="empty-chart">Sin historial reciente.</div>
                  )}
                </div>
              </section>

              <section className="detail-card detail-card-half">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Distribucion de impactos</h3>
                    <p className="panel-subtitle">
                      Precisión por zona de impacto con esta arma.
                    </p>
                  </div>
                </div>
                <div className="modal-chart-box">
                  {shotHasData ? (
                    chartsReady ? (
                      <>
                        <ResponsiveContainer width="100%" height={220}>
                          <PieChart>
                            <Pie
                              data={visibleShotData}
                              dataKey="value"
                              nameKey="label"
                              innerRadius={44}
                              outerRadius={76}
                              paddingAngle={2}
                              stroke="none"
                              isAnimationActive={false}
                            >
                              {visibleShotData.map((item) => (
                                <Cell key={item.label} fill={item.color} />
                              ))}
                            </Pie>
                            <ReTooltip
                              formatter={(value, name) => [
                                `${formatNumber(Number(value))} impactos`,
                                String(name),
                              ]}
                              contentStyle={{
                                background: "rgba(20,22,28,0.95)",
                                border: "1px solid rgba(255,255,255,0.1)",
                                borderRadius: "10px",
                                fontSize: "0.82rem",
                              }}
                              allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX}
                              wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                            />
                          </PieChart>
                        </ResponsiveContainer>

                        <div className="weapon-shot-legend">
                          {visibleShotData.map((item) => (
                            <div
                              key={item.label}
                              className="weapon-shot-legend-item"
                            >
                              <span
                                className="weapon-shot-legend-dot"
                                style={{ background: item.color }}
                              />
                              <span className="weapon-shot-legend-label">
                                {item.label}
                              </span>
                              <span className="weapon-shot-legend-value">
                                {formatNumber(item.value)} ·{" "}
                                {formatPercent(
                                  totalShotImpacts > 0
                                    ? (item.value * 100) / totalShotImpacts
                                    : 0,
                                  1,
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <LoadingModal placement="section" />
                    )
                  ) : (
                    <div className="empty-chart">Sin datos de impactos.</div>
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
