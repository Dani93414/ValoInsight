# Economy ML

Motor player-first de recomendacion economica para VALORANT. La legalidad,
inventario individual, drops y economia futura gobiernan la decision. El ML es
un estimador auxiliar y nunca puede convertir un plan ilegal en viable.

La respuesta conserva `engine: player_first_v10` por compatibilidad y declara
`advanced_engine: player_first_v11_contextual`. Esta fase se considera
`player_first_v11_contextual_stable`. V11 no sustituye las reglas:
anade ajustes pequenos despues de que el plan haya superado generacion y
validacion legal. Si una fuente avanzada falta, devuelve `available: false`,
`confidence: 0`, `source: unavailable` y warnings tecnicos sin bloquear el
endpoint.

## Contexto Avanzado V11

Cada ronda puede exponer un `advanced_context` opcional con:

- `map_context`: mapa del `matchInfo`, catalogo y perfil heuristico versionado.
- `site_tendencies`: plantas y resultados exclusivamente de rondas anteriores.
- `player_profiles`: uso y rendimiento estimado por arma en rondas anteriores.
- `enemy_economy`: creditos por jugador, capacidades de compra, mediana,
  dispersion, inventario previo y clase de compra probable.
- `ultimates`: estado directo de la ronda anterior cuando el payload lo trae.
- `armor_durability`: valor directo o estimacion conservadora identificada;
  el valor efectivo de armadura carried condiciona generacion y scoring.
- `ability_usage`: casts e inventario previo si el payload lo trae; las cargas
  carried no se cobran otra vez y las compras exactas siguen siendo estimadas.
- `ml_prediction`: probabilidad opcional del artefacto de round-win.

Las senales incluyen siempre `source`, `confidence` y `warnings`. Los perfiles
de mapa son heuristicas de baja magnitud, no estadisticas aprendidas. El perfil
de jugador de la partida atribuye kills al arma equipada solo como fallback y
lo marca con `weapon_kills_estimated_from_round_loadout`. La durabilidad usa el
valor directo si existe; de lo contrario puede inferirse con dano previo o
degradar a desconocida. No se consulta Mongo historico adicional en la ruta
sincrona actual.

`round_win_dataset.py` construye un dataset aislado con acciones/loadouts
historicos como tratamiento y labels `round_won`. `train_round_win_model.py`
aplica validacion anti-leakage, split temporal, preprocesado numerico/categorico
y regresion logistica sin balanceo artificial de probabilidades. Separa por
partidas completas y orden temporal en train, calibracion y test; compara la
probabilidad sin calibrar con calibracion sigmoide y excluye columnas
constantes o dominadas por defaults. Publica opcionalmente
`artifacts/round_win_loadout.joblib` con `feature_version`, features y metricas.
La version `round-win-loadout-v3` separa valor de arma, armadura y utilidad,
incorpora proyecciones pre-ronda enemigas e informa calidad por feature;
los snapshots v1/v2 se rechazan como incompatibles.
El script `scripts/entrenamiento_economia.py` ejecuta este entrenamiento despues
del pipeline principal; si faltan muestras o clases informa `available=false`
sin borrar ni bloquear el motor de reglas.

El score contextual publica score de reglas, ML round-win y ajustes de mapa,
site, enemigo, player-fit, utilidad, ultimate y armadura. Cada componente tiene
limites propios y el total queda acotado a `-0.35..+0.25`; nunca se ejecuta antes
de validar legalidad. La confianza final combina inferencia de compra, ledger,
contexto, ML opcional y disponibilidad de mapa/site/enemigo.

## Anti-Leakage V11

Para recomendar la ronda N solo se leen estados y eventos de rondas anteriores
a N. Kills, dano, plantas, defuses, casts, resultado y score post-round de la
ronda actual no entran en features pre-round. El predictor rechaza claves
prohibidas como `current_round_kills`, `current_round_damage`,
`current_round_result`, `post_round_score` o loadout enemigo post-buy actual.

El endpoint de partida usa `RoundEconomyRecommender`: infiere varias hipotesis
de compra real, genera compras legales por jugador, resuelve drops de armas y
puntua planes completos. `ACTION_TEMPLATES` queda relegado al flujo historico
legacy y no es la fuente de las recomendaciones expuestas por la API.

Los dos endpoints de lectura de partida usan el mismo contrato:

- `/matches/{match_id}/economy-ml` (consumido por la UI principal).
- `/economy-ml/matches/{match_id}` (ruta directa del modulo).

Ambos devuelven `engine: player_first_v10`, `rounds`, `limitations`, compras
observadas/inferidas/recomendadas y proyecciones por jugador. `predict.py`,
`policy.py` y los modelos macro entrenados orientan la familia de compra del
motor player-first. Su ajuste esta acotado por confianza y nunca evita la
generacion, validacion o scoring legal por jugador. Si el modelo macro no esta
disponible, el endpoint continua con reglas, contexto y el ML auxiliar.

