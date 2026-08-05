import type { CSSProperties, MouseEvent } from "react";
import { GitCompare } from "lucide-react";
import { formatNumber, formatPercent } from "../../../utils/formatters";
import { getAgentThemeColors } from "../domain/agentThemeColors";
import type { EnrichedAgent } from "../types";

type Props = {
  agent: EnrichedAgent;
  active: boolean;
  compared: boolean;
  compareDisabled: boolean;
  onSelect: (agent: EnrichedAgent) => void;
  onToggleCompare: (agent: EnrichedAgent) => void;
  style?: CSSProperties;
};

export function AgentCard({
  agent,
  active,
  compared,
  compareDisabled,
  onSelect,
  onToggleCompare,
  style,
}: Props) {
  const picks = agent.globalStats?.picks ?? 0;
  const hasStats = picks > 0;
  const [accent, accent2, accent3] = getAgentThemeColors(
    agent.displayName,
    agent.backgroundGradientColors,
  );
  const cardStyle = {
    ...style,
    "--agent-accent": accent,
    "--agent-accent-2": accent2,
    "--agent-accent-3": accent3,
  } as CSSProperties;

  const handleCompareClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!compared && compareDisabled) return;
    onToggleCompare(agent);
  };

  return (
    <button
      type="button"
      className={`agent-card ${active ? "active" : ""}`}
      onClick={() => onSelect(agent)}
      aria-pressed={active}
      style={cardStyle}
    >
      <span className={`agent-tier-badge agent-tier-badge--${agent.tier.toLowerCase()}`}>
        Tier {agent.tier}
      </span>

      <span
        className={`agent-compare-action${compared ? " agent-compare-action--active" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={compared ? "Quitar agente de comparación" : "Añadir agente a comparación"}
        aria-disabled={!compared && compareDisabled}
        onClick={handleCompareClick}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (!compared && compareDisabled) return;
          onToggleCompare(agent);
        }}
      >
        <GitCompare size={15} aria-hidden="true" />
        <span className="agent-compare-tooltip" role="tooltip">
          {compared ? "Quitar de la comparación" : "Añadir a la comparación"}
        </span>
      </span>

      {!hasStats && (
        <span className="agent-unavailable-badge">Agente sin salir</span>
      )}

      {agent.displayIcon && (
        <div className="agent-image-frame">
          <img
            src={agent.displayIcon}
            alt={agent.displayName}
            className="agent-image"
            loading="lazy"
          />
        </div>
      )}

      <div className="agent-card-body">
        <h2 className="agent-name">{agent.displayName}</h2>
        <p className="agent-role">{agent.role.displayName}</p>
        {hasStats && <div className="agent-score-line">
          <span>Score</span>
          <strong>{formatNumber(agent.score, 1)}</strong>
          {agent.lowSample && <em>Baja muestra</em>}
        </div>}
        {hasStats && <div className="agent-card-metrics">
          <div>
            <span>Pick Rate</span>
            <strong>{hasStats ? formatPercent(agent.globalStats?.pick_rate) : "-"}</strong>
          </div>
          <div>
            <span>Win Rate</span>
            <strong>{hasStats ? formatPercent(agent.globalStats?.win_rate) : "-"}</strong>
          </div>
        </div>}
      </div>
    </button>
  );
}
