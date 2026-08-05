import { GitCompare } from "lucide-react";
import { formatNumber, formatPercent } from "../../../utils/formatters";
import {
  formatWeaponCost,
  isMeleeWeapon,
} from "../weaponUtils";
import type { EnrichedWeapon } from "../types";

type Props = {
  weapon: EnrichedWeapon;
  active: boolean;
  compareActive: boolean;
  compareDisabled: boolean;
  compareDisabledReason?: string | null;
  onSelect: (weapon: EnrichedWeapon) => void;
  onToggleCompare: (weapon: EnrichedWeapon) => void;
};

export function WeaponCard({
  weapon,
  active,
  compareActive,
  compareDisabled,
  compareDisabledReason,
  onSelect,
  onToggleCompare,
}: Props) {
  const kills = weapon.globalStats?.kills ?? 0;
  const rounds = weapon.globalStats?.rounds_equipped ?? 0;
  const headshot = weapon.globalStats?.headshot_pct;
  const isShield = Boolean(weapon.isShield);
  const isMelee = isMeleeWeapon(weapon);
  const hasStats = kills > 0 || rounds > 0;
  const hasLowSample = weapon.sampleReliability === "Baja muestra";
  const secondaryLabel = isShield
    ? "Uso global"
    : isMelee
    ? weapon.normalizedCategory
    : rounds > 0
      ? `${formatNumber(rounds)} rondas`
      : "Sin rondas";
  const secondaryValue = isShield
    ? `${formatPercent(weapon.globalStats?.win_rate)} WR`
    : isMelee
      ? formatWeaponCost(weapon.cost)
      : hasStats
        ? `${formatPercent(headshot)} HS`
        : "-";

  return (
    <article
      className={`weapon-card ${active ? "active" : ""}`}
    >
      <button
        type="button"
        className={`weapon-card-compare ${compareActive ? "is-active" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCompare(weapon);
        }}
        disabled={compareDisabled}
        aria-pressed={compareActive}
        aria-label={`${compareActive ? "Quitar" : "Agregar"} ${weapon.displayName} a comparación`}
        title={compareDisabledReason ?? "Comparar arma"}
      >
        <GitCompare size={16} aria-hidden="true" />
        <span className="weapon-compare-tooltip" role="tooltip">
          {compareActive
            ? "Quitar de la comparación"
            : isShield
              ? "Añadir escudo a la comparación"
              : "Añadir a la comparación"}
        </span>
      </button>
      {hasLowSample && <span className="weapon-stat-badge is-low">Baja muestra</span>}
      {!hasStats && !isShield && (
        <span className="weapon-unavailable-badge">Sin salir en estos datos</span>
      )}

      <button
        type="button"
        className="weapon-card-main"
        onClick={() => onSelect(weapon)}
        aria-pressed={active}
        aria-label={`${active ? "Ocultar" : "Ver"} detalles de ${weapon.displayName}`}
      >
        {weapon.displayIcon && (
          <div className="weapon-image-frame">
            <img
              src={weapon.displayIcon}
              alt={weapon.displayName}
              className="weapon-image"
              loading="lazy"
            />
          </div>
        )}

        <div className="weapon-card-body">
          <h3 className="weapon-card-name">{weapon.displayName}</h3>
          <p className="weapon-card-category">{weapon.normalizedCategory}</p>
          <div className="weapon-card-meta-row">
            <span>{formatWeaponCost(weapon.cost)}</span>
            <strong>
              {isShield
                  ? rounds > 0
                    ? `${formatNumber(rounds)} rondas`
                    : "Sin rondas"
                  : hasStats
                    ? `${formatNumber(kills)} kills`
                    : "-"}
            </strong>
          </div>
          <div className="weapon-card-meta-row">
            <span>{secondaryLabel}</span>
            <strong>{secondaryValue}</strong>
          </div>
          {hasLowSample && <span className="weapon-sample-badge">Baja muestra</span>}
        </div>
      </button>
    </article>
  );
}