`confidence` combina calidad de reconciliacion e incertidumbre de inferencia.
Los `warnings` indican costes ausentes, hipotesis no observables, falta de apoyo
ML o penalizaciones de composicion. Un warning reduce confianza; no convierte
un plan ilegal en valido.

## Coste Y Valor De Armas

El motor no mezcla el pago de la ronda con la potencia del inventario:

- `weapon_cost`: creditos pagados por ese jugador por su arma esta ronda.
- `weapon_purchase_cost`: precio que debe pagar quien compra el arma; en un
  drop lo paga el donor, no el receptor.
- `weapon_value`: valor tactico/economico del arma equipada para el scoring.
- `weapon_source`: `bought_self`, `carried`, `dropped` o `none`.
- `keep_weapon`: solo es `true` cuando `weapon_source == carried`.

Una Vandal conservada tiene `weapon_cost = 0` y `weapon_value = 2900`. Una
Vandal recibida por drop tambien cuesta 0 al receptor, conserva valor 2900 y
carga los 2900 creditos al comprador.

La armadura usa el mismo contrato: `armor_cost` es el pago propio de esta
ronda, `armor_purchase_cost` el precio de compra, `armor_value` su valor
equipado, `armor_source` distingue `bought_self`, `carried`, `none` y
`unknown`, y `keep_armor` solo es verdadero para `carried`. En rondas 1, 13,
overtime y resets de mitad se elimina todo carryover antes de generar planes;
la Classic es equipamiento inicial, no un arma conservada.

## Normalizacion Y Mensajes

`display_normalizer.py` convierte UUID, nombres localizados y placeholders en
objetos estables antes de construir inventario o responder a la UI. La API
conserva `weapon_raw` y `armor_raw` para auditoria, pero expone
`weapon_display`, `armor_display` y etiquetas legibles. `string`, valores vacios
y escudos ausentes nunca se muestran literalmente.

Las habilidades se reconcilian por agente y slot (`C/Q/E/X`) antes que por
nombre. Asi, nombres localizados como `Flecha explosiva` reutilizan el coste y
las cargas del alias canonico `Shock Bolt` sin falsos `missing_cost`.

`warnings` contiene mensajes para usuario, `debug_warnings` conserva codigos
tecnicos y `limitations` agrupa limitaciones globales como la ausencia del ML
auxiliar. En pistol, la Classic inicial se explica como arma gratuita y los
planes usan etiquetas `PISTOL_DEFAULT`, `PISTOL_UTILITY`, `PISTOL_ARMOR` o
`PISTOL_SIDEARM`.

Fuera de pistol, la clasificacion distingue `POST_PISTOL_CONVERSION`,
`ANTI_ECO`, `BONUS_KEEP_INVENTORY`, `BONUS_UPGRADE`, `ECO`, `HALF_BUY`,
`FORCE_BUY`, `BROKEN_BUY`, `FULL_BUY`, `LAST_ROUND_BUY` y `OVERTIME_BUY`.
La politica post-pistol penaliza Odin/Operator, armas caras sin escudo y saldo
residual extremo; una bonus premia conservar inventario y limita upgrades.

`team_plan_value` es el valor interno sin cap usado para ordenar candidatos.
`team_plan_score` es su representacion normalizada entre 0 y 1 para la UI.

## Contrato De Datos

Cada fila separa tres conceptos:

- Estado precompra: marcador, ronda, lado, rachas, rango, composicion y
  creditos seleccionados antes de comprar.
- Accion: categoria de compra y perfil postcompra observado o simulado.
- Labels: resultado de ronda, partida y economia futura.

El contrato executable vive en `schemas.py`: `STATE_FEATURES` contiene solo
estado precompra, `ACTION_FEATURES` se recalcula para la compra observada o
cada candidato, `LABEL_COLUMNS` nunca entra al modelo y
`PROPENSITY_FEATURES` es estrictamente un subconjunto del estado. En
particular `macro_buy_case` y `economy_intent` son atributos de la accion, no
del estado, y se vuelven a clasificar al simular cada alternativa.

El propensity model usa regresion logistica sin `class_weight=balanced` y
probabilidades out-of-fold con ventanas temporales expansivas agrupadas por
`match_id`. Los pesos son stabilized IPW con clipping y reporte de soporte,
overlap, percentiles, tasa de clipping y effective sample size. Es una
correccion observacional; no se implementa ni se declara AIPW.

Para cada label se comparan regresion logistica e HistGradientBoosting y las
opciones de calibracion en el conjunto de calibracion. El criterio es log loss,
Brier, ECE y despues ROC-AUC. El test queda reservado para la evaluacion final.
Los modelos por rango se consideran por calidad y no solo por especificidad;
un artefacto con test manifiestamente insuficiente se omite.

No se usan como features pre-round kills, damage, resultado de la ronda actual,
plant/defuse actual, score post-round ni loadout enemigo post-buy.

## Creditos

La economia separa tres valores:

