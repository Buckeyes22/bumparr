"""M6: background loops survive transient errors; stat failures read as unknown."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import app as webapp
from bumparr import config, db, jobs


class RefreshOnce(unittest.TestCase):
    """One capture failure must not prevent the fetch-queue pass in the same cycle."""

    def test_failing_capture_does_not_block_fetch(self):
        """A stubbed failing capture still lets the fetch-queue pass run."""
        with mock.patch.object(jobs, "_run_capture", side_effect=RuntimeError("boom")), \
                mock.patch.object(jobs, "_run_fetch_queue") as fetch:
            asyncio.run(jobs._refresh_once())
            fetch.assert_called_once_with()

    def test_subsequent_refresh_succeeds(self):
        """After a failing cycle, a subsequent _refresh_once() succeeds."""
        with mock.patch.object(jobs, "_run_capture", side_effect=RuntimeError("boom")), \
                mock.patch.object(jobs, "_run_fetch_queue"):
            asyncio.run(jobs._refresh_once())
        with mock.patch.object(jobs, "_run_capture") as capture, \
                mock.patch.object(jobs, "_run_fetch_queue") as fetch:
            asyncio.run(jobs._refresh_once())
            capture.assert_called_once_with()
            fetch.assert_called_once_with()

    def test_initial_pass_captures_when_missing(self):
        """The initial pass captures when windows are missing, then fetches."""
        with tempfile.TemporaryDirectory() as td, \
                mock.patch.object(jobs, "WINDOWS_DIR", Path(td)), \
                mock.patch.object(jobs, "_run_capture") as capture, \
                mock.patch.object(jobs, "_run_fetch_queue") as fetch:
            asyncio.run(jobs._refresh_once(initial=True))
            capture.assert_called_once_with()
            fetch.assert_called_once_with()

    def test_cancelled_error_reraised(self):
        """CancelledError is re-raised, and the fetch pass does not run after it."""
        with mock.patch.object(jobs, "_run_capture", side_effect=asyncio.CancelledError), \
                mock.patch.object(jobs, "_run_fetch_queue") as fetch:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(jobs._refresh_once())
            fetch.assert_not_called()


class DatedOnce(unittest.TestCase):
    """A failing rotation must not prevent the seasonal pass in the same cycle."""

    def test_failing_rotation_does_not_block_seasons(self):
        """A stubbed failing rotation still lets the seasons pass run."""
        with mock.patch.object(jobs, "_rotate_dated_cards", side_effect=RuntimeError("db locked")), \
                mock.patch.object(jobs, "_apply_seasons") as seasons:
            asyncio.run(jobs._dated_once())
            seasons.assert_called_once_with()

    def test_cancelled_error_reraised(self):
        """CancelledError from rotation propagates out of _dated_once."""
        with mock.patch.object(jobs, "_rotate_dated_cards", side_effect=asyncio.CancelledError), \
                mock.patch.object(jobs, "_apply_seasons") as seasons:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(jobs._dated_once())
            seasons.assert_not_called()


class NewestWindowAge(unittest.TestCase):
    """Stat failures mean 'unknown, capture' (None), never a crash."""

    def test_stat_error_returns_none(self):
        """An unreadable windows dir reads as unknown, not a raise."""
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "win_000.mp4").write_bytes(b"x" * 100)
            with mock.patch.object(jobs, "WINDOWS_DIR", Path(td)), \
                    mock.patch.object(Path, "stat", side_effect=OSError("denied")):
                self.assertIsNone(jobs._newest_window_age())

    def test_missing_dir_returns_none(self):
        """No windows dir at all is unknown, not a raise."""
        with mock.patch.object(jobs, "WINDOWS_DIR", Path("/nonexistent-bumparr-windows")):
            self.assertIsNone(jobs._newest_window_age())


class ActionJobs(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.semaphore = webapp._JOB_SEMAPHORE
        webapp._JOB_SEMAPHORE = asyncio.Semaphore(2)
        with webapp._JOB_LOCK:
            webapp._JOBS.clear()
            webapp._JOB_TASKS.clear()

    async def asyncTearDown(self):
        tasks = list(webapp._JOB_TASKS.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        webapp._JOB_SEMAPHORE = self.semaphore

    async def test_finished_jobs_expire_but_working_jobs_are_retained(self):
        now = time.time()
        with webapp._JOB_LOCK:
            webapp._JOBS.update({
                "done": {"status": "done", "updated_at": now - webapp._JOB_TTL - 1},
                "working": {"status": "working", "updated_at": now - webapp._JOB_TTL - 1},
                "timed-out-active": {"status": "error", "worker_active": True,
                                     "updated_at": now - webapp._JOB_TTL - 1},
            })
        webapp._prune_jobs(now)
        self.assertNotIn("done", webapp._JOBS)
        self.assertIn("working", webapp._JOBS)
        self.assertIn("timed-out-active", webapp._JOBS)

    async def test_blocking_actions_never_exceed_concurrency_cap(self):
        lock = threading.Lock()
        active = maximum = 0

        def work():
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.05)
            with lock:
                active -= 1
            return "ok"

        results = [webapp._start_job("test", work) for _ in range(5)]
        self.assertTrue(all(result.get("job_id") for result in results))
        await asyncio.gather(*list(webapp._JOB_TASKS.values()))
        self.assertEqual(maximum, 2)
        self.assertTrue(all(job["status"] == "done" for job in webapp._JOBS.values()))

    async def test_timed_out_thread_keeps_slot_and_record_until_exit(self):
        webapp._JOB_SEMAPHORE = asyncio.Semaphore(1)
        started = threading.Event()
        release = threading.Event()
        second_ran = threading.Event()

        def slow():
            started.set()
            release.wait(timeout=2)
            return "late"

        first = webapp._start_job("slow", slow, deadline=0.02)
        self.assertTrue(await asyncio.to_thread(started.wait, 1))
        await asyncio.sleep(0.05)
        with webapp._JOB_LOCK:
            timed_out = dict(webapp._JOBS[first["job_id"]])
        self.assertEqual(timed_out["status"], "error")
        self.assertTrue(timed_out["worker_active"])

        second = webapp._start_job("second", lambda: second_ran.set() or "ok",
                                   deadline=1)
        await asyncio.sleep(0.05)
        self.assertFalse(second_ran.is_set())
        self.assertIn(first["job_id"], webapp._JOBS)
        release.set()
        await asyncio.gather(*list(webapp._JOB_TASKS.values()))
        self.assertTrue(second_ran.is_set())
        self.assertFalse(webapp._JOBS[first["job_id"]]["worker_active"])
        self.assertEqual(webapp._JOBS[second["job_id"]]["status"], "done")


class RenderCardsRoute(unittest.IsolatedAsyncioTestCase):
    """POST /api/render/cards?bumper_id=... — validated before any job starts.

    `_run` is mocked in the success case so this never shells out to ffmpeg;
    the batch (no bumper_id) path is unchanged and covered elsewhere.
    """

    async def asyncSetUp(self):
        self.semaphore = webapp._JOB_SEMAPHORE
        webapp._JOB_SEMAPHORE = asyncio.Semaphore(2)
        with webapp._JOB_LOCK:
            webapp._JOBS.clear()
            webapp._JOB_TASKS.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        originals = (config.DB_PATH, config.ASSET_ROOT, config.OUTPUT_DIR)
        config.DB_PATH = str(Path(self.tmp.name) / "render.db")
        config.ASSET_ROOT = Path(self.tmp.name) / "assets"
        config.OUTPUT_DIR = config.ASSET_ROOT / "bumpers"
        config.ASSET_ROOT.mkdir(); config.OUTPUT_DIR.mkdir()
        for attr, value in zip(("DB_PATH", "ASSET_ROOT", "OUTPUT_DIR"), originals):
            self.addCleanup(setattr, config, attr, value)
        db.init_db()

    async def asyncTearDown(self):
        tasks = list(webapp._JOB_TASKS.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        webapp._JOB_SEMAPHORE = self.semaphore

    def _seed(self, pid, type_="card", uri=None):
        with db.conn() as c:
            c.execute(
                "INSERT INTO playables (id,type,kind,uri,duration,enabled,health,payload) "
                "VALUES (?,?,?,?,?,1,'ok','{}')", (pid, type_, "trivia", uri, 8))
            c.commit()

    async def test_unknown_bumper_id_is_404(self):
        out = await webapp.render_cards(bumper_id="nope")
        self.assertEqual(out.status_code, 404)
        self.assertEqual(json.loads(out.body), {"error": "not found"})

    async def test_non_card_bumper_id_is_400(self):
        self._seed("v", type_="video", uri="ambient/x.mp4")
        out = await webapp.render_cards(bumper_id="v")
        self.assertEqual(out.status_code, 400)
        self.assertEqual(json.loads(out.body), {"error": "not a card"})

    async def test_card_bumper_id_returns_a_job_whose_label_contains_the_id(self):
        self._seed("t:card-1")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(webapp, "_run", return_value=completed) as run:
            out = await webapp.render_cards(bumper_id="t:card-1")
            self.assertIn("job_id", out)
            with webapp._JOB_LOCK:
                label = webapp._JOBS[out["job_id"]]["request"]
            self.assertIn("t:card-1", label)
            await asyncio.gather(*list(webapp._JOB_TASKS.values()))
        run.assert_called_once_with("bumparr.render_cards", "--id", "t:card-1")

    async def test_bumper_id_force_is_forwarded_to_the_cli(self):
        self._seed("t:card-2")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(webapp, "_run", return_value=completed) as run:
            await webapp.render_cards(bumper_id="t:card-2", force=True)
            await asyncio.gather(*list(webapp._JOB_TASKS.values()))
        run.assert_called_once_with("bumparr.render_cards", "--id", "t:card-2", "--force")

    async def test_batch_path_unchanged_when_bumper_id_absent(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(webapp, "_run", return_value=completed) as run:
            out = await webapp.render_cards(limit=5, force=True)
            await asyncio.gather(*list(webapp._JOB_TASKS.values()))
        run.assert_called_once_with("bumparr.render_cards", "--limit", "5", "--force")
        with webapp._JOB_LOCK:
            self.assertEqual(webapp._JOBS[out["job_id"]]["request"], "render cards")


class ChannelMemoryLoop(unittest.TestCase):
    """Channel-memory refresh isolates failures and honours 0-disable."""

    def test_zero_refresh_disables_the_loop(self):
        with mock.patch("bumparr.config.CHANNEL_MEMORY_REFRESH", 0), \
                mock.patch.object(jobs, "_refresh_channel_memory") as refresh:
            asyncio.run(jobs.channel_memory_loop())
            refresh.assert_not_called()

    def test_failing_refresh_does_not_raise(self):
        with mock.patch.object(jobs, "_refresh_channel_memory",
                               side_effect=RuntimeError("boom")):
            asyncio.run(jobs._memory_once())

    def test_cancelled_error_reraised(self):
        with mock.patch.object(jobs, "_refresh_channel_memory",
                               side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(jobs._memory_once())


if __name__ == "__main__":
    unittest.main(verbosity=2)
