import { useEffect, useId, useState, type CSSProperties } from "react";
import { ChevronDown, X } from "lucide-react";
import { ComparisonTable } from "../../../components/comparison/ComparisonTable";
import { formatNumber, formatPercent } from "../../../utils/formatters";
import type { AgentComparisonMetric, EnrichedAgent } from "../types";

type Props = {
  agent: EnrichedAgent;
  hasSession: boolean;
  onClose: () => void;
};

type GlobalStatConfig = {
  key: keyof NonNullable<EnrichedAgent["globalStats"]>;
  label: string;
  format: "number" | "percent";
};

const globalStatMaxByKey: Partial<
  Record<keyof NonNullable<EnrichedAgent["globalStats"]>, number>
> = {
  avg_kd: 1.5,
  avg_kda: 2.5,
  avg_acs: 300,
  avg_adr: 200,
  deaths_per_round: 1,
  trade_kills_per_round: 0.4,
};

const globalStatsConfig: GlobalStatConfig[] = [
  { key: "pick_rate", label: "Pick Rate", format: "percent" },
  { key: "win_rate", label: "Win Rate", format: "percent" },
  { key: "avg_kd", label: "KD medio", format: "number" },
  { key: "avg_kda", label: "KDA medio", format: "number" },
  { key: "avg_acs", label: "ACS medio", format: "number" },
  { key: "avg_adr", label: "ADR medio", format: "number" },
  { key: "avg_headshot_pct", label: "Headshot", format: "percent" },
  { key: "avg_fk_rate", label: "FK Rate", format: "percent" },
  { key: "kast_pct", label: "KAST", format: "percent" },
  { key: "trade_rate", label: "Trade rate", format: "percent" },
  { key: "assist_rate", label: "Assist rate", format: "percent" },
  { key: "avg_survival_rate", label: "Supervivencia", format: "percent" },
  { key: "avg_clutch_win_rate", label: "Clutch WR", format: "percent" },
];

function getDiffTone(metric: AgentComparisonMetric) {
  if (typeof metric.diff === "number") {
    const higherIsBetter = metric.higherIsBetter ?? true;
    const isPositive = higherIsBetter ? metric.diff >= 0 : metric.diff <= 0;
    return isPositive ? "positive" : "negative";
  }
  return "neutral";
}

function getNormalizedDiffTone(metric: AgentComparisonMetric) {
  if (typeof metric.normalizedDiff === "number") {
    const higherIsBetter = metric.higherIsBetter ?? true;
    const isPositive = higherIsBetter ? metric.normalizedDiff >= 0 : metric.normalizedDiff <= 0;
    return isPositive ? "positive" : "negative";
  }
  return "neutral";
}

function formatStatValue(value: number | undefined, format: "number" | "percent") {
  return format === "percent" ? formatPercent(value) : formatNumber(value, 2);
}

