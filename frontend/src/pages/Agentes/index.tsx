import { useEffect, useRef, useState } from "react";
import BackButton from "../../components/BackButton";
import FloatingActionButton from "../../components/FloatingActionButton";
import PageLoadingScreen from "../../components/ui/PageLoadingScreen";
import LoadingModal from "../../components/ui/LoadingModal";
import "../Agentes.css";
import { AgentCompareDrawer } from "./components/AgentCompareDrawer";
import { AgentCompareSelector } from "./components/AgentCompareSelector";
import { AgentFilters } from "./components/AgentFilters";
import { AgentGrid } from "./components/AgentGrid";
import { AgentInlineDetail } from "./components/AgentInlineDetail";
import { getAgentKey } from "./domain/agentKeys";
import { useAgentesViewModel } from "./useAgentesViewModel";

export default function Agentes() {
  const TOPBAR_OFFSET_PX = 88;
  const detailRef = useRef<HTMLDivElement | null>(null);
  const compareRef = useRef<HTMLDivElement | null>(null);
  const previousScrollBeforeDetailRef = useRef<number | null>(null);
  const previousScrollBeforeCompareRef = useRef<number | null>(null);
  const previousCompareCountRef = useRef(0);
  const [isCompareSelectorOpen, setIsCompareSelectorOpen] = useState(false);
  const viewModel = useAgentesViewModel();

  useEffect(() => {
    if (viewModel.selectedAgent && detailRef.current) {
      const top = detailRef.current.getBoundingClientRect().top + window.scrollY - TOPBAR_OFFSET_PX;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }, [viewModel.selectedAgent]);

  useEffect(() => {
    const previousCount = previousCompareCountRef.current;
    const currentCount = viewModel.compareAgents.length;
    if (currentCount === 2 && previousCount !== 2 && compareRef.current) {
      const top = compareRef.current.getBoundingClientRect().top + window.scrollY - TOPBAR_OFFSET_PX;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    previousCompareCountRef.current = currentCount;
  }, [viewModel.compareAgents.length]);

  const restoreScroll = (savedScroll: number | null, clear: () => void) => {
    if (savedScroll === null) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScroll, behavior: "smooth" });
      clear();
    });
  };

  const handleSelectAgent = (agent: (typeof viewModel.filteredAgents)[number]) => {
    const selected = viewModel.selectedAgent;
    const isSameAgent = selected && getAgentKey(selected) === getAgentKey(agent);
    if (!selected || !isSameAgent) {
      previousScrollBeforeDetailRef.current = window.scrollY;
    }
    viewModel.selectAgent(agent);
    if (isSameAgent) {
      restoreScroll(previousScrollBeforeDetailRef.current, () => {
        previousScrollBeforeDetailRef.current = null;
      });
    }
  };

  const handleCloseDetail = () => {
    viewModel.closeDetail();
    restoreScroll(previousScrollBeforeDetailRef.current, () => {
      previousScrollBeforeDetailRef.current = null;
    });
  };

  const handleToggleCompareAgent = (agent: (typeof viewModel.filteredAgents)[number]) => {
    const isSelected = viewModel.compareAgents.some(
      (item) => getAgentKey(item) === getAgentKey(agent),
    );
    if (!isSelected && viewModel.compareAgents.length === 1) {
      previousScrollBeforeCompareRef.current = window.scrollY;
    }
    viewModel.toggleCompareAgent(agent);
  };

  const handleClearCompareAgents = () => {
    viewModel.clearCompareAgents();
    setIsCompareSelectorOpen(false);
    restoreScroll(previousScrollBeforeCompareRef.current, () => {
      previousScrollBeforeCompareRef.current = null;
    });
  };

  const handleRemoveCompareAgent = (agent: (typeof viewModel.filteredAgents)[number]) => {
    const shouldRestore = viewModel.compareAgents.length === 2;
    viewModel.removeCompareAgent(agent);
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

  const closeOpenAgentViews = () => {
    setIsCompareSelectorOpen(false);
    viewModel.closeDetail();
    viewModel.clearCompareAgents();
    previousScrollBeforeDetailRef.current = null;
    previousScrollBeforeCompareRef.current = null;
  };

  const handleRegionChange = (value: string) => {
    viewModel.setSelectedRegion(value);
    closeOpenAgentViews();
  };

  const handleRoleChange = (value: string) => {
    viewModel.setActiveRole(value);
    closeOpenAgentViews();
  };

  const handleMapFilterChange = (value: string) => {
    viewModel.setMapFilter(value);
    closeOpenAgentViews();
  };

  const handleRankFilterChange = (value: string) => {
    viewModel.setRankFilter(value);
    closeOpenAgentViews();
  };

  const handleActFilterChange = (value: string) => {
    viewModel.setActFilter(value);
    closeOpenAgentViews();
  };

  const handleSearchChange = (value: string) => {
    viewModel.setSearch(value);
    closeOpenAgentViews();
  };

  const handleSortChange = (value: (typeof viewModel.sortKey)) => {
    viewModel.setSortKey(value);
    closeOpenAgentViews();
  };

  const handleResetFilters = () => {
    viewModel.resetFilters();
    closeOpenAgentViews();
  };

  if (viewModel.isLoading) {
    return <PageLoadingScreen />;
  }

  if (viewModel.isError) {
    const message =
      viewModel.error instanceof Error
        ? viewModel.error.message
        : "No se pudo cargar la información de agentes.";

    return (
      <div className="agents-container">
        <BackButton />
        <div className="agents-state-card agents-state-card--error">
          <span className="agents-eyebrow">Valorant</span>
          <h1>No se pudieron cargar los agentes</h1>
          <p>{message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="agents-container">
      <div className="agents-page-actions">
        <BackButton />
        <button
          type="button"
          className="agents-compare-open-button"
          onClick={handleOpenCompareSelector}
          aria-expanded={isCompareSelectorOpen}
          aria-label="Abrir selector para comparar agentes"
        >
          Comparar agentes
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
      {viewModel.isFilteringGlobalStats && (
        <LoadingModal placement="overlay" />
      )}

      <AgentFilters
        actFilter={viewModel.actFilter}
        actOptions={viewModel.actOptions}
        activeRole={viewModel.activeRole}
        mapFilter={viewModel.mapFilter}
        mapOptions={viewModel.mapOptions}
        rankFilter={viewModel.rankFilter}
        rankOptions={viewModel.rankOptions}
        regionOptions={viewModel.regionOptions}
        roleOptions={viewModel.roleOptions}
        summary={viewModel.filterSummary}
        search={viewModel.search}
        selectedRegion={viewModel.selectedRegion}
        sortKey={viewModel.sortKey}
        onActFilterChange={handleActFilterChange}
        onMapFilterChange={handleMapFilterChange}
        onRankFilterChange={handleRankFilterChange}
        onRegionChange={handleRegionChange}
        onRoleChange={handleRoleChange}
        onSearchChange={handleSearchChange}
        onSortChange={handleSortChange}
        onResetFilters={handleResetFilters}
      />
      <AgentCompareSelector
        agents={viewModel.filteredAgents}
        compareAgents={viewModel.compareAgents}
        isOpen={isCompareSelectorOpen}
        onClose={() => setIsCompareSelectorOpen(false)}
        onToggleCompare={handleToggleCompareAgent}
        onClear={handleClearCompareAgents}
      />
      <div ref={compareRef}>
        <AgentCompareDrawer
          agents={viewModel.compareAgents}
          metrics={viewModel.compareMetrics}
          onClear={handleClearCompareAgents}
          onRemove={handleRemoveCompareAgent}
        />
      </div>
      {viewModel.selectedAgent && (
        <div ref={detailRef}>
          <AgentInlineDetail
            key={
              viewModel.selectedAgent.uuid ??
              viewModel.selectedAgent.id ??
              viewModel.selectedAgent.displayName
            }
            agent={viewModel.selectedAgent}
            hasSession={viewModel.hasSession}
            onClose={handleCloseDetail}
          />
        </div>
      )}

      <AgentGrid
        agents={viewModel.filteredAgents}
        compareAgents={viewModel.compareAgents}
        selectedAgent={viewModel.selectedAgent}
        activeFilterLabels={viewModel.filterSummary.activeLabels}
        onSelect={handleSelectAgent}
        onToggleCompare={handleToggleCompareAgent}
        onResetFilters={viewModel.resetFilters}
      />
    </div>
  );
}
