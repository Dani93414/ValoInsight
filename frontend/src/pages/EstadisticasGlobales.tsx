import { useMemo, useState } from "react";
import { useAgentes, useArmas, useMapas, useRegions } from "../api/hooks";
import type {
  RegionAgentStats,
  RegionEconomyStats,
  RegionMapStats,
  RegionStats,
  RegionWeaponStats,
} from "../types/globalStats";
import type { Arma } from "../types/weapons";
import type { Agente } from "../types/agents";
import type { MapContent, MapGroups } from "../types/content";
import { formatNumber, formatPercent } from "../utils/formatters";
import {
  ContentEmpty,
  ContentError,
  ContentLoading,
  ContentSection,
  ContentShell,
} from "./contentPageUtils";
import { normalizeText } from "./contentFormatters";
import { calculateGlobalWeaponHeadshotPct } from "./Armas/weaponUtils";
import "./ContentPages.css";
import "./GlobalStats.css";

type TabKey = "resumen" | "agentes" | "mapas" | "armas" | "economia";

type RankedAgent = RegionAgentStats & { id: string };
type RankedMap = RegionMapStats & { id: string };
type RankedWeapon = RegionWeaponStats & { id: string; category?: string };
type RankedEconomy = RegionEconomyStats & { id: string; label: string };
type SortDirection = "desc" | "asc";
type SortState = { key: string; direction: SortDirection };
type SearchOption = { id: string; name: string; image?: string | null; meta?: string };

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "resumen", label: "Resumen" },
  { key: "agentes", label: "Agentes" },
  { key: "mapas", label: "Mapas" },
  { key: "armas", label: "Armas" },
  { key: "economia", label: "Economía" },
];

const ECONOMY_LABELS: Record<string, string> = {
  eco: "Eco",
  low_buy: "Low buy",
  full_buy: "Full buy",
};

function metric(value: number | undefined, decimals = 1) {
  return formatNumber(value, decimals);
}

function metricPct(value: number | undefined, decimals = 1) {
  return formatPercent(value, decimals);
}

function normalizeWeaponCategory(category?: string | null) {
  const raw = String(category ?? "").trim();
  if (!raw || raw === "—" || raw === "-") return "Sin categoría";
  if (raw.includes("::")) return raw.split("::").pop() || raw;
  return raw;
}

function getBestSide(map: RankedMap) {
  const attack = map.sides?.attack?.win_rate ?? 0;
  const defense = map.sides?.defense?.win_rate ?? 0;
  if (!attack && !defense) return "-";
  return attack >= defense
    ? `Ataque ${metricPct(attack)}`
    : `Defensa ${metricPct(defense)}`;
}

function getRegionLabel(region: RegionStats | undefined) {
  if (!region) return "Sin región";
  return region.region || "Global";
}

function getSortValue(row: unknown, path: string): string | number {
  const value = path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, row);
  return typeof value === "number" ? value : normalizeText(String(value ?? ""));
}

function sortRows<T>(rows: T[], sort: SortState) {
  const factor = sort.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = getSortValue(a, sort.key);
    const right = getSortValue(b, sort.key);
    if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
    return String(left).localeCompare(String(right), "es") * factor;
  });
}

function SortableHeader({ label, sortKey, sort, onSort }: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th aria-sort={active ? (sort.direction === "desc" ? "descending" : "ascending") : "none"}>
      <button className="global-sort-button" type="button" onClick={() => onSort(sortKey)}>
        {label}<span aria-hidden="true">{active ? (sort.direction === "desc" ? "↓" : "↑") : "↕"}</span>
      </button>
    </th>
  );
}