function normalizeGlobalStatBar(
  key: GlobalStatConfig["key"],
  value: number | undefined,
  format: GlobalStatConfig["format"],
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (format === "percent") return Math.max(0, Math.min(100, value));

  const max = globalStatMaxByKey[key] ?? 100;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

function getStatValue(agent: EnrichedAgent, key: GlobalStatConfig["key"]) {
  const value = agent.globalStats?.[key];
  return typeof value === "number" ? value : undefined;
}

function formatAbilitySlot(slot: string): string {
  const normalized = slot.trim().toLowerCase().replace(/[\s_-]/g, "");
  const labels: Record<string, string> = {
    grenade: "Habilidad de Compra",
    ability1: "Habilidad de Compra",
    ability2: "Habilidad Básica",
    signature: "Habilidad Básica",
    ultimate: "Ultimate",
    passive: "Pasiva",
  };

  if (labels[normalized]) return labels[normalized];
  return slot
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\bability\b/gi, "Habilidad")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function AgentInlineDetail({
  agent,
  hasSession,
  onClose,
}: Props) {
  const [activeAbilityIndex, setActiveAbilityIndex] = useState(0);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isAbilitiesOpen, setIsAbilitiesOpen] = useState(false);
  const [hiddenAbilityIcons, setHiddenAbilityIcons] = useState<Record<string, boolean>>({});
  const abilityTabsId = useId();
  const statsPanelId = useId();
  const abilitiesPanelId = useId();
  const stats = agent.globalStats;
  const hasStats = Boolean(stats && (stats.picks ?? stats.matches ?? 0) > 0);
  const showComparison =
    hasSession &&
    Boolean(agent.personalStats?.picks) &&
    agent.comparisonMetrics.length > 0;
  const activeAbility = agent.abilities?.[activeAbilityIndex] ?? agent.abilities?.[0];
  const visibleGlobalStats = globalStatsConfig.filter(
    (item) => getStatValue(agent, item.key) !== undefined,
  );
  const quickStats = [
    { label: "Score", value: formatNumber(agent.score, 1) },
    { label: "Tier", value: agent.tier },
    { label: "Pick Rate", value: formatPercent(stats?.pick_rate) },
    { label: "Win Rate", value: formatPercent(stats?.win_rate) },
  ];

  useEffect(() => {
    const frame = requestAnimationFrame(() => setActiveAbilityIndex(0));
    return () => cancelAnimationFrame(frame);
  }, [agent.uuid, agent.id, agent.displayName]);

  return (
    <article className="agent-detail">
      <button
        type="button"
        className="agent-detail-close modal-close"
        onClick={onClose}
        aria-label="Cerrar detalle del agente"
      >
        <X size={19} aria-hidden="true" />
      </button>

      <div className="agent-detail-hero">
        <div className="agent-detail-left">
          <div className="agent-detail-heading">
            <div>
              <span className="agents-section-eyebrow">Ficha táctica</span>
              <h2 className="agent-detail-name">{agent.displayName}</h2>
            </div>
            {hasStats ? (
              <span className={`agent-tier-badge agent-tier-badge--${agent.tier.toLowerCase()}`}>
                Tier {agent.tier}
              </span>
            ) : (
              <span className="agent-unavailable-detail-badge">Agente sin salir</span>
            )}
          </div>

          <div className="agent-role-badge" aria-label={`Rol: ${agent.role.displayName}`}>
            {agent.role.displayIcon && <img src={agent.role.displayIcon} alt="" />}
            <span>{agent.role.displayName}</span>
          </div>

          <div className="agent-role-info">
            {agent.role.displayIcon && <img src={agent.role.displayIcon} alt={agent.role.displayName} />}
            <p>{agent.role.description}</p>
          </div>

          <p className="agent-description">{agent.description}</p>

          {hasStats && <div className="agent-quick-kpis" aria-label="KPIs del agente">
            {quickStats.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>}

          {hasStats && agent.lowSample && <span className="sample-reliability-badge">Baja muestra</span>}
        </div>

        <div className="agent-detail-right">
          {agent.background && <img src={agent.background} alt="" className="agent-background" />}
          {agent.fullPortrait ? (
            <img src={agent.fullPortrait} alt={agent.displayName} className="agent-fullportrait" />
          ) : agent.displayIcon ? (
            <img src={agent.displayIcon} alt={agent.displayName} className="agent-fullportrait agent-fullportrait--icon" />
          ) : null}
        </div>
      </div>

      {hasStats && <section className="agent-profile-section" aria-labelledby="agent-profile-title">
        <div className="agent-detail-section-heading">
          <span className="agents-section-eyebrow">Perfil</span>
          <h3 id="agent-profile-title">Dimensiones analíticas</h3>
        </div>
        <div className="agent-profile-bars">
          {agent.profileMetrics.map((metric) => (
            <div key={metric.key} className="agent-profile-bar">
              <span>{metric.label}</span>
              <div aria-hidden="true">
                <i style={{ "--bar-value": `${metric.value}%` } as CSSProperties} />
              </div>
              <strong>{formatNumber(metric.value, 0)}</strong>
            </div>
          ))}
        </div>
      </section>}

      {hasStats && <section className="agent-detail-section">
        <button
          type="button"
          className="agent-accordion-toggle"
          aria-expanded={isStatsOpen}
          aria-controls={statsPanelId}
          onClick={() => setIsStatsOpen((open) => !open)}
        >
          <span>{showComparison ? "Estadísticas globales vs personal" : "Estadísticas globales"}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>

        {isStatsOpen && (
          <div id={statsPanelId} className="agent-accordion-panel">
            {showComparison ? (
              <div className="agents-comparison-table-wrap">
                <ComparisonTable
                  ariaLabel="Comparativa global vs tu rendimiento"
                  rows={agent.comparisonMetrics.map((metric) => ({
                    key: metric.key,
                    label: metric.label,
                    globalLabel: metric.globalLabel,
                    personalLabel: metric.personalLabel,
                    diffLabel: metric.diffLabel,
                    globalNormalizedLabel: metric.globalNormalizedLabel,
                    personalNormalizedLabel: metric.personalNormalizedLabel,
                    normalizedDiffLabel: metric.normalizedDiffLabel,
                    diffTone: getDiffTone(metric),
                    normalizedDiffTone: getNormalizedDiffTone(metric),
                  }))}
                />
              </div>
            ) : visibleGlobalStats.length > 0 ? (
              <div className="agent-global-stat-grid">
                {visibleGlobalStats.map((item) => {
                  const value = getStatValue(agent, item.key);
                  const normalized = normalizeGlobalStatBar(item.key, value, item.format);
                  return (
                    <div key={item.key} className="agent-global-stat-card">
                      <span>{item.label}</span>
                      <strong>{formatStatValue(value, item.format)}</strong>
                      <div className="agent-stat-bar" aria-hidden="true">
                        <i
                          style={
                            {
                              "--bar-value": `${Math.max(0, Math.min(100, normalized))}%`,
                            } as CSSProperties
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="agent-panel-empty">Todavía no hay muestra global suficiente para este agente.</p>
            )}
          </div>
        )}
      </section>}

      <section className="agent-detail-section">
        <button
          type="button"
          className="agent-accordion-toggle"
          aria-expanded={isAbilitiesOpen}
          aria-controls={abilitiesPanelId}
          onClick={() => setIsAbilitiesOpen((open) => !open)}
        >
          <span>Kit / Habilidades</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>

        {isAbilitiesOpen && (
          <div id={abilitiesPanelId} className="agent-accordion-panel">
            {agent.abilities?.length > 0 ? (
              <>
                <div className="ability-tabs" role="tablist" aria-label="Habilidades del agente">
                  {agent.abilities.map((ability, index) => {
                    const tabId = `${abilityTabsId}-tab-${index}`;
                    const panelId = `${abilityTabsId}-panel-${index}`;
                    const selected = activeAbilityIndex === index;

                    const abilityKey = `${ability.slot}-${ability.displayName}-${index}`;
                    const isPassive = ability.slot.trim().toLowerCase() === "passive";
                    const showIcon = Boolean(ability.displayIcon) && !hiddenAbilityIcons[abilityKey];

                    return (
                      <button
                        key={abilityKey}
                        id={tabId}
                        type="button"
                        className={`ability-tab ${selected ? "active" : ""}`}
                        role="tab"
                        aria-selected={selected}
                        aria-controls={panelId}
                        onClick={() => setActiveAbilityIndex(index)}
                      >
                        {showIcon ? (
                          <img
                            src={ability.displayIcon ?? undefined}
                            alt=""
                            onError={() =>
                              setHiddenAbilityIcons((current) => ({ ...current, [abilityKey]: true }))
                            }
                          />
                        ) : isPassive ? null : (
                          <strong>{formatAbilitySlot(ability.slot).charAt(0) || ability.displayName.charAt(0)}</strong>
                        )}
                        <span>{ability.displayName}</span>
                      </button>
                    );
                  })}
                </div>

                {activeAbility && (
                  <div
                    id={`${abilityTabsId}-panel-${activeAbilityIndex}`}
                    className="ability-tab-panel"
                    role="tabpanel"
                    aria-labelledby={`${abilityTabsId}-tab-${activeAbilityIndex}`}
                  >
                    <div className="ability-tab-panel-icon">
                      {(() => {
                        const activeAbilityKey = `${activeAbility.slot}-${activeAbility.displayName}-${activeAbilityIndex}`;
                        const isPassive = activeAbility.slot.trim().toLowerCase() === "passive";
                        const showIcon =
                          Boolean(activeAbility.displayIcon) &&
                          !hiddenAbilityIcons[activeAbilityKey];

                        if (showIcon) {
                          return (
                            <img
                              src={activeAbility.displayIcon ?? undefined}
                              alt=""
                              onError={() =>
                                setHiddenAbilityIcons((current) => ({
                                  ...current,
                                  [activeAbilityKey]: true,
                                }))
                              }
                            />
                          );
                        }

                        if (isPassive) return null;

                        return <strong>{formatAbilitySlot(activeAbility.slot).charAt(0)}</strong>;
                      })()}
                    </div>
                    <div>
                      <span className="ability-slot">{formatAbilitySlot(activeAbility.slot)}</span>
                      <h4 className="ability-name">{activeAbility.displayName}</h4>
                      <p className="ability-description">{activeAbility.description}</p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="agent-panel-empty">No hay habilidades documentadas para este agente.</p>
            )}
          </div>
        )}
      </section>

    </article>
  );
}

