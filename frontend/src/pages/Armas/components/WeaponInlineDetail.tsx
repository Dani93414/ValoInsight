import { useId, useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { ComparisonTable } from "../../../components/comparison/ComparisonTable";
import LoadingModal from "../../../components/ui/LoadingModal";
import { formatNumber, formatPercent } from "../../../utils/formatters";
import type { EnrichedWeapon, WeaponComparisonMetric, WeaponPersonalComparison } from "../types";
import { buildWeaponProfileSummary, formatWeaponCost, formatWeaponValue, STAT_LABELS } from "../weaponUtils";
import { WeaponDamageTable } from "./WeaponDamageTable";

type Props = {
  weapon: EnrichedWeapon;
  hasSession: boolean;
  personalComparison: WeaponPersonalComparison | null;
  onClose: () => void;
};

function getDiffTone(metric: WeaponComparisonMetric) {
  if (typeof metric.diff === "number") {
    if (metric.tone === "positive") return "positive";
    if (metric.tone === "improve") return "negative";
  }
  return "neutral";
}

function getNormalizedDiffTone(metric: WeaponComparisonMetric) {
  if (typeof metric.normalizedDiff === "number") {
    const isPositive = metric.higherIsBetter
      ? metric.normalizedDiff >= 0
      : metric.normalizedDiff <= 0;
    return isPositive ? "positive" : "negative";
  }
  return "neutral";
}

function formatStatLabel(key: string) {
  return STAT_LABELS[key] || key;
}

function GlobalStatsPanel({ weapon }: { weapon: EnrichedWeapon }) {
  const stats = weapon.globalStats;
  const isShield = Boolean(weapon.isShield);
  const rounds = stats?.rounds_equipped ?? 0;
  const killsPerRound = stats?.kills_per_round ?? (rounds > 0 ? (stats?.kills ?? 0) / rounds : undefined);
  const kdRatio = stats?.kd_ratio ?? ((stats?.kills ?? 0) / Math.max(stats?.deaths ?? 0, 1));
  const damagePerRound = stats?.adr ?? (rounds > 0 ? (stats?.damage_dealt ?? 0) / rounds : undefined);
  const winRate = stats?.win_rate ?? (rounds > 0 ? ((stats?.wins ?? 0) * 100) / rounds : undefined);

  const entries = isShield
    ? [
        ["Rondas equipado", formatNumber(stats?.rounds_equipped, 0)],
        ["WR", formatPercent(winRate)],
        ["Deaths", formatNumber(stats?.deaths, 0)],
        ["Supervivencia", formatPercent(stats?.survival_rate)],
        ["Daño recibido / ronda", formatNumber(stats?.damage_received_per_round, 1)],
        ["Loadout value medio", formatNumber(stats?.average_loadout_value, 0)],
      ]
    : [
        ["Rondas equipada", formatNumber(stats?.rounds_equipped, 0)],
        ["Kills", formatNumber(stats?.kills, 0)],
        ["Kills / ronda", formatNumber(killsPerRound, 2)],
        ["KD", formatNumber(kdRatio, 2)],
        ["Daño / ronda", formatNumber(damagePerRound, 1)],
        ["Headshot", formatPercent(stats?.headshot_pct)],
        ["Win rate", formatPercent(winRate)],
      ];

  if (!stats) return <p className="weapons-panel-empty">Todavia no hay muestra global para este elemento.</p>;

  return (
    <div className="weapon-global-stat-grid">
      {entries.map(([label, value]) => (
        <div key={label} className="weapon-global-stat-card">
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
      {isShield && <p className="weapon-offensive-empty">Sin datos ofensivos: los escudos se evalúan con métricas defensivas.</p>}
    </div>
  );
}

function ComparisonPanel({ comparison }: { comparison: WeaponPersonalComparison }) {
  if (comparison.isLoading) {
    return <LoadingModal placement="section" />;
  }

  if (comparison.isError || !comparison.hasPersonalUsage) {
    return <p className="weapons-panel-empty">{comparison.summary}</p>;
  }

  return (
    <>
      <div className="weapon-personal-comparison-table-wrap">
        <ComparisonTable
          ariaLabel="Comparativa global vs tu rendimiento"
          rows={comparison.metrics.map((metric) => ({
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
    </>
  );
}

function WeaponStatsTable({ baseEntries, adsEntries }: { baseEntries: Array<[string, unknown]>; adsEntries: Array<[string, unknown]> }) {
  if (baseEntries.length === 0) return <p className="weapons-panel-empty">Sin estadisticas base disponibles.</p>;
  const adsByKey = new Map(adsEntries);
  const keys = Array.from(new Set([...baseEntries.map(([key]) => key), ...adsEntries.map(([key]) => key)]));
  const hasAds = adsEntries.length > 0;

  return (
    <div className={`weapon-base-ads-table${hasAds ? " has-ads" : ""}`} role="table" aria-label="Estadisticas base y con mira">
      <div className="weapon-base-ads-row weapon-base-ads-row--head" role="row">
        <span role="columnheader">Metrica</span>
        <span role="columnheader">Base</span>
        {hasAds && <span role="columnheader">Mira</span>}
      </div>
      {keys.map((key) => {
        const baseValue = baseEntries.find(([entryKey]) => entryKey === key)?.[1];
        const adsValue = adsByKey.get(key);
        return (
          <div key={key} className="weapon-base-ads-row" role="row">
            <span role="cell">{formatStatLabel(key)}</span>
            <strong role="cell">{formatWeaponValue(baseValue)}</strong>
            {hasAds && <strong role="cell">{adsValue === undefined ? "-" : formatWeaponValue(adsValue)}</strong>}
          </div>
        );
      })}
    </div>
  );
}

export function WeaponInlineDetail({ weapon, hasSession, personalComparison, onClose }: Props) {
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isWeaponStatsOpen, setIsWeaponStatsOpen] = useState(false);
  const [isDamageOpen, setIsDamageOpen] = useState(false);
  const statsPanelId = useId();
  const weaponStatsPanelId = useId();
  const damagePanelId = useId();
  const stats = weapon.globalStats;
  const isShield = Boolean(weapon.isShield);
  const hasWeaponStats = !isShield;
  const baseEntries = Object.entries(weapon.stats ?? {}).filter(([, value]) => value !== undefined && value !== null);
  const adsEntries = Object.entries(weapon.adsStats ?? {}).filter(([, value]) => value !== undefined && value !== null);
  const damageRanges = weapon.damageRanges ?? [];
  const showComparison = hasSession && Boolean(personalComparison?.hasPersonalUsage);
  const hasLowSample = weapon.sampleReliability === "Baja muestra";
  const rounds = stats?.rounds_equipped ?? 0;
  const winRate = stats?.win_rate ?? (rounds > 0 ? ((stats?.wins ?? 0) * 100) / rounds : undefined);
  const killsPerRound = stats?.kills_per_round ?? (rounds > 0 ? (stats?.kills ?? 0) / rounds : undefined);

  const quickStats = useMemo(
    () =>
      isShield
        ? [
            { label: "Rondas", value: formatNumber(stats?.rounds_equipped, 0) },
            { label: "WR", value: `${formatPercent(winRate)} WR` },
            { label: "Supervivencia", value: `${formatPercent(stats?.survival_rate)} Supervivencia` },
            { label: "Daño rec.", value: formatNumber(stats?.damage_received_per_round, 1) },
          ]
        : [
            { label: "Kills", value: formatNumber(stats?.kills, 0) },
            { label: "Rondas", value: formatNumber(stats?.rounds_equipped, 0) },
            { label: "K/R", value: formatNumber(killsPerRound, 2) },
            { label: "HS", value: `${formatPercent(stats?.headshot_pct)} HS` },
          ],
    [isShield, killsPerRound, stats, winRate],
  );

  return (
    <article className="weapon-detail">
      <button type="button" className="weapon-detail-close modal-close" onClick={onClose} aria-label="Cerrar detalle del arma">
        <X size={19} aria-hidden="true" />
      </button>

      <div className="weapon-detail-hero-shell">
        <div className="weapon-detail-hero">
          <div className="weapon-detail-left">
          <div className="weapon-detail-heading">
            <div>
              <span className="weapons-section-eyebrow">Ficha de arsenal</span>
              <h2 className="weapon-name">{weapon.displayName}</h2>
            </div>
            {hasLowSample && <span className="weapon-sample-badge">Baja muestra</span>}
          </div>

          <div className="weapon-badges">
            <span>{weapon.normalizedCategory}</span>
            <span>{formatWeaponCost(weapon.cost)}</span>
          </div>

          <section className="weapon-profile-section">
            <div className="weapon-detail-section-heading">
              <h3>Lectura táctica</h3>
            </div>
            <p>{weapon.description || buildWeaponProfileSummary(weapon)}</p>
            {weapon.profileTags.length > 0 && (
              <div className="weapon-tags">
                {weapon.profileTags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            )}
          </section>

          <div className="weapon-quick-kpis" aria-label="KPIs del arma">
            {quickStats.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          </div>

          <div className="weapon-detail-right">
            {weapon.displayIcon && <img src={weapon.displayIcon} alt={weapon.displayName} className="weapon-image-large" />}
          </div>
        </div>
      </div>

      <section className="weapon-detail-section">
        <button
          type="button"
          className="weapon-accordion-toggle"
          aria-expanded={isStatsOpen}
          aria-controls={statsPanelId}
          onClick={() => setIsStatsOpen((open) => !open)}
        >
          <span>{showComparison ? "Estadisticas globales vs personal" : "Estadisticas globales"}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
        {isStatsOpen && (
          <div id={statsPanelId} className="weapon-accordion-panel">
            {showComparison && personalComparison ? <ComparisonPanel comparison={personalComparison} /> : <GlobalStatsPanel weapon={weapon} />}
          </div>
        )}
      </section>

      {hasWeaponStats && (
        <section className="weapon-detail-section">
          <button
            type="button"
            className="weapon-accordion-toggle"
            aria-expanded={isWeaponStatsOpen}
            aria-controls={weaponStatsPanelId}
            onClick={() => setIsWeaponStatsOpen((open) => !open)}
          >
            <span>Estadisticas del arma</span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          {isWeaponStatsOpen && (
            <div id={weaponStatsPanelId} className="weapon-accordion-panel">
              <WeaponStatsTable baseEntries={baseEntries} adsEntries={adsEntries} />
            </div>
          )}
        </section>
      )}

      {hasWeaponStats && (
        <section className="weapon-detail-section">
          <button
            type="button"
            className="weapon-accordion-toggle"
            aria-expanded={isDamageOpen}
            aria-controls={damagePanelId}
            onClick={() => setIsDamageOpen((open) => !open)}
          >
            <span>Daño por distancia</span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          {isDamageOpen && (
            <div id={damagePanelId} className="weapon-accordion-panel">
              {damageRanges.length > 0 ? <WeaponDamageTable ranges={damageRanges} /> : <p className="weapons-panel-empty">Sin rangos de daño disponibles.</p>}
            </div>
          )}
        </section>
      )}
    </article>
  );
}
