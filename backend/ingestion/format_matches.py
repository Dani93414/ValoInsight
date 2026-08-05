#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


# ----------------------------
# Helpers
# ----------------------------

def iso_to_epoch_ms(iso_str: str) -> Optional[int]:
    """Convierte '2026-02-19T23:00:37.217Z' a epoch ms."""
    if not iso_str:
        return None
    try:
        if iso_str.endswith("Z"):
            iso_str = iso_str[:-1] + "+00:00"
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def load_template(path: Path) -> Dict[str, Any]:
    """
    FormatoPartida.txt es JSON salvo por 'List[empty]'.
    Lo normalizamos a JSON válido y lo parseamos.
    """
    raw = path.read_text(encoding="utf-8").replace("List[empty]", "[]")
    return json.loads(raw)


def warn(msg: str) -> None:
    print(f"[WARN] {msg}", file=sys.stderr)


def unwrap_source(src_raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Tus ficheros pueden venir como:
      { "status": ..., "data": { ... } }
    o directamente como { ... }.
    """
    if isinstance(src_raw, dict) and "data" in src_raw and isinstance(src_raw["data"], dict):
        return src_raw["data"]
    return src_raw


# ----------------------------
# Strict normalizer
# ----------------------------

def strict_like(template: Any, data: Any) -> Any:
    """
    Devuelve un objeto con EXACTA estructura del template:
      - mismas claves
      - listas con el patrón del template
      - valores faltantes => valor por defecto EXACTO del template
      - campos extra en data => se descartan
    """
    # Dict: solo keys del template
    if isinstance(template, dict):
        out = {}
        d = data if isinstance(data, dict) else {}
        for k, tv in template.items():
            if isinstance(d, dict) and k in d:
                out[k] = strict_like(tv, d[k])
            else:
                out[k] = copy.deepcopy(tv)
        return out

    # List:
    if isinstance(template, list):
        # Caso template []: lista libre pero queremos lista (si data no es lista => [])
        if len(template) == 0:
            if isinstance(data, list):
                return copy.deepcopy(data)
            return []

        # Caso template [schema]: lista de elementos schema
        schema = template[0]
        if not isinstance(data, list):
            return []
        return [strict_like(schema, item) for item in data]

    # Primitivos: si data es None -> default template, si no -> data
    if data is None:
        return copy.deepcopy(template)
    return data


# ----------------------------
# Builder
# ----------------------------

def build_output(template: Dict[str, Any], src_raw: Dict[str, Any]) -> Dict[str, Any]:
    src = unwrap_source(src_raw)
    meta = src.get("metadata", {}) if isinstance(src.get("metadata"), dict) else {}

    out_pre: Dict[str, Any] = {}

    # ---------- matchInfo ----------
    mi_pre = {}
    mi_pre["matchId"] = meta.get("match_id")
    mi_pre["mapId"] = (meta.get("map") or {}).get("id")
    mi_pre["gameVersion"] = meta.get("game_version")
    mi_pre["gameLengthMillis"] = meta.get("game_length_in_ms")
    mi_pre["region"] = meta.get("region")
    mi_pre["gameStartMillis"] = iso_to_epoch_ms(meta.get("started_at", "")) if meta.get("started_at") else None
    mi_pre["provisioningFlowId"] = meta.get("provisioning_flow_id")
    mi_pre["isCompleted"] = meta.get("is_completed")
    mi_pre["customGameName"] = meta.get("custom_game_name")
    mi_pre["queueId"] = (meta.get("queue") or {}).get("id")
    mi_pre["gameMode"] = (meta.get("queue") or {}).get("mode_type")
    mi_pre["seasonId"] = (meta.get("season") or {}).get("id")

    ranked = meta.get("is_ranked")
    if ranked is None:
        qid = (meta.get("queue") or {}).get("id")
        ranked = True if qid == "competitive" else False
    mi_pre["isRanked"] = ranked

    # premierMatchInfo: template lo modela como lista
    premier = meta.get("premier")
    if premier is None:
        mi_pre["premierMatchInfo"] = []
    elif isinstance(premier, list):
        mi_pre["premierMatchInfo"] = premier
    else:
        mi_pre["premierMatchInfo"] = [premier]

    out_pre["matchInfo"] = mi_pre

    # ---------- teams ----------
    teams_pre: List[Dict[str, Any]] = []
    for t in (src.get("teams") or []):
        rounds = t.get("rounds") or {}
        won = rounds.get("won")
        lost = rounds.get("lost")
        rounds_played = (int(won) + int(lost)) if (won is not None and lost is not None) else None

        teams_pre.append({
            "teamId": t.get("team_id"),
            "won": t.get("won"),
            "roundsPlayed": rounds_played,
            "roundsWon": won,
            # No existe numPoints en tu source: lo dejamos para que strict_like ponga default 0
            "numPoints": None,
        })
    out_pre["teams"] = teams_pre

    # total_rounds para players.stats.roundsPlayed
    total_rounds = None
    if teams_pre and isinstance(teams_pre[0].get("roundsPlayed"), int):
        total_rounds = teams_pre[0]["roundsPlayed"]

    game_len = meta.get("game_length_in_ms")
    if not isinstance(game_len, int):
        game_len = None

    # ---------- players ----------
    players_pre: List[Dict[str, Any]] = []
    for p in (src.get("players") or []):
        stats = p.get("stats") or {}
        casts = p.get("ability_casts") or {}
        cust = p.get("customization") or {}

        playtime = p.get("session_playtime_in_ms")
        # clamp: si viene mal, lo hacemos coherente con la duración del match
        if isinstance(game_len, int):
            if not isinstance(playtime, int) or playtime <= 0 or playtime > int(game_len * 1.2):
                playtime = game_len

        players_pre.append({
            "puuid": p.get("puuid"),
            "gameName": p.get("name"),
            "tagLine": p.get("tag"),
            "teamId": p.get("team_id"),
            "partyId": p.get("party_id"),
            "characterId": (p.get("agent") or {}).get("id"),
            "stats": {
                "score": stats.get("score"),
                "roundsPlayed": total_rounds,
                "kills": stats.get("kills"),
                "deaths": stats.get("deaths"),
                "assists": stats.get("assists"),
                "playtimeMillis": playtime,
                "abilityCasts": {
                    "grenadeCasts": casts.get("grenade"),
                    "ability1Casts": casts.get("ability1"),
                    "ability2Casts": casts.get("ability2"),
                    "ultimateCasts": casts.get("ultimate"),
                }
            },
            "competitiveTier": (p.get("tier") or {}).get("id"),
            "playerCard": cust.get("card"),
            "playerTitle": cust.get("title"),
            "accountLevel": p.get("account_level"),
        })

    out_pre["players"] = players_pre

    # ---------- coaches ----------
    coaches_pre: List[Dict[str, Any]] = []
    for c in (src.get("coaches") or []):
        coaches_pre.append({
            "puuid": c.get("puuid"),
            "teamId": c.get("team_id"),
        })
    out_pre["coaches"] = coaches_pre

    # ---------- roundResults ----------
    # index kills by round
    kills_by_round: Dict[int, List[Dict[str, Any]]] = {}
    for k in (src.get("kills") or []):
        rnum = k.get("round")
        if rnum is None:
            continue
        kills_by_round.setdefault(int(rnum), []).append(k)

    round_results_pre: List[Dict[str, Any]] = []

    for r in (src.get("rounds") or []):
        rid = r.get("id")
        plant = r.get("plant")
        defuse = r.get("defuse")

        rr = {
            "roundNum": rid,
            "roundResult": r.get("result"),
            "roundCeremony": r.get("ceremony"),
            "winningTeam": r.get("winning_team"),
            # source no trae roles => dejamos None y strict_like pondrá "string" del template
            "winningTeamRole": None,
            "bombPlanter": (plant or {}).get("player", {}).get("puuid") if plant else None,
            "bombDefuser": (defuse or {}).get("player", {}).get("puuid") if defuse else None,
            "plantRoundTime": (plant or {}).get("round_time_in_ms") if plant else None,
            "plantPlayerLocations": [],
            "plantLocation": (plant or {}).get("location") if plant else None,
            "plantSite": (plant or {}).get("site") if plant else None,
            "defuseRoundTime": (defuse or {}).get("round_time_in_ms") if defuse else None,
            "defusePlayerLocations": [],
            "defuseLocation": (defuse or {}).get("location") if defuse else None,
            "playerStats": [],
            "roundResultCode": None,
        }

        # plant locations
        if plant and plant.get("player_locations"):
            for loc in plant["player_locations"]:
                rr["plantPlayerLocations"].append({
                    "puuid": (loc.get("player") or {}).get("puuid"),
                    "viewRadians": loc.get("view_radians"),
                    "location": loc.get("location"),
                })

        # defuse locations
        if defuse and defuse.get("player_locations"):
            for loc in defuse["player_locations"]:
                rr["defusePlayerLocations"].append({
                    "puuid": (loc.get("player") or {}).get("puuid"),
                    "viewRadians": loc.get("view_radians"),
                    "location": loc.get("location"),
                })

        # playerStats
        ps_by_puuid: Dict[str, Dict[str, Any]] = {}
        for ps in (r.get("stats") or []):
            puuid = (ps.get("player") or {}).get("puuid")
            eco = ps.get("economy") or {}

            ops = {
                "puuid": puuid,
                "kills": [],
                "damage": [],
                "score": (ps.get("stats") or {}).get("score"),
                "economy": {
                    "loadoutValue": eco.get("loadout_value"),
                    "weapon": (eco.get("weapon") or {}).get("id"),
                    "armor": (eco.get("armor") or {}).get("id") if eco.get("armor") else None,
                    "remaining": eco.get("remaining"),
                    # HenrikDev v4 does not expose real round spend. Keep this
                    # compatibility value explicitly quarantined; economy_ml
                    # v12 never uses it as observed purchase evidence.
                    "spent": max(0, (eco.get("loadout_value") or 0) - (eco.get("remaining") or 0)),
                    "spentSource": "legacy_invalid_loadout_minus_remaining",
                    "observedFields": ["loadoutValue", "weapon", "armor", "remaining"],
                },
                "ability": {
                    # No existe en tu source => default "string" del template
                    "grenadeEffects": None,
                    "ability1Effects": None,
                    "ability2Effects": None,
                    "ultimateEffects": None,
                },
                "sourceMetadata": {
                    key: ps.get(key)
                    for key in (
                        "was_afk", "afk", "stayed_in_spawn", "stayedInSpawn",
                        "penalty", "penalties", "behavior", "disconnected",
                    )
                    if key in ps
                },
            }

            # damage_events
            for de in (ps.get("damage_events") or []):
                ops["damage"].append({
                    "receiver": (de.get("player") or {}).get("puuid"),
                    "damage": de.get("damage"),
                    "legshots": de.get("legshots"),
                    "bodyshots": de.get("bodyshots"),
                    "headshots": de.get("headshots"),
                })

            rr["playerStats"].append(ops)
            if puuid is not None:
                ps_by_puuid[puuid] = ops

        # kills -> a la lista del killer
        if isinstance(rid, int):
            for k in kills_by_round.get(rid, []):
                killer = (k.get("killer") or {}).get("puuid")
                victim = (k.get("victim") or {}).get("puuid")
                if not killer or killer not in ps_by_puuid:
                    continue

                loc = k.get("location") or {}
                weap = k.get("weapon") or {}
                assistants = []
                for a in (k.get("assistants") or []):
                    ap = (a or {}).get("puuid")
                    if ap:
                        assistants.append(ap)

                plocs = []
                for pl in (k.get("player_locations") or []):
                    plocs.append({
                        "puuid": (pl.get("player") or {}).get("puuid"),
                        "viewRadians": pl.get("view_radians"),
                        "location": pl.get("location"),
                    })

                ps_by_puuid[killer]["kills"].append({
                    "timeSinceGameStartMillis": k.get("time_in_match_in_ms"),
                    "timeSinceRoundStartMillis": k.get("time_in_round_in_ms"),
                    "killer": killer,
                    "victim": victim,
                    "victimLocation": {"x": loc.get("x"), "y": loc.get("y")},
                    "assistants": assistants,
                    "playerLocations": plocs,
                    "finishingDamage": {
                        "damageType": weap.get("type"),
                        "damageItem": weap.get("id"),
                        "isSecondaryFireMode": k.get("secondary_fire_mode"),
                    }
                })

        round_results_pre.append(rr)

    out_pre["roundResults"] = round_results_pre

    # ---------- STRICT FINAL PASS ----------
    # Garantiza output idéntico al template en estructura/tipos/defaults
    out_strict = strict_like(template, out_pre)

    return out_strict


def main():
    ap = argparse.ArgumentParser(
        description="Rellena un JSON con la estructura de FormatoPartida.txt usando otro JSON de partida."
    )
    ap.add_argument("-t", "--template", default="FormatoPartida.txt", help="Ruta a FormatoPartida.txt")
    ap.add_argument("-i", "--input", required=True, help="Ruta al JSON de partida (source)")
    ap.add_argument("-o", "--output", required=True, help="Ruta de salida del JSON generado")
    args = ap.parse_args()

    template_path = Path(args.template)
    input_path = Path(args.input)
    output_path = Path(args.output)

    template = load_template(template_path)
    src = json.loads(input_path.read_text(encoding="utf-8"))

    out = build_output(template, src)

    output_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] Generado: {output_path}")


if __name__ == "__main__":
    main()
