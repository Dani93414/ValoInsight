import type { WeaponFilterSummary, WeaponSortKey } from "../types";

type Props = {
  activeCategory: string;
  activeCost: string;
  categories: string[];
  search: string;
  sortKey: WeaponSortKey;
  summary: WeaponFilterSummary;
  onCategoryChange: (value: string) => void;
  onCostChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: WeaponSortKey) => void;
  onResetFilters: () => void;
  onClearFilter: (key: WeaponFilterSummary["activeFilters"][number]["key"]) => void;
};

const sortOptions: Array<{ value: WeaponSortKey; label: string }> = [
  { value: "name", label: "Nombre" },
  { value: "cost", label: "Coste" },
  { value: "category", label: "Categoría" },
  { value: "kills", label: "Kills globales" },
  { value: "headshot", label: "Headshot global" },
  { value: "rounds", label: "Rondas equipada" },
  { value: "fireRate", label: "Cadencia" },
];

export function WeaponsFilters({
  activeCategory,
  activeCost,
  categories,
  search,
  sortKey,
  summary,
  onCategoryChange,
  onCostChange,
  onSearchChange,
  onSortChange,
  onResetFilters,
  onClearFilter,
}: Props) {
  const hasActiveFilters = summary.activeFilters.length > 0;

  return (
    <section className="weapons-filters">
      <div className="weapons-filters-header">
        <div>
          <span className="weapons-section-eyebrow">Filtros</span>
          <strong>
            Mostrando {summary.shown} de {summary.total} armas
          </strong>
        </div>
        <button
          type="button"
          className="weapons-clear-filters"
          onClick={onResetFilters}
          disabled={!hasActiveFilters}
        >
          Limpiar filtros
        </button>
      </div>

      <div className="weapons-filter-tools">
        <input
          type="text"
          className="weapons-search-input"
          placeholder="Buscar arma..."
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label="Buscar arma por nombre"
        />

        <select
          className="weapons-select"
          value={activeCategory}
          onChange={(event) => onCategoryChange(event.target.value)}
          aria-label="Filtrar por categoría"
        >
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>

        <select
          className="weapons-select"
          value={activeCost}
          onChange={(event) => onCostChange(event.target.value)}
          aria-label="Filtrar por coste"
        >
          <option value="Todos">Todos los costes</option>
          <option value="Gratis">Gratis</option>
          <option value="Economicas">Económicas</option>
          <option value="Premium">Premium</option>
        </select>

        <select
          className="weapons-select"
          value={sortKey}
          onChange={(event) => onSortChange(event.target.value as WeaponSortKey)}
          aria-label="Ordenar armas"
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              Orden: {option.label}
            </option>
          ))}
        </select>
      </div>

      {hasActiveFilters && (
        <div className="weapons-active-filters" aria-label="Filtros activos">
          {summary.activeFilters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className="weapons-active-filter-chip"
              onClick={() => onClearFilter(filter.key)}
              aria-label={`Quitar filtro ${filter.label}`}
            >
              <span>{filter.label}</span>
              <strong aria-hidden="true">x</strong>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
