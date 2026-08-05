import importlib
import json
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for path in (str(PROJECT_ROOT), str(BACKEND_ROOT)):
    if path not in sys.path:
        sys.path.append(path)


class ParallelIngestionPipelineTests(unittest.TestCase):
    def test_thread_safe_rate_limiter_respects_global_interval(self):
        fake_requests = types.ModuleType("requests")
        fake_requests.Session = lambda: types.SimpleNamespace(headers={})
        fake_requests.Timeout = TimeoutError
        fake_requests.ConnectionError = ConnectionError

        fake_dotenv = types.ModuleType("dotenv")
        fake_dotenv.load_dotenv = lambda: None

        originals = {
            name: sys.modules.get(name)
            for name in (
                "requests",
                "dotenv",
                "backend.ingestion.download_matches",
            )
        }

        try:
            sys.modules.setdefault("requests", fake_requests)
            sys.modules.setdefault("dotenv", fake_dotenv)
            sys.modules.pop("backend.ingestion.download_matches", None)
            download_matches = importlib.import_module("backend.ingestion.download_matches")
            ThreadSafeRateLimiter = download_matches.ThreadSafeRateLimiter
        finally:
            for name, module in originals.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module

        limiter = ThreadSafeRateLimiter(rpm=60000, safety_factor=1.0)
        start = time.monotonic()
        limiter.wait()
        limiter.wait()
        elapsed = time.monotonic() - start

        self.assertGreaterEqual(elapsed, limiter.min_interval * 0.8)

    def test_insert_match_only_statuses(self):
        calls = []

        fake_repo = types.ModuleType("modules.matches.infrastructure.mongo_match_repo")

        def fake_insert(match_obj):
            calls.append(match_obj)
            return match_obj["matchInfo"]["matchId"] != "dupe"

        fake_repo.insert = fake_insert
        fake_repo.find_raw_by_match_id = lambda match_id: None
        fake_repo.set_player_analytics = lambda match_id, puuid, analytics: None

        fake_extractor = types.ModuleType("modules.analytics.domain.extractor")
        fake_extractor.build_player_analytics_embedded = lambda match_obj: {}

        fake_players = types.ModuleType("modules.players.application.update_player_from_match")
        fake_players.update_players_from_match = lambda match_obj: None

        fake_regions = types.ModuleType("scripts.regions_update")
        fake_regions.update_region_from_match = lambda match_obj: None
        fake_regions.update_regions = lambda: None

        originals = {
            name: sys.modules.get(name)
            for name in (
                "modules.matches.infrastructure.mongo_match_repo",
                "modules.analytics.domain.extractor",
                "modules.players.application.update_player_from_match",
                "scripts.regions_update",
                "modules.matches.application.ingest_match",
            )
        }

        try:
            sys.modules["modules.matches.infrastructure.mongo_match_repo"] = fake_repo
            infrastructure_package = importlib.import_module("modules.matches.infrastructure")
            previous_repo_attribute = getattr(infrastructure_package, "mongo_match_repo", None)
            infrastructure_package.mongo_match_repo = fake_repo
            sys.modules["modules.analytics.domain.extractor"] = fake_extractor
            sys.modules["modules.players.application.update_player_from_match"] = fake_players
            sys.modules["scripts.regions_update"] = fake_regions
            sys.modules.pop("modules.matches.application.ingest_match", None)

            ingest_match = importlib.import_module("modules.matches.application.ingest_match")

            self.assertEqual(ingest_match.insert_match_only_with_status({}), "failed")
            self.assertEqual(ingest_match.insert_match_only_with_status({"matchInfo": {}}), "failed")
            self.assertEqual(
                ingest_match.insert_match_only_with_status({"matchInfo": {"matchId": "m1"}}),
                "inserted",
            )
            self.assertEqual(
                ingest_match.insert_match_only_with_status({"matchInfo": {"matchId": "dupe"}}),
                "already_exists",
            )
        finally:
            if previous_repo_attribute is None:
                infrastructure_package.__dict__.pop("mongo_match_repo", None)
            else:
                infrastructure_package.mongo_match_repo = previous_repo_attribute
            for name, module in originals.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module

    def test_convert_one_match_file_creates_output_and_skips_existing(self):
        from scripts.descarga_formateo_partidas import build_output_name, convert_one_match_file

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            raw_path = tmp_dir / "raw.json"
            output_dir = tmp_dir / "out"
            output_dir.mkdir()
            raw_payload = {
                "data": {
                    "metadata": {
                        "match_id": "match-1",
                        "started_at": "2026-01-02T03:04:05Z",
                    }
                }
            }
            raw_path.write_text(json.dumps(raw_payload), encoding="utf-8")
            template = {"matchInfo": {"matchId": ""}}

            match_id, status, error = convert_one_match_file(
                raw_path,
                "match-1",
                "2026-01-02T03:04:05Z",
                template,
                output_dir,
                "UTC",
                False,
            )

            self.assertEqual((match_id, status, error), ("match-1", "converted", None))
            out_path = output_dir / build_output_name("2026-01-02T03:04:05Z", "match-1", "UTC")
            self.assertTrue(out_path.exists())
            self.assertFalse(raw_path.exists())
            self.assertFalse(out_path.with_suffix(".json.tmp").exists())

            raw_path.write_text(json.dumps(raw_payload), encoding="utf-8")
            match_id, status, error = convert_one_match_file(
                raw_path,
                "match-1",
                "2026-01-02T03:04:05Z",
                template,
                output_dir,
                "UTC",
                False,
            )

            self.assertEqual((match_id, status, error), ("match-1", "skipped_existing", None))
            self.assertFalse(raw_path.exists())

    def test_upload_one_file_deletion_rules(self):
        fake_mongo_client = types.ModuleType("backend.infrastructure.mongo_client")
        fake_mongo_client.ensure_indexes = lambda: None

        fake_analytics = types.ModuleType("backend.modules.analytics.application.service")
        fake_analytics.rebuild_all_player_match_analytics = lambda batch_size=200: {}

        fake_ingest = types.ModuleType("backend.modules.matches.application.ingest_match")
        fake_ingest.insert_match_only_with_status = lambda payload: payload["status"]
        fake_ingest.recalculate_global_stats = lambda: None

        fake_rebuild_players = types.ModuleType("backend.modules.players.application.rebuild_players")
        fake_rebuild_players.rebuild_players_from_matches = lambda: {}

        originals = {
            name: sys.modules.get(name)
            for name in (
                "backend.infrastructure.mongo_client",
                "backend.modules.analytics.application.service",
                "backend.modules.matches.application.ingest_match",
                "backend.modules.players.application.rebuild_players",
                "scripts.upload_matches_to_mongo_parallel",
            )
        }

        try:
            sys.modules["backend.infrastructure.mongo_client"] = fake_mongo_client
            sys.modules["backend.modules.analytics.application.service"] = fake_analytics
            sys.modules["backend.modules.matches.application.ingest_match"] = fake_ingest
            sys.modules["backend.modules.players.application.rebuild_players"] = fake_rebuild_players
            sys.modules.pop("scripts.upload_matches_to_mongo_parallel", None)

            upload_script = importlib.import_module("scripts.upload_matches_to_mongo_parallel")

            with tempfile.TemporaryDirectory() as tmp:
                input_dir = Path(tmp)
                failed_file = input_dir / "failed.json"
                duplicate_file = input_dir / "duplicate.json"
                inserted_file = input_dir / "inserted.json"
                failed_file.write_text(json.dumps({"status": "failed"}), encoding="utf-8")
                duplicate_file.write_text(json.dumps({"status": "already_exists"}), encoding="utf-8")
                inserted_file.write_text(json.dumps({"status": "inserted"}), encoding="utf-8")

                failed_result = upload_script.upload_one_file(failed_file, input_dir, True, False)
                duplicate_result = upload_script.upload_one_file(duplicate_file, input_dir, False, False)
                inserted_result = upload_script.upload_one_file(inserted_file, input_dir, False, False)

                self.assertEqual(failed_result["status"], "failed")
                self.assertTrue(failed_file.exists())
                self.assertEqual(duplicate_result["status"], "already_exists")
                self.assertTrue(duplicate_file.exists())
                self.assertEqual(inserted_result["status"], "inserted")
                self.assertTrue(inserted_result["deleted"])
                self.assertFalse(inserted_file.exists())
        finally:
            for name, module in originals.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


if __name__ == "__main__":
    unittest.main()
