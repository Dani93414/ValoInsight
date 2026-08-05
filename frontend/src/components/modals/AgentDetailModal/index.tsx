import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as ReTooltip,
  CartesianGrid,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { useLocation } from "react-router-dom";
import LoadingModal from "../../ui/LoadingModal";
import {
  formatNumber,
  formatPercent,
  formatDate,
} from "../../../utils/formatters";
import {
  RECHARTS_TOOLTIP_CLAMP_VIEWBOX,
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
} from "../../../utils/tooltipPositioning";
import type { AgentContent } from "../../../types/agents";
import type { AnalyticsMatch } from "../../../types/dashboard";
import type { AgentDerivedStats } from "./useAgentDetailStats";
import { useAgentDetailStats } from "./useAgentDetailStats";
import "../DetailModals.css";

type Props = {
  agentId: string;
  analyticsList: AnalyticsMatch[];
  agentNameMap: Record<string, string>;
  onClose: () => void;
};

type SideStats = ReturnType<typeof useAgentDetailStats>["sideStats"];
type MiniChartData = ReturnType<typeof useAgentDetailStats>["miniChartData"];
type RadarData = ReturnType<typeof useAgentDetailStats>["radarData"];
type MultikillData = ReturnType<typeof useAgentDetailStats>["multikillData"];

function AgentModalHeader({
  agentContent,
  displayName,
  onViewAgent,
}: {
  agentContent: AgentContent | null;
  displayName: string;
  onViewAgent: () => void;
}) {
  return (
    <div className="modal-header-block">
      <div className="agent-modal-header">
        {agentContent?.displayIcon && (
          <img
            src={agentContent.displayIcon}
            alt={displayName}
            className="agent-modal-portrait"
          />
        )}
        <div>
          <span className="stats-eyebrow">Agente</span>
          <h2 className="stats-title modal-title-small">{displayName}</h2>
          <p className="stats-subtitle">
            {agentContent?.role?.displayName ?? "Rol desconocido"}
          </p>
        </div>
      </div>

      <button type="button" className="detail-view-btn" onClick={onViewAgent}>
        Ver el agente
      </button>
    </div>
  );
}

function AgentKpis({ stats }: { stats: AgentDerivedStats }) {
  const kpis = [
    ["Partidas", formatNumber(stats.matches)],
    ["Victorias", formatNumber(stats.wins)],
    ["Win Rate", formatPercent(stats.winRate, 1)],
    ["KD", formatNumber(stats.kd, 2)],
    ["KDA", formatNumber(stats.kda, 2)],
    ["ACS medio", formatNumber(stats.acsAvg, 1)],
  ];

  return (
    <div className="stats-kpis modal-kpis">
      {kpis.map(([label, value]) => (
        <div className="kpi-card" key={label}>
          <span className="kpi-label">{label}</span>
          <strong className="kpi-value">{value}</strong>
        </div>
      ))}
    </div>
  );
}

