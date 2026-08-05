import { useEffect, useRef, useState } from "react";
import BackButton from "../../components/BackButton";
import FloatingActionButton from "../../components/FloatingActionButton";
import PageLoadingScreen from "../../components/ui/PageLoadingScreen";
import "../Armas.css";
import { WeaponCompareDrawer } from "./components/WeaponCompareDrawer";
import { WeaponCompareSelector } from "./components/WeaponCompareSelector";
import { WeaponGrid } from "./components/WeaponGrid";
import { WeaponInlineDetail } from "./components/WeaponInlineDetail";
import { WeaponsFilters } from "./components/WeaponsFilters";
import { WeaponsGlobalRanking } from "./components/WeaponsGlobalRanking";
import { WeaponsHighlights } from "./components/WeaponsHighlights";
import { useArmasViewModel } from "./useArmasViewModel";

export default function Armas() {
  const TOPBAR_OFFSET_PX = 88;
  const detailRef = useRef<HTMLDivElement | null>(null);
  const compareRef = useRef<HTMLDivElement | null>(null);
  const previousScrollBeforeDetailRef = useRef<number | null>(null);
  const previousScrollBeforeCompareRef = useRef<number | null>(null);
  const previousCompareCountRef = useRef(0);
  const [isCompareSelectorOpen, setIsCompareSelectorOpen] = useState(false);
  const viewModel = useArmasViewModel();

  useEffect(() => {
    if (viewModel.selectedWeapon && detailRef.current) {
      const top = detailRef.current.getBoundingClientRect().top + window.scrollY - TOPBAR_OFFSET_PX;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }, [viewModel.selectedWeapon]);

  useEffect(() => {
    const previousCount = previousCompareCountRef.current;
    const currentCount = viewModel.compareWeapons.length;
    if (currentCount === 2 && previousCount !== 2 && compareRef.current) {
      const top = compareRef.current.getBoundingClientRect().top + window.scrollY - TOPBAR_OFFSET_PX;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    previousCompareCountRef.current = currentCount;
  }, [viewModel.compareWeapons.length]);

  const restoreScroll = (savedScroll: number | null, clear: () => void) => {
    if (savedScroll === null) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScroll, behavior: "smooth" });
      clear();
    });
  };

  const handleSelectWeapon = (weapon: (typeof viewModel.filteredWeapons)[number]) => {
    const selected = viewModel.selectedWeapon;
    const isSameWeapon =
      selected && (selected.uuid ?? selected.displayName) === (weapon.uuid ?? weapon.displayName);
    if (!selected || !isSameWeapon) previousScrollBeforeDetailRef.current = window.scrollY;
    viewModel.selectWeapon(weapon);
    if (isSameWeapon) {
      restoreScroll(previousScrollBeforeDetailRef.current, () => {
        previousScrollBeforeDetailRef.current = null;
      });
    }
  };

  const handleCloseDetail = () => {
    viewModel.setSelectedWeapon(null);
    restoreScroll(previousScrollBeforeDetailRef.current, () => {
      previousScrollBeforeDetailRef.current = null;
    });
  };

  const handleToggleCompareWeapon = (weapon: (typeof viewModel.filteredWeapons)[number]) => {
    const isSelected = viewModel.compareWeapons.some(
      (item) => (item.uuid ?? item.displayName) === (weapon.uuid ?? weapon.displayName),
    );
    if (!isSelected && viewModel.compareWeapons.length === 1) previousScrollBeforeCompareRef.current = window.scrollY;
    viewModel.toggleCompareWeapon(weapon);
  };

  const handleClearCompareWeapons = () => {
    viewModel.clearCompareWeapons();
    setIsCompareSelectorOpen(false);
    restoreScroll(previousScrollBeforeCompareRef.current, () => {
      previousScrollBeforeCompareRef.current = null;
    });
  };

  const handleRemoveCompareWeapon = (weapon: (typeof viewModel.filteredWeapons)[number]) => {
    const shouldRestore = viewModel.compareWeapons.length === 2;
    viewModel.removeCompareWeapon(weapon);
    if (shouldRestore) {
      restoreScroll(previousScrollBeforeCompareRef.current, () => {
        previousScrollBeforeCompareRef.current = null;
      });
    }
  };

  const handleOpenCompareSelector = () => {
    previousScrollBeforeCompareRef.current = window.scrollY;
    setIsCompareSelectorOpen((current) => !current);
  };

  if (viewModel.isLoading) {
    return <PageLoadingScreen />;
  }

  if (viewModel.isError) {
    const message =
      viewModel.error instanceof Error
        ? viewModel.error.message
        : "No se pudo cargar la información del arsenal.";

    return (
      <div className="weapons-container">
        <BackButton />
        <div className="weapons-state-card weapons-state-card--error">
          <span className="weapons-eyebrow">Valorant</span>
          <h1>No se pudo cargar el arsenal</h1>
          <p>{message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="weapons-container">
      <div className="weapons-page-actions">
        <BackButton />
        <button
          type="button"
          className="weapons-compare-open-button"
          onClick={handleOpenCompareSelector}
          aria-expanded={isCompareSelectorOpen}
          aria-label="Abrir selector para comparar armas"
        >
          Comparar armas
        </button>
      </div>
      {viewModel.returnTo && (
        <FloatingActionButton
          label={viewModel.returnLabel}
          onClick={() => {
            if (viewModel.returnTo) viewModel.navigate(viewModel.returnTo);
          }}
          ariaLabel={viewModel.returnLabel}
        />
      )}

      <WeaponsFilters
        activeCategory={viewModel.activeCategory}
        activeCost={viewModel.activeCost}
        categories={viewModel.categories}
        search={viewModel.search}
        sortKey={viewModel.sortKey}
        summary={viewModel.filterSummary}
        onCategoryChange={viewModel.setActiveCategory}
        onCostChange={viewModel.setActiveCost}
        onSearchChange={viewModel.setSearch}
        onSortChange={viewModel.setSortKey}
        onResetFilters={viewModel.resetFilters}
        onClearFilter={viewModel.clearFilter}
      />
      <WeaponCompareSelector
        weapons={viewModel.filteredWeapons}
        compareWeapons={viewModel.compareWeapons}
        isOpen={isCompareSelectorOpen}
        onClose={() => setIsCompareSelectorOpen(false)}
        onToggleCompare={handleToggleCompareWeapon}
        onClear={handleClearCompareWeapons}
      />
      <div ref={compareRef}>
        <WeaponCompareDrawer
          weapons={viewModel.compareWeapons}
          metrics={viewModel.compareMetrics}
          onClear={handleClearCompareWeapons}
          onRemove={handleRemoveCompareWeapon}
        />
      </div>
      <WeaponsHighlights insights={viewModel.insights} />
      <WeaponsGlobalRanking ranking={viewModel.ranking} />

      {viewModel.selectedWeapon && (
        <div ref={detailRef}>
          <WeaponInlineDetail
            key={viewModel.selectedWeapon.uuid ?? viewModel.selectedWeapon.displayName}
            weapon={viewModel.selectedWeapon}
            hasSession={viewModel.hasSession}
            personalComparison={viewModel.personalComparison}
            onClose={handleCloseDetail}
          />
        </div>
      )}

      <WeaponGrid
        weaponsByCategory={viewModel.weaponsByCategory}
        selectedWeapon={viewModel.selectedWeapon}
        compareWeapons={viewModel.compareWeapons}
        activeFilters={viewModel.filterSummary.activeFilters}
        onSelect={handleSelectWeapon}
        onToggleCompare={handleToggleCompareWeapon}
        onResetFilters={viewModel.resetFilters}
      />
    </div>
  );
}
