import HeatmapCanvas from "../HeatmapCanvas";
import LoadingModal from "../../ui/LoadingModal";
import PageLoadingScreen from "../../ui/PageLoadingScreen";
import {
  useHeatmapViewModel,
  toSortedCsv,
  AGENT_ALL,
  FIXED_RADIUS_PX,
  FIXED_OPACITY,
  VIEW_MODE_OPTIONS,
  type HeatmapInitialFilters,
} from "./useHeatmapViewModel";

export type HeatmapEntryFilters = HeatmapInitialFilters;

interface Props {
  playerId: string;
  agentNameMap: Record<string, string>;
  actOptions: Array<{ id: string; label: string }>;
  initialFilters?: HeatmapInitialFilters;
  onClose?: () => void;
  mode?: "modal" | "page";
  startWithSetup?: boolean;
  onEnterHeatmap?: (filters: HeatmapEntryFilters) => void;
}

function formatCompactNumber(value: number): string {
  const absValue = Math.abs(value);
  if (absValue !== 0 && (absValue < 0.001 || absValue >= 1000)) {
    return value.toExponential(4);
  }
  return value.toFixed(6);
}

function formatNormValue(value: number): string {
  return value.toFixed(4);
}

function buildTruncationMessage(
  label: string,
  meta: {
    is_truncated?: boolean;
    total_matches_available?: number;
    total_matches_queried?: number;
    max_matches_per_map?: number;
  },
): string | null {
  if (!meta.is_truncated) return null;

  const totalAvailable = meta.total_matches_available ?? 0;
  const totalQueried = meta.total_matches_queried ?? 0;
  const maxMatchesPerMap = meta.max_matches_per_map ?? totalQueried;

  return `${label}: se han usado las ${totalQueried} partidas mas recientes de ${totalAvailable} disponibles (limite ${maxMatchesPerMap} por mapa).`;
}