function VisualSearch({ value, placeholder, options, onChange }: {
  value: string;
  placeholder: string;
  options: SearchOption[];
  onChange: (value: string) => void;
}) {
  const needle = normalizeText(value);
  const suggestions = needle
    ? options.filter((option) => normalizeText(`${option.name} ${option.meta ?? ""}`).includes(needle)).slice(0, 8)
    : [];
  return (
    <label className="global-filter global-filter--wide global-visual-search">
      <span>Búsqueda</span>
      <input type="search" placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      {suggestions.length > 0 && (
        <div className="global-search-results" role="listbox">
          {suggestions.map((option) => (
            <button key={option.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onChange(option.name)}>
              <span className="global-search-thumb">
                {option.image ? <img src={option.image} alt="" /> : option.name.charAt(0)}
              </span>
              <span><strong>{option.name}</strong>{option.meta && <small>{option.meta}</small>}</span>
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

export default function EstadisticasGlobales() {
  const regionsQuery = useRegions();
  const agentsQuery = useAgentes();
  const weaponsQuery = useArmas();
  const mapsQuery = useMapas();
  const [selectedRegion, setSelectedRegion] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>("resumen");
  const [searches, setSearches] = useState({ agentes: "", mapas: "", armas: "" });
  const [roleFilter, setRoleFilter] = useState("all");
  const [weaponCategoryFilter, setWeaponCategoryFilter] = useState("all");
  const [agentSort, setAgentSort] = useState<SortState>({ key: "picks", direction: "desc" });
  const [mapSort, setMapSort] = useState<SortState>({ key: "matches", direction: "desc" });
  const [weaponSort, setWeaponSort] = useState<SortState>({ key: "kills", direction: "desc" });

  const regions = useMemo(() => regionsQuery.data ?? [], [regionsQuery.data]);
  const effectiveSelectedRegion = selectedRegion || regions[0]?.region || "";

  const region =
    regions.find((entry) => entry.region === effectiveSelectedRegion) ??
    regions[0];

  const weaponsByName = useMemo(() => {
    const map = new Map<string, Arma>();
    ((weaponsQuery.data as Arma[] | undefined) ?? []).forEach((weapon) => {
      map.set(normalizeText(weapon.displayName), weapon);
    });
    return map;
  }, [weaponsQuery.data]);

  const agentsByName = useMemo(() => {
    const map = new Map<string, Agente>();
    (((agentsQuery.data as Agente[] | undefined) ?? [])).forEach((agent) => map.set(normalizeText(agent.displayName), agent));
    return map;
  }, [agentsQuery.data]);

  const mapsByName = useMemo(() => {
    const map = new Map<string, MapContent>();
    const groups = (mapsQuery.data ?? {}) as MapGroups;
    Object.values(groups).flat().forEach((item) => {
      if (item) map.set(normalizeText(item.displayName), item);
    });
    return map;
  }, [mapsQuery.data]);

  const agents = useMemo<RankedAgent[]>(
    () =>
      Object.entries(region?.agentStats ?? {})
        .map(([id, stats]) => ({ id, ...stats }))
        .sort((a, b) => (b.picks ?? 0) - (a.picks ?? 0)),
    [region?.agentStats],
  );

  const maps = useMemo<RankedMap[]>(
    () =>
      Object.entries(region?.mapStats ?? {})
        .map(([id, stats]) => ({ id, ...stats }))
        .sort((a, b) => (b.matches ?? 0) - (a.matches ?? 0)),
    [region?.mapStats],
  );

  const weapons = useMemo<RankedWeapon[]>(
    () =>
      Object.entries(region?.weaponStats ?? {})
        .map(([id, stats]) => {
          const catalog = weaponsByName.get(normalizeText(stats.weapon_name));
          return {
            id,
            ...stats,
            headshot_pct: calculateGlobalWeaponHeadshotPct(stats),
            category: normalizeWeaponCategory(catalog?.category),
          };
        })
        .sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0)),
    [region?.weaponStats, weaponsByName],
  );

  const economyRows = useMemo<RankedEconomy[]>(
    () =>
      Object.entries(region?.economy ?? {}).map(([id, stats]) => ({
        id,
        label: ECONOMY_LABELS[id] ?? id,
        ...stats,
      })),
    [region?.economy],
  );

  const roles = useMemo(
    () =>
      Array.from(
        new Set(
          agents
            .map((agent) => agent.role)
            .filter((role): role is string => Boolean(role)),
        ),
      ).sort((a, b) => String(a).localeCompare(String(b), "es")),
    [agents],
  );

  const weaponCategories = useMemo(
    () =>
      Array.from(
        new Set(
          weapons
            .map((weapon) => weapon.category)
            .filter((category): category is string => Boolean(category)),
        ),
      ).sort((a, b) => String(a).localeCompare(String(b), "es")),
    [weapons],
  );

  const filteredAgents = agents.filter((agent) => {
    const matchesSearch = normalizeText(
      `${agent.agent_name ?? ""} ${agent.role ?? ""}`,
    ).includes(normalizeText(searches.agentes));
    const matchesRole = roleFilter === "all" || agent.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const filteredMaps = maps.filter((map) => {
    const matchesSearch = normalizeText(map.map_name ?? "").includes(
      normalizeText(searches.mapas),
    );
    return matchesSearch;
  });

  const filteredWeapons = weapons.filter((weapon) => {
    const matchesSearch = normalizeText(
      `${weapon.weapon_name ?? ""} ${weapon.category ?? ""}`,
    ).includes(normalizeText(searches.armas));
    const matchesCategory =
      weaponCategoryFilter === "all" ||
      weapon.category === weaponCategoryFilter;
    return matchesSearch && matchesCategory;
  });

  const sortedAgents = sortRows(filteredAgents, agentSort);
  const sortedMaps = sortRows(filteredMaps, mapSort);
  const sortedWeapons = sortRows(filteredWeapons, weaponSort);
  const toggleSort = (setter: React.Dispatch<React.SetStateAction<SortState>>, key: string) => {
    setter((current) => ({ key, direction: current.key === key && current.direction === "desc" ? "asc" : "desc" }));
  };

  const agentSearchOptions: SearchOption[] = agents.map((agent) => {
    const content = agentsByName.get(normalizeText(agent.agent_name));
    return { id: agent.id, name: agent.agent_name ?? "Unknown", image: content?.displayIcon, meta: agent.role };
  });
  const mapSearchOptions: SearchOption[] = maps.map((map) => {
    const content = mapsByName.get(normalizeText(map.map_name));
    return { id: map.id, name: map.map_name ?? "Unknown", image: content?.displayIcon ?? content?.splash, meta: `${formatNumber(map.matches)} partidas` };
  });
  const weaponSearchOptions: SearchOption[] = weapons.map((weapon) => {
    const content = weaponsByName.get(normalizeText(weapon.weapon_name));
    return { id: weapon.id, name: weapon.weapon_name ?? "Unknown", image: content?.displayIcon, meta: weapon.category };
  });

  if (regionsQuery.isLoading) {
    return <ContentLoading title="Cargando estadísticas globales" />;
  }

  return (
    <ContentShell
      className="global-stats-page"
      title="Estadísticas globales"
      subtitle="Resumen competitivo agregado por región usando partidas, jugadores y analíticas embebidas."
    >
      {regionsQuery.isError && (
        <ContentError
          message="No se pudieron cargar las estadísticas globales."
          onRetry={() => regionsQuery.refetch()}
        />
      )}

      {!regionsQuery.isError && regions.length === 0 && (
        <ContentEmpty message="No hay estadísticas globales disponibles." />
      )}

      {!regionsQuery.isError && region && (
        <>
          <div className="global-toolbar">
            <label className="global-filter">
              <span>Región</span>
              <select
                value={region.region}
                onChange={(event) => setSelectedRegion(event.target.value)}
              >
                {regions.map((item) => (
                  <option key={item.region} value={item.region}>
                    {getRegionLabel(item)}
                  </option>
                ))}
              </select>
            </label>

            {activeTab === "agentes" && (
              <VisualSearch
                value={searches.agentes}
                placeholder="Buscar agente..."
                options={agentSearchOptions}
                onChange={(value) => setSearches((current) => ({ ...current, agentes: value }))}
              />
            )}
            {activeTab === "mapas" && (
              <VisualSearch
                value={searches.mapas}
                placeholder="Buscar mapa..."
                options={mapSearchOptions}
                onChange={(value) => setSearches((current) => ({ ...current, mapas: value }))}
              />
            )}
            {activeTab === "armas" && (
              <VisualSearch
                value={searches.armas}
                placeholder="Buscar arma..."
                options={weaponSearchOptions}
                onChange={(value) => setSearches((current) => ({ ...current, armas: value }))}
              />
            )}
            {activeTab === "agentes" && (
            <label className="global-filter global-filter--compact">
              <span>Rol</span>
              <select
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value)}
              >
                <option value="all">Todos</option>
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            )}
            {activeTab === "armas" && (
            <label className="global-filter global-filter--compact">
              <span>Categoría</span>
              <select
                value={weaponCategoryFilter}
                onChange={(event) =>
                  setWeaponCategoryFilter(event.target.value)
                }
              >
                <option value="all">Todas</option>
                {weaponCategories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            )}
          </div>

          <div className="global-tabs" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`global-tab ${activeTab === tab.key ? "active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "resumen" && (
            <>
              <div className="global-kpi-grid">
                <article className="global-kpi-card">
                  <span>Partidas</span>
                  <strong>{formatNumber(region.totalMatches)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>Jugadores</span>
                  <strong>{formatNumber(region.uniquePlayers)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>Rondas</span>
                  <strong>{formatNumber(region.totalRounds)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>KD</span>
                  <strong>{metric(region.averages?.kd_ratio, 2)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>ACS</span>
                  <strong>{metric(region.averages?.acs, 1)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>ADR</span>
                  <strong>{metric(region.averages?.adr, 1)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>HS%</span>
                  <strong>{metricPct(region.averages?.headshot_pct)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>KAST</span>
                  <strong>{metricPct(region.averages?.kast_pct)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>Supervivencia</span>
                  <strong>{metricPct(region.averages?.survival_rate)}</strong>
                </article>
                <article className="global-kpi-card">
                  <span>Clutch</span>
                  <strong>{metricPct(region.averages?.clutch_win_rate)}</strong>
                </article>
              </div>

              <ContentSection title="Lados">
                <div className="global-side-grid">
                  {(["attack", "defense"] as const).map((side) => {
                    const stats = region.sides?.[side];
                    return (
                      <article key={side} className="global-panel">
                        <h3>{side === "attack" ? "Ataque" : "Defensa"}</h3>
                        <div className="global-mini-grid">
                          <span>WR</span>
                          <strong>{metricPct(stats?.win_rate)}</strong>
                          <span>Rondas</span>
                          <strong>{formatNumber(stats?.rounds)}</strong>
                          <span>ADR</span>
                          <strong>{metric(stats?.adr)}</strong>
                          <span>KPR</span>
                          <strong>{metric(stats?.kills_per_round, 2)}</strong>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </ContentSection>
            </>
          )}

          {activeTab === "agentes" && (
            <ContentSection title="Ranking de agentes">
              {sortedAgents.length === 0 ? (
                <ContentEmpty message="No hay agentes con esos filtros." />
              ) : (
                <table className="content-table">
                  <thead>
                    <tr>
                      <SortableHeader label="Agente" sortKey="agent_name" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="Rol" sortKey="role" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="Picks" sortKey="picks" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="Pick %" sortKey="pick_rate" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="WR" sortKey="win_rate" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="KD" sortKey="avg_kd" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="ACS" sortKey="avg_acs" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="ADR" sortKey="avg_adr" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                      <SortableHeader label="HS" sortKey="avg_headshot_pct" sort={agentSort} onSort={(key) => toggleSort(setAgentSort, key)} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAgents.map((agent) => (
                      <tr key={agent.id}>
                        <td><span className="global-name-cell">{agentsByName.get(normalizeText(agent.agent_name))?.displayIcon && <img src={agentsByName.get(normalizeText(agent.agent_name))?.displayIcon ?? ""} alt="" />}<strong>{agent.agent_name ?? "Unknown"}</strong></span></td>
                        <td>{agent.role ?? "-"}</td>
                        <td>{formatNumber(agent.picks)}</td>
                        <td>{metricPct(agent.pick_rate)}</td>
                        <td>{metricPct(agent.win_rate)}</td>
                        <td>{metric(agent.avg_kd, 2)}</td>
                        <td>{metric(agent.avg_acs)}</td>
                        <td>{metric(agent.avg_adr)}</td>
                        <td>{metricPct(agent.avg_headshot_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ContentSection>
          )}

          {activeTab === "mapas" && (
            <ContentSection title="Ranking de mapas">
              {sortedMaps.length === 0 ? (
                <ContentEmpty message="No hay mapas con esos filtros." />
              ) : (
                <table className="content-table">
                  <thead>
                    <tr>
                      <SortableHeader label="Mapa" sortKey="map_name" sort={mapSort} onSort={(key) => toggleSort(setMapSort, key)} />
                      <SortableHeader label="Partidas" sortKey="matches" sort={mapSort} onSort={(key) => toggleSort(setMapSort, key)} />
                      <SortableHeader label="Rondas" sortKey="total_rounds" sort={mapSort} onSort={(key) => toggleSort(setMapSort, key)} />
                      <th>Lado fuerte</th>
                      <SortableHeader label="KD" sortKey="averages.kd_ratio" sort={mapSort} onSort={(key) => toggleSort(setMapSort, key)} />
                      <SortableHeader label="ACS" sortKey="averages.acs" sort={mapSort} onSort={(key) => toggleSort(setMapSort, key)} />
                      <SortableHeader label="ADR" sortKey="averages.adr" sort={mapSort} onSort={(key) => toggleSort(setMapSort, key)} />
                      <SortableHeader label="HS" sortKey="averages.headshot_pct" sort={mapSort} onSort={(key) => toggleSort(setMapSort, key)} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMaps.map((map) => (
                      <tr key={map.id}>
                        <td><span className="global-name-cell">{(() => { const content = mapsByName.get(normalizeText(map.map_name)); const image = content?.displayIcon ?? content?.splash; return image ? <img src={image} alt="" /> : null; })()}<strong>{map.map_name ?? "Unknown"}</strong></span></td>
                        <td>{formatNumber(map.matches)}</td>
                        <td>{formatNumber(map.total_rounds)}</td>
                        <td>{getBestSide(map)}</td>
                        <td>{metric(map.averages?.kd_ratio, 2)}</td>
                        <td>{metric(map.averages?.acs)}</td>
                        <td>{metric(map.averages?.adr)}</td>
                        <td>{metricPct(map.averages?.headshot_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ContentSection>
          )}

          {activeTab === "armas" && (
            <ContentSection title="Ranking de armas">
              {sortedWeapons.length === 0 ? (
                <ContentEmpty message="No hay armas con esos filtros." />
              ) : (
                <table className="content-table">
                  <thead>
                    <tr>
                      <SortableHeader label="Arma" sortKey="weapon_name" sort={weaponSort} onSort={(key) => toggleSort(setWeaponSort, key)} />
                      <SortableHeader label="Categoría" sortKey="category" sort={weaponSort} onSort={(key) => toggleSort(setWeaponSort, key)} />
                      <SortableHeader label="Kills" sortKey="kills" sort={weaponSort} onSort={(key) => toggleSort(setWeaponSort, key)} />
                      <SortableHeader label="Rondas equipada" sortKey="rounds_equipped" sort={weaponSort} onSort={(key) => toggleSort(setWeaponSort, key)} />
                      <SortableHeader label="Deaths" sortKey="deaths" sort={weaponSort} onSort={(key) => toggleSort(setWeaponSort, key)} />
                      <SortableHeader label="HS" sortKey="headshot_pct" sort={weaponSort} onSort={(key) => toggleSort(setWeaponSort, key)} />
                      <SortableHeader label="Daño" sortKey="damage_dealt" sort={weaponSort} onSort={(key) => toggleSort(setWeaponSort, key)} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedWeapons.map((weapon) => (
                      <tr key={weapon.id}>
                        <td><span className="global-name-cell">{weaponsByName.get(normalizeText(weapon.weapon_name))?.displayIcon && <img src={weaponsByName.get(normalizeText(weapon.weapon_name))?.displayIcon ?? ""} alt="" />}<strong>{weapon.weapon_name ?? "Unknown"}</strong></span></td>
                        <td>{weapon.category ?? "-"}</td>
                        <td>{formatNumber(weapon.kills)}</td>
                        <td>{formatNumber(weapon.rounds_equipped)}</td>
                        <td>{formatNumber(weapon.deaths)}</td>
                        <td>{metricPct(weapon.headshot_pct)}</td>
                        <td>{formatNumber(weapon.damage_dealt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ContentSection>
          )}

          {activeTab === "economia" && (
            <ContentSection title="Economía">
              {economyRows.length === 0 ? (
                <ContentEmpty message="No hay datos de economía." />
              ) : (
                <div className="global-side-grid">
                  {economyRows.map((row) => (
                    <article key={row.id} className="global-panel">
                      <h3>{row.label}</h3>
                      <div className="global-mini-grid">
                        <span>Rondas</span>
                        <strong>{formatNumber(row.rounds)}</strong>
                        <span>Victorias</span>
                        <strong>{formatNumber(row.wins)}</strong>
                        <span>WR</span>
                        <strong>{metricPct(row.win_rate)}</strong>
                        <span>KD</span>
                        <strong>{metric(row.kd_ratio, 2)}</strong>
                        <span>ADR</span>
                        <strong>{metric(row.adr)}</strong>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </ContentSection>
          )}
        </>
      )}
    </ContentShell>
  );
}