- `prebuy_credits_observed`: suma `remaining + spent` cuando la fuente lo trae.
- `prebuy_credits_rules`: reconstruccion por reglas desde la ronda anterior:
  saldo tras compra, win/loss reward, loss streak, kill reward, spike plant
  reward, save penalty, resets de pistol/cambio de mitad/overtime y cap 9000.
- `prebuy_credits_selected`: valor usado por el modelo. En resets obligatorios
  usa reglas. Si observed falta, usa reglas. Si observed y rules chocan mucho,
  usa reglas y marca `credit_estimate_quality = inconsistent`.

Los alias `team_estimated_credits_before_buy` y
`enemy_estimated_credits_before_buy` apuntan al valor selected por
compatibilidad. `prebuy_credits_rules` no debe copiar directamente
`spent + remaining` de la ronda actual.

## Taxonomia

Solo Bulldog, Guardian, Phantom y Vandal cuentan como rifles reales. Operator,
Outlaw y Marshal son snipers y nunca reciben `rifle_default`.

Regen Shield es armadura real intermedia:

- Light Shield: 400 creditos.
- Regen Shield: 650 creditos.
- Heavy Shield: 1000 creditos.

Regen cuenta como armadura fuerte parcial. En fullbuy se permite como downgrade
explicito frente a Heavy Shield con warning y penalty de coherencia.

## Planes Y Cashflow

El analisis postpartida legacy separa:

- `target_loadout_case`: loadout objetivo observado o contrafactual.
- `observed_cashflow_case`: cashflow real observado.
- `planned_cashflow_case`: cashflow calculado para la accion candidata.
- `cashflow_case`: alias compatible que en planes contrafactuales apunta al
  planned cashflow.

Estas etiquetas proceden del post-buy observado y por ello no pertenecen a
`MODEL_FEATURES`. El motor player-first puntua combinaciones individuales
legales y conserva los creditos restantes de cada jugador para las proyecciones.

## Limitaciones

- Modelo observacional, no causal.
- La compra real de habilidades puede no ser observable.
- Solo se conservan cargas de habilidad cuando existe inventario previo
  explícito; casts sin inventario no bastan para inventar cargas restantes.
- Las pickups y drops observados pueden ser hipotesis con confianza reducida.
- AFK compensation se marca como inferida si no esta confirmada.
- Datos incompletos o corruptos de la API pueden degradar la confianza.
- Sin contexto fiable de mapa, posicion y estrategia, Odin temprano se
  penaliza por defecto aunque siga siendo legal.
- La durabilidad exacta de armadura conservada no siempre esta disponible;
  se conserva su clase y valor de catalogo.

## Politica De Artefactos

Los `.joblib` versionados son snapshots demo deliberados para que el TFG pueda
ejecutarse localmente sin un entrenamiento inicial. No deben considerarse un
registro de modelos de produccion. En un despliegue real se entrenan y publican
fuera del repositorio, con almacenamiento y versionado de artefactos dedicado.

No se ignoran ni eliminan desde `.gitignore` porque forman parte de la demo. Se
regeneran con `scripts\entrenamiento_economia.py`; tanto el script como
`POST /economy-ml/train` actualizan el modelo principal y
`round_win_loadout.joblib`.

## Comandos

Reentrenamiento local:

```powershell
venv\Scripts\python.exe scripts\entrenamiento_economia.py
```

Antes de publicar un schema nuevo, validar y regenerar el parquet desde MongoDB:

```powershell
venv\Scripts\python.exe scripts\entrenamiento_economia.py --validate-only
venv\Scripts\python.exe scripts\entrenamiento_economia.py
```

`--validate-only` reconstruye el dataset en memoria y comprueba el contrato sin
guardar ni entrenar. No use `--allow-invalid` para publicar: existe solo para
diagnostico. Tras entrenar, reinicie el backend para cargar los artefactos.

Ese comando entrena tanto los modelos historicos principales como el modelo
opcional round-win. Para entrenar solo este ultimo sobre un parquet existente:

```powershell
$env:PYTHONPATH='backend'
venv\Scripts\python.exe -m modules.economy_ml.train_round_win_model backend\modules\economy_ml\artifacts\economy_round_dataset.parquet
```

Tests backend:

```powershell
$env:PYTHONPATH='backend'; & '.\venv\Scripts\python.exe' -m unittest backend.tests.test_economy_ml backend.tests.test_economy_ledger backend.tests.test_economy_engine_v10 backend.tests.test_economy_routes_v10
```

Build frontend:

```powershell
cd frontend
npm run build
```

Comprobar status del modelo:

```powershell
$env:PYTHONPATH='backend'; venv\Scripts\python.exe -c "from modules.economy_ml.model_registry import status; print(status())"
```

Los artefactos incluyen `schema_version`, `feature_version`, grupos de estado,
accion y labels, numero de partidas, modelo seleccionado, calibracion y
metricas. Con `SCHEMA_VERSION = 11`, artefactos v10 o anteriores se rechazan
hasta reentrenar porque cambio la semantica de las features de accion.