function AgentSummary({ stats }: { stats: AgentDerivedStats }) {
  const items = [
    ["Kills / partida", formatNumber(stats.killsPerMatch, 2)],
    ["Deaths / partida", formatNumber(stats.deathsPerMatch, 2)],
    ["Assists / partida", formatNumber(stats.assistsPerMatch, 2)],
    ["ADR medio", formatNumber(stats.adrAvg, 1)],
    ["Headshot %", formatPercent(stats.hsAvg, 1)],
    ["ACS medio", formatNumber(stats.acsAvg, 1)],
    ["Supervivencia", formatPercent(stats.survivalRate, 1)],
    ["Tasa Multikill", formatPercent(stats.multikillRate, 1)],
  ];

  return (
    <section className="detail-card detail-card-half">
      <PanelHeader
        title="Resumen con este agente"
        subtitle="Métricas acumuladas del jugador usando este agente."
      />
      <div className="summary-grid">
        {items.map(([label, value]) => (
          <div className="summary-item" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
        <div className="summary-item">
          <span>Diff. Daño / ronda</span>
          <strong
            className={
              stats.damageDeltaPerRound >= 0 ? "text-positive" : "text-negative"
            }
          >
            {stats.damageDeltaPerRound >= 0 ? "+" : ""}
            {formatNumber(stats.damageDeltaPerRound, 1)}
          </strong>
        </div>
      </div>
    </section>
  );
}

function AcsTrend({
  chartsReady,
  miniChartData,
  recentCount,
}: {
  chartsReady: boolean;
  miniChartData: MiniChartData;
  recentCount: number;
}) {
  return (
    <section className="detail-card detail-card-half">
      <PanelHeader
        title="Tendencia de ACS"
        subtitle={`Últimas ${recentCount} partidas con este agente (de más antigua a más reciente).`}
      />
      <div className="modal-chart-box modal-chart-box--tall">
        {miniChartData.length > 0 ? (
          chartsReady ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart
                data={miniChartData}
                margin={{ top: 10, right: 14, bottom: 4, left: -6 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="shortName" tick={{ fill: "#b5b5b5", fontSize: 13, fontWeight: 700 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#b5b5b5", fontSize: 12 }} axisLine={false} tickLine={false} domain={["dataMin - 20", "dataMax + 20"]} />
                <ReTooltip
                  contentStyle={tooltipStyle}
                  allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX}
                  wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                  formatter={(value: unknown, _name: unknown, props: unknown) => {
                    const p = (props as { payload?: { name?: string; result?: string } })?.payload;
                    return [`ACS: ${value}  ·  ${p?.result ?? ""}`, p?.name ?? ""];
                  }}
                  labelFormatter={() => ""}
                />
                <Line type="monotone" dataKey="acs" stroke="#ff4655" strokeWidth={2.5} dot={{ r: 4, fill: "#ff4655", strokeWidth: 0 }} activeDot={{ r: 6, fill: "#ff7a85", strokeWidth: 0 }} isAnimationActive={false} />
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
  );
}

function OpeningDuels({ stats }: { stats: AgentDerivedStats }) {
  const items = [
    ["FK / partida", formatNumber(stats.fkPerMatch, 2)],
    ["FD / partida", formatNumber(stats.fdPerMatch, 2)],
    ["FK/FD ratio", formatNumber(stats.fkfdRatio, 2)],
    ["Duelo Win %", formatPercent(stats.openingDuelWinPct, 1)],
    ["Trade kills / partida", formatNumber(stats.tradeKillsPerMatch, 2)],
    ["Clutch Win Rate", formatPercent(stats.clutchWinRate, 1)],
  ];

  return (
    <section className="detail-card detail-card-half">
      <PanelHeader
        title="Duelos iniciales"
        subtitle="First kills, first deaths y eficiencia de apertura."
      />
      <div className="summary-grid summary-grid--compact">
        {items.map(([label, value]) => (
          <div className="summary-item" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function TacticalProfile({
  chartsReady,
  radarData,
}: {
  chartsReady: boolean;
  radarData: RadarData;
}) {
  return (
    <section className="detail-card detail-card-half">
      <PanelHeader
        title="Perfil táctico"
        subtitle="Valoración porcentual en diferentes áreas tácticas."
      />
      <div className="modal-chart-box modal-chart-box--radar">
        {chartsReady ? (
          <ResponsiveContainer width="100%" height={310}>
            <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="72%">
              <PolarGrid stroke="rgba(255,255,255,0.08)" />
              <PolarAngleAxis dataKey="metric" tick={{ fill: "#c0c0c0", fontSize: 12, fontWeight: 600 }} />
              <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="value" stroke="#ff4655" fill="#ff4655" fillOpacity={0.2} strokeWidth={2} isAnimationActive={false} />
              <ReTooltip
                contentStyle={tooltipStyle}
                allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                formatter={(_value: unknown, _name: unknown, props: unknown) => {
                  const p = (props as { payload?: { real?: string } })?.payload;
                  return [p?.real ?? `${Number(_value).toFixed(1)}%`, ""];
                }}
              />
            </RadarChart>
          </ResponsiveContainer>
        ) : (
          <LoadingModal placement="section" />
        )}
      </div>
    </section>
  );
}

function SideComparison({ sideStats }: { sideStats: SideStats }) {
  const rows = [
    ["KD", formatNumber(sideStats.atkKD, 2), formatNumber(sideStats.defKD, 2)],
    ["ADR", formatNumber(sideStats.atkADR, 1), formatNumber(sideStats.defADR, 1)],
    ["Win Rate", formatPercent(sideStats.atkWinPct, 1), formatPercent(sideStats.defWinPct, 1)],
    ["FK / ronda", formatNumber(sideStats.atkFKPerRound, 2), formatNumber(sideStats.defFKPerRound, 2)],
  ];

  return (
    <section className="detail-card detail-card-large">
      <PanelHeader
        title="Ataque vs Defensa"
        subtitle="Rendimiento comparado por lado en las partidas con este agente."
      />
      <div className="side-comparison">
        <div className="side-comparison-header">
          <span className="side-comp-metric"></span>
          <span className="side-comp-side side-comp-side--atk">Ataque</span>
          <span className="side-comp-side side-comp-side--def">Defensa</span>
        </div>
        {rows.map(([label, attack, defense]) => (
          <div className="side-comparison-row" key={label}>
            <span className="side-comp-metric">{label}</span>
            <span className="side-comp-value">{attack}</span>
            <span className="side-comp-value">{defense}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Multikills({
  chartsReady,
  multikillData,
}: {
  chartsReady: boolean;
  multikillData: MultikillData;
}) {
  if (multikillData.length === 0) return null;

  return (
    <section className="detail-card">
      <PanelHeader
        title="Multikills"
        subtitle="Rondas con 2 o más kills acumuladas con este agente."
      />
      <div className="modal-chart-box">
        {chartsReady ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={multikillData} margin={{ top: 10, right: 20, bottom: 4, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="label" tick={{ fill: "#b5b5b5", fontSize: 13, fontWeight: 700 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#b5b5b5", fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
              <ReTooltip contentStyle={tooltipStyle} allowEscapeViewBox={RECHARTS_TOOLTIP_CLAMP_VIEWBOX} wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE} />
              <Bar dataKey="value" name="Rondas" radius={[6, 6, 0, 0]} barSize={32} isAnimationActive={false}>
                {multikillData.map((data) => (
                  <Cell key={data.label} fill={data.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <LoadingModal placement="section" />
        )}
      </div>
    </section>
  );
}

function RecentMatches({ recentMatches }: { recentMatches: AnalyticsMatch[] }) {
  return (
    <section className="detail-card detail-card-full">
      <PanelHeader
        title="Últimas partidas con este agente"
        subtitle="Vista rápida de rendimiento reciente."
      />
      <div className="mini-match-list">
        {recentMatches.length > 0 ? (
          recentMatches.map((match) => {
            const kills = match.player_totals_from_match?.kills ?? match.overview?.kills ?? 0;
            const deaths = match.player_totals_from_match?.deaths ?? match.overview?.deaths ?? 0;
            const assists = match.player_totals_from_match?.assists ?? match.overview?.assists ?? 0;
            const won = match.won_match;

            return (
              <div
                key={match.match_id ?? `${match.game_start_millis}`}
                className={`mini-match-item ${won ? "mini-match-item--win" : "mini-match-item--loss"}`}
              >
                <div>
                  <strong>{match.map_name ?? "Mapa desconocido"}</strong>
                  <small>{formatDate(match.game_start_millis)}</small>
                </div>
                <div className="mini-match-metrics">
                  <span className={won ? "badge-win" : "badge-loss"}>
                    {won ? "Victoria" : "Derrota"}
                  </span>
                  <span>
                    {kills}/{deaths}/{assists}
                  </span>
                  <span>ACS {formatNumber(match.overview?.acs, 1)}</span>
                </div>
              </div>
            );
          })
        ) : (
          <div className="empty-chart">No hay partidas con este agente.</div>
        )}
      </div>
    </section>
  );
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="panel-header">
      <div>
        <h3 className="panel-title">{title}</h3>
        <p className="panel-subtitle">{subtitle}</p>
      </div>
    </div>
  );
}

const tooltipStyle = {
  background: "rgba(20,22,28,0.95)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "10px",
  fontSize: "0.85rem",
};

export default function AgentDetailModal({
  agentId,
  analyticsList,
  agentNameMap,
  onClose,
}: Props) {
  const location = useLocation();
  const [chartsReady, setChartsReady] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setChartsReady(true);
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  const {
    navigate,
    loading,
    agentContent,
    stats,
    recentMatches,
    miniChartData,
    radarData,
    sideStats,
    hasSideData,
    multikillData,
    displayName,
  } = useAgentDetailStats({ agentId, analyticsList, agentNameMap });

  if (loading) {
    return <LoadingModal placement="overlay" />;
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel agent-modal-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Cerrar modal">
          ×
        </button>

        <AgentModalHeader
          agentContent={agentContent}
          displayName={displayName}
          onViewAgent={() => {
            onClose();
            navigate("/agentes", {
              state: {
                agentName: displayName,
                returnTo: `${location.pathname}${location.search}${location.hash}`,
                returnLabel: "Volver",
              },
            });
          }}
        />

        <AgentKpis stats={stats} />

        <div className="detail-grid">
          <AgentSummary stats={stats} />
          <AcsTrend
            chartsReady={chartsReady}
            miniChartData={miniChartData}
            recentCount={recentMatches.length}
          />
          <OpeningDuels stats={stats} />
          <TacticalProfile chartsReady={chartsReady} radarData={radarData} />
          {hasSideData && <SideComparison sideStats={sideStats} />}
          <Multikills chartsReady={chartsReady} multikillData={multikillData} />
          <RecentMatches recentMatches={recentMatches} />
        </div>
      </div>
    </div>
  );
}