export default function HeatmapModal(props: Props) {
  const {
    onClose,
    mode = "modal",
    startWithSetup = true,
    onEnterHeatmap,
  } = props;

  const isModalMode = mode === "modal";
  const closeHandler = () => onClose?.();

  const vm = useHeatmapViewModel({
    playerId: props.playerId,
    agentNameMap: props.agentNameMap,
    actOptions: props.actOptions,
    initialFilters: props.initialFilters,
    startWithSetup,
    lockBodyScroll: isModalMode,
  });
  const {
    selectedMapId,
    selectedEvents,
    selectedAgent,
    selectedSide,
    selectedPhase,
    selectedActs,
    viewMode,
    splitByEvent,
    showSetupStep,
    radiusPx,
    legendExpanded,

    setSelectedAgent,
    setSelectedSide,
    setSelectedPhase,
    setShowSetupStep,
    setViewMode,
    setSplitByEvent,
    setRadiusPx,
    setLegendExpanded,

    filterOptionsError,
    filterOptionsLoading,
    availableMaps,
    availableAgents,
    availableActs,
    visibleEventTypes,
    visibleSides,
    isPlantDefuseContext,
    selectablePhases,
    heatmapDebugEnabled,
    mainEvents,
    mainMeta,
    secondaryEvents,
    secondaryMeta,
    fractureDebugReference,
    mapImageUrl,
    needsSecondary,
    showBlockingLoader,
    canvasesClass,
    leftCanvasLabel,
    rightCanvasLabel,
    legendRows,

    toggleEvent,
    toggleAct,
    selectAllActs,
    deselectAllActs,
    handleMapChange,
  } = vm;

  const eventTypeLabels: Record<string, string> = {
    kill: "Kills",
    kill_enemy_position: "Kill (posicion enemigo)",
    death: "Muertes",
    first_blood: "First Blood",
    plant: "Plant",
    defuse: "Defuse",
    ...Object.fromEntries(
      visibleEventTypes.map((eventType) => [eventType.key, eventType.label]),
    ),
  };

  const activeSplitEventTypes =
    viewMode === "plants-defuses"
      ? []
      : visibleEventTypes.filter((eventType) =>
          selectedEvents.has(eventType.key),
        );

  const splitModeAvailable =
    viewMode !== "plants-defuses" && activeSplitEventTypes.length > 0;

  const splitModeEnabled = splitModeAvailable && splitByEvent;

  const splitStackClassName =
    viewMode === "combined"
      ? "heatmap-event-split-stack heatmap-event-split-stack--combined"
      : "heatmap-event-split-stack";

  const selectedMapName =
    availableMaps.find((mapItem) => mapItem.uuid === selectedMapId)
      ?.displayName ?? undefined;

  if (filterOptionsLoading) {
    return isModalMode
      ? <LoadingModal placement="overlay" />
      : <PageLoadingScreen />;
  }
  const truncationMessages = [
    buildTruncationMessage(
      needsSecondary ? leftCanvasLabel : "Heatmap",
      mainMeta,
    ),
    ...(needsSecondary
      ? [buildTruncationMessage(rightCanvasLabel, secondaryMeta)]
      : []),
  ].filter((message): message is string => Boolean(message));

  const handleEnterHeatmap = () => {
    const nextFilters: HeatmapEntryFilters = {
      mapId: selectedMapId || undefined,
      mapName: selectedMapName,
      agentId: selectedAgent !== AGENT_ALL ? selectedAgent : undefined,
      seasonIds: selectedActs.size > 0 ? [...selectedActs] : undefined,
      side: selectedSide,
    };

    if (onEnterHeatmap) {
      onEnterHeatmap(nextFilters);
      return;
    }

    setShowSetupStep(false);
  };

  const heatmapContent = (
    <div
      className={`modal-panel heatmap-modal-panel${isModalMode ? "" : " heatmap-page-panel"}${showSetupStep ? " heatmap-setup-mode" : ""}`}
    >
      {showSetupStep ? (
        <>
          <h3 className="heatmap-sidebar-title">
            Seleccion inicial de filtros
          </h3>
          {filterOptionsError && (
            <p className="heatmap-options-warning">
              No se pudieron cargar opciones dinamicas. Se muestran opciones
              base para que puedas continuar.
            </p>
          )}
          <p className="heatmap-sidebar-subtitle">
            Elige los filtros de arranque del heatmap. Podras cambiarlos despues
            dentro del modo de visualizacion.
          </p>

          <label className="heatmap-filter-label">Mapa</label>
          <select
            className="heatmap-select"
            value={selectedMapId}
            onChange={(event) => handleMapChange(event.target.value)}
          >
            {availableMaps.length === 0 ? (
              <option value="">Sin mapas disponibles</option>
            ) : (
              availableMaps.map((mapItem) => (
                <option key={mapItem.uuid} value={mapItem.uuid}>
                  {mapItem.displayName}
                  {` (${mapItem.eventCount} partidas)`}
                </option>
              ))
            )}
          </select>

          <label className="heatmap-filter-label">Agente</label>
          <select
            className="heatmap-select"
            value={selectedAgent}
            onChange={(event) => setSelectedAgent(event.target.value)}
          >
            <option value={AGENT_ALL}>Todos los agentes</option>
            {availableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {selectedMapId ? ` (${agent.eventCount} partidas)` : ""}
              </option>
            ))}
          </select>

          <label className="heatmap-filter-label">Actos</label>
          <div className="heatmap-act-checkboxes">
            <div className="heatmap-act-actions">
              <button
                type="button"
                className="heatmap-act-action-btn"
                onClick={selectAllActs}
              >
                Seleccionar todos
              </button>
              <button
                type="button"
                className="heatmap-act-action-btn"
                onClick={deselectAllActs}
              >
                Deseleccionar todos
              </button>
            </div>
            {availableActs.length === 0 ? (
              <label className="heatmap-act-item">
                <span>Sin actos disponibles</span>
              </label>
            ) : (
              availableActs.map((act) => (
                <label key={act.id} className="heatmap-act-item">
                  <input
                    type="checkbox"
                    checked={selectedActs.has(act.id)}
                    onChange={() => toggleAct(act.id)}
                  />
                  <span>
                    {act.label}
                    {selectedMapId ? ` (${act.eventCount} partidas)` : ""}
                  </span>
                </label>
              ))
            )}
          </div>

          <div className="heatmap-setup-actions">
            <button
              type="button"
              className="heatmap-setup-start-btn"
              onClick={handleEnterHeatmap}
            >
              Entrar al heatmap
            </button>
          </div>
        </>
      ) : (
        <div className="heatmap-layout">
          {selectedMapId && showBlockingLoader && (
            <div className="heatmap-loading-overlay">
              <LoadingModal placement="section" />
            </div>
          )}
          <aside className="heatmap-sidebar">
            <div className="heatmap-sidebar-header">
              <h3 className="heatmap-sidebar-title">Mapa de calor</h3>
              {filterOptionsError && (
                <p className="heatmap-options-warning">
                  Opciones dinamicas no disponibles temporalmente.
                </p>
              )}
              <p className="heatmap-sidebar-subtitle">
                Visualiza patrones espaciales de eventos en tus partidas.
              </p>
            </div>

            <div
              className="heatmap-sidebar-scroll"
              role="region"
              aria-label="Panel de filtros del mapa de calor"
              tabIndex={0}
            >
              <div className="heatmap-legend-panel">
                <button
                  type="button"
                  className={`heatmap-legend-toggle ${legendExpanded ? "expanded" : ""}`}
                  aria-expanded={legendExpanded}
                  onClick={() => setLegendExpanded((previous) => !previous)}
                >
                  Leyenda
                </button>

                {legendExpanded && (
                  <div className="heatmap-legend-details">
                    {legendRows.map((row) => (
                      <div key={row.key} className="heatmap-legend-row">
                        <span>{row.label}</span>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {viewMode !== "plants-defuses" && (
                <div className="heatmap-filter-featured">
                  <label className="heatmap-filter-label heatmap-filter-label-featured">
                    Tipo de evento
                  </label>
                  <div className="heatmap-event-buttons heatmap-event-buttons-featured">
                    {visibleEventTypes.map((eventType) => (
                      <button
                        key={eventType.key}
                        className={`heatmap-event-btn ${selectedEvents.has(eventType.key) ? "active" : ""}`}
                        onClick={() => toggleEvent(eventType.key)}
                      >
                        {eventType.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {viewMode !== "plants-defuses" && (
                <>
                  <label className="heatmap-toggle-row">
                    <input
                      type="checkbox"
                      checked={splitByEvent}
                      disabled={!splitModeAvailable}
                      onChange={(event) => {
                        if (!splitModeAvailable) return;
                        setSplitByEvent(event.target.checked);
                      }}
                    />
                    <span>Un mapa por evento</span>
                  </label>
                  {splitModeEnabled && (
                    <p className="heatmap-compare-hint">
                      Cada evento activo se muestra en un bloque separado.
                    </p>
                  )}
                </>
              )}

              <label className="heatmap-filter-label">Mapa</label>
              <select
                className="heatmap-select"
                value={selectedMapId}
                onChange={(event) => handleMapChange(event.target.value)}
              >
                {availableMaps.length === 0 ? (
                  <option value="">Sin mapas disponibles</option>
                ) : (
                  availableMaps.map((mapItem) => (
                    <option key={mapItem.uuid} value={mapItem.uuid}>
                      {mapItem.displayName}
                      {` (${mapItem.eventCount} partidas)`}
                    </option>
                  ))
                )}
              </select>

              <label className="heatmap-filter-label">Agente</label>
              <select
                className="heatmap-select"
                value={selectedAgent}
                onChange={(event) => setSelectedAgent(event.target.value)}
              >
                <option value={AGENT_ALL}>Todos los agentes</option>
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {selectedMapId ? ` (${agent.eventCount} partidas)` : ""}
                  </option>
                ))}
              </select>

              <label className="heatmap-filter-label">Actos</label>
              <div className="heatmap-act-checkboxes">
                <div className="heatmap-act-actions">
                  <button
                    type="button"
                    className="heatmap-act-action-btn"
                    onClick={selectAllActs}
                  >
                    Seleccionar todos
                  </button>
                  <button
                    type="button"
                    className="heatmap-act-action-btn"
                    onClick={deselectAllActs}
                  >
                    Deseleccionar todos
                  </button>
                </div>
                {availableActs.length === 0 ? (
                  <label className="heatmap-act-item">
                    <span>Sin actos disponibles</span>
                  </label>
                ) : (
                  availableActs.map((act) => (
                    <label key={act.id} className="heatmap-act-item">
                      <input
                        type="checkbox"
                        checked={selectedActs.has(act.id)}
                        onChange={() => toggleAct(act.id)}
                      />
                      <span>
                        {act.label}
                        {selectedMapId ? ` (${act.eventCount} partidas)` : ""}
                      </span>
                    </label>
                  ))
                )}
              </div>

              {viewMode !== "attack-defense" && !isPlantDefuseContext && (
                <>
                  <label className="heatmap-filter-label">Lado</label>
                  <div className="side-toggle">
                    {visibleSides.map((sideOption) => (
                      <button
                        key={sideOption.key || "all"}
                        className={`side-toggle-btn ${selectedSide === sideOption.key ? "active" : ""}`}
                        onClick={() => setSelectedSide(sideOption.key)}
                      >
                        {sideOption.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <label className="heatmap-filter-label">Fase de ronda</label>
              <select
                className="heatmap-select"
                value={selectedPhase}
                onChange={(event) => setSelectedPhase(event.target.value)}
              >
                {selectablePhases.length === 0 ? (
                  <option value="">Sin fases disponibles</option>
                ) : (
                  selectablePhases.map((phaseOption) => (
                    <option
                      key={phaseOption.key || "all"}
                      value={phaseOption.key}
                    >
                      {phaseOption.label}
                    </option>
                  ))
                )}
              </select>

              <label className="heatmap-filter-label">
                Radio del punto ({radiusPx}px)
              </label>
              <input
                className="heatmap-slider"
                type="range"
                min={3}
                max={12}
                step={1}
                value={radiusPx}
                onChange={(event) =>
                  setRadiusPx(
                    Number.parseInt(event.target.value, 10) || FIXED_RADIUS_PX,
                  )
                }
              />
            </div>
          </aside>

          <div className="heatmap-main">
            <div className="heatmap-view-mode-bar">
              {VIEW_MODE_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  className={`heatmap-view-mode-btn${viewMode === option.key ? " active" : ""}`}
                  onClick={() => setViewMode(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {heatmapDebugEnabled && mainMeta.transform && (
              <div className="heatmap-debug-meta">
                <span>
                  Transform oficial: x &larr; game_y *{" "}
                  {formatCompactNumber(mainMeta.transform.xMultiplier)} +{" "}
                  {formatCompactNumber(mainMeta.transform.xScalarToAdd)} | y
                  &larr; game_x *{" "}
                  {formatCompactNumber(mainMeta.transform.yMultiplier)} +{" "}
                  {formatCompactNumber(mainMeta.transform.yScalarToAdd)}
                </span>
                {fractureDebugReference && (
                  <span>
                    Fracture/Bridge: (
                    {formatNormValue(fractureDebugReference.normalized_x)},{" "}
                    {formatNormValue(fractureDebugReference.normalized_y)}) | Δ
                    ({formatNormValue(fractureDebugReference.delta.x)},{" "}
                    {formatNormValue(fractureDebugReference.delta.y)})
                  </span>
                )}
              </div>
            )}

            {heatmapDebugEnabled && (
              <div className="heatmap-debug-meta">
                <span>
                  Filtros UI: event_type={toSortedCsv(selectedEvents) ?? ""} |
                  side={selectedSide || "all"} | round_phase=
                  {selectedPhase || "all"}
                </span>
                <span>
                  Datos: izquierda={mainEvents.length}
                  {needsSecondary ? ` | derecha=${secondaryEvents.length}` : ""}
                </span>
              </div>
            )}

            {truncationMessages.length > 0 && (
              <div className="heatmap-truncation-warning" role="status">
                {truncationMessages.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            )}

            {!selectedMapId && (
              <div className="heatmap-empty">
                No hay mapa seleccionado. Puedes cambiarlo desde los filtros.
              </div>
            )}

            {selectedMapId &&
              !showBlockingLoader &&
              (splitModeEnabled ? (
                <div className={splitStackClassName}>
                  {activeSplitEventTypes.map((eventType) => {
                    const splitMainEvents = mainEvents.filter(
                      (eventItem) => eventItem.event_type === eventType.key,
                    );
                    const splitSecondaryEvents = secondaryEvents.filter(
                      (eventItem) => eventItem.event_type === eventType.key,
                    );

                    return (
                      <section
                        key={eventType.key}
                        className="heatmap-event-split-block"
                      >
                        <div className="heatmap-event-split-title">
                          {eventType.label}
                        </div>
                        <div
                          className={`${needsSecondary ? "heatmap-canvases heatmap-canvases-compare" : "heatmap-canvases heatmap-canvases-single"} heatmap-canvases-split`}
                        >
                          {needsSecondary ? (
                            <>
                              <div className="heatmap-canvas-wrapper">
                                <div className="heatmap-canvas-label">
                                  {leftCanvasLabel}
                                </div>
                                <HeatmapCanvas
                                  events={splitMainEvents}
                                  mapImageUrl={mapImageUrl}
                                  opacity={FIXED_OPACITY}
                                  radius={radiusPx}
                                  debugEnabled={heatmapDebugEnabled}
                                  transformMeta={mainMeta.transform ?? null}
                                  eventTypeLabels={eventTypeLabels}
                                />
                                {splitMainEvents.length === 0 &&
                                  !showBlockingLoader && (
                                    <div className="heatmap-no-data">
                                      Sin datos para estos filtros
                                    </div>
                                  )}
                              </div>

                              <div className="heatmap-canvas-wrapper">
                                <div className="heatmap-canvas-label">
                                  {rightCanvasLabel}
                                </div>
                                <HeatmapCanvas
                                  events={splitSecondaryEvents}
                                  mapImageUrl={mapImageUrl}
                                  opacity={FIXED_OPACITY}
                                  radius={radiusPx}
                                  debugEnabled={heatmapDebugEnabled}
                                  transformMeta={
                                    secondaryMeta.transform ?? null
                                  }
                                  eventTypeLabels={eventTypeLabels}
                                />
                                {splitSecondaryEvents.length === 0 &&
                                  !showBlockingLoader && (
                                    <div className="heatmap-no-data">
                                      Sin datos para estos filtros
                                    </div>
                                  )}
                              </div>
                            </>
                          ) : (
                            <div className="heatmap-canvas-wrapper">
                              <HeatmapCanvas
                                events={splitMainEvents}
                                mapImageUrl={mapImageUrl}
                                opacity={FIXED_OPACITY}
                                radius={radiusPx}
                                debugEnabled={heatmapDebugEnabled}
                                transformMeta={mainMeta.transform ?? null}
                                eventTypeLabels={eventTypeLabels}
                              />
                              {splitMainEvents.length === 0 &&
                                !showBlockingLoader && (
                                  <div className="heatmap-no-data">
                                    Sin datos para estos filtros
                                  </div>
                                )}
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className={canvasesClass}>
                  {needsSecondary ? (
                    <>
                      <div className="heatmap-canvas-wrapper">
                        <div className="heatmap-canvas-label">
                          {leftCanvasLabel}
                        </div>
                        <HeatmapCanvas
                          events={mainEvents}
                          mapImageUrl={mapImageUrl}
                          opacity={FIXED_OPACITY}
                          radius={radiusPx}
                          debugEnabled={heatmapDebugEnabled}
                          transformMeta={mainMeta.transform ?? null}
                          eventTypeLabels={eventTypeLabels}
                        />
                        {mainEvents.length === 0 && !showBlockingLoader && (
                          <div className="heatmap-no-data">
                            Sin datos para estos filtros
                          </div>
                        )}
                      </div>

                      <div className="heatmap-canvas-wrapper">
                        <div className="heatmap-canvas-label">
                          {rightCanvasLabel}
                        </div>
                        <HeatmapCanvas
                          events={secondaryEvents}
                          mapImageUrl={mapImageUrl}
                          opacity={FIXED_OPACITY}
                          radius={radiusPx}
                          debugEnabled={heatmapDebugEnabled}
                          transformMeta={secondaryMeta.transform ?? null}
                          eventTypeLabels={eventTypeLabels}
                        />
                        {secondaryEvents.length === 0 &&
                          !showBlockingLoader && (
                            <div className="heatmap-no-data">
                              Sin datos para estos filtros
                            </div>
                          )}
                      </div>
                    </>
                  ) : (
                    <div className="heatmap-canvas-wrapper">
                      <HeatmapCanvas
                        events={mainEvents}
                        mapImageUrl={mapImageUrl}
                        opacity={FIXED_OPACITY}
                        radius={radiusPx}
                        debugEnabled={heatmapDebugEnabled}
                        transformMeta={mainMeta.transform ?? null}
                        eventTypeLabels={eventTypeLabels}
                      />
                      {mainEvents.length === 0 && !showBlockingLoader && (
                        <div className="heatmap-no-data">
                          Sin datos para estos filtros
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

            <div className="heatmap-legend">
              <span className="heatmap-legend-label">Baja densidad</span>
              <div className="heatmap-legend-bar" />
              <span className="heatmap-legend-label">Alta densidad</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (!isModalMode) {
    return <div className="heatmap-page-shell">{heatmapContent}</div>;
  }

  return (
    <div className="modal-overlay" onClick={closeHandler}>
      <div
        className="heatmap-modal-shell"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="modal-close heatmap-modal-close-external"
          onClick={closeHandler}
          aria-label="Cerrar mapa de calor"
        >
          ✕
        </button>

        {heatmapContent}
      </div>
    </div>
  );
}
