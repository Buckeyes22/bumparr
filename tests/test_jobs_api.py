"""Contract checks for the read-only `GET /api/jobs` list (see bumparr/app.py).

The in-memory job registry (`_JOBS`) is process-global state shared with
`bumparr.app`, so each test seeds it directly under `_JOB_LOCK`, saving and
restoring whatever was already there rather than touching the DB or a
subprocess — `list_jobs` never opens the database, so the subprocess
isolation `tests/test_app_api.py` uses for DB-backed routes is not needed
here.
"""
import time
import unittest

from bumparr.app import _JOB_LOCK, _JOBS, list_jobs


class JobsApi(unittest.TestCase):
    def setUp(self):
        with _JOB_LOCK:
            self._saved = dict(_JOBS)
            _JOBS.clear()
        self.addCleanup(self._restore)

    def _restore(self):
        with _JOB_LOCK:
            _JOBS.clear()
            _JOBS.update(self._saved)

    def _seed(self, job_id, **fields):
        now = time.time()
        base = {"status": "done", "result": None, "request": "job",
                "created_at": now, "updated_at": now, "worker_active": False}
        base.update(fields)
        with _JOB_LOCK:
            _JOBS[job_id] = base

    def test_orders_newest_first(self):
        self._seed("a", created_at=1.0)
        self._seed("b", created_at=3.0)
        self._seed("c", created_at=2.0)
        out = list_jobs(limit=20)
        self.assertEqual([j["id"] for j in out["jobs"]], ["b", "c", "a"])
        self.assertEqual(out["count"], 3)

    def test_limit_truncates_the_list(self):
        for i in range(5):
            self._seed(str(i), created_at=float(i))
        out = list_jobs(limit=2)
        self.assertEqual(out["count"], 2)
        self.assertEqual([j["id"] for j in out["jobs"]], ["4", "3"])

    def test_request_truncated_at_120_chars_with_ellipsis(self):
        long_label = "x" * 150
        self._seed("a", request=long_label, created_at=1.0)
        self._seed("b", request="short", created_at=2.0)
        out = list_jobs(limit=20)
        by_id = {j["id"]: j for j in out["jobs"]}
        self.assertEqual(by_id["a"]["request"], "x" * 120 + "…")
        self.assertEqual(len(by_id["a"]["request"]), 121)
        self.assertEqual(by_id["b"]["request"], "short")

    def test_string_result_truncated_at_2000_chars(self):
        self._seed("a", result="y" * 2500, created_at=1.0, status="done")
        out = list_jobs(limit=20)
        self.assertEqual(len(out["jobs"][0]["result"]), 2000)

    def test_dict_result_values_truncated_including_nested_dicts(self):
        big = "z" * 2500
        self._seed("a", created_at=1.0, status="done",
                   result={"stdout": big, "nested": {"stderr": big}, "ok": True, "n": 3})
        out = list_jobs(limit=20)
        r = out["jobs"][0]["result"]
        self.assertEqual(len(r["stdout"]), 2000)
        self.assertEqual(len(r["nested"]["stderr"]), 2000)
        self.assertIs(r["ok"], True)
        self.assertEqual(r["n"], 3)

    def test_other_result_types_are_stringified_and_bounded(self):
        self._seed("a", created_at=1.0, status="done", result=["x"] * 2000)
        out = list_jobs(limit=20)
        result = out["jobs"][0]["result"]
        self.assertIsInstance(result, str)
        self.assertLessEqual(len(result), 2000)

    def test_none_result_stays_null(self):
        self._seed("a", created_at=1.0, status="working", result=None)
        out = list_jobs(limit=20)
        self.assertIsNone(out["jobs"][0]["result"])

    def test_expired_jobs_are_pruned_from_the_list(self):
        now = time.time()
        self._seed("old", created_at=now - 999999, updated_at=now - 999999,
                   status="done", worker_active=False)
        self._seed("new", created_at=now, updated_at=now,
                   status="done", worker_active=False)
        out = list_jobs(limit=20)
        self.assertEqual([j["id"] for j in out["jobs"]], ["new"])

    def test_still_working_jobs_are_never_pruned_regardless_of_age(self):
        now = time.time()
        self._seed("stale-working", created_at=now - 999999, updated_at=now - 999999,
                   status="working", worker_active=True, result=None)
        out = list_jobs(limit=20)
        self.assertEqual([j["id"] for j in out["jobs"]], ["stale-working"])

    def test_no_internal_keys_leak(self):
        self._seed("a", created_at=1.0, worker_active=True)
        out = list_jobs(limit=20)
        self.assertEqual(set(out["jobs"][0]),
                         {"id", "request", "status", "created_at", "updated_at", "result"})

    def test_hostile_strings_come_back_as_plain_json_data(self):
        hostile = "<script>alert(1)</script>\"; DROP TABLE jobs; --"
        self._seed("a", created_at=1.0, request=hostile, result=hostile, status="done")
        out = list_jobs(limit=20)
        job = out["jobs"][0]
        self.assertIn("<script>alert(1)</script>", job["request"])
        self.assertIn("<script>alert(1)</script>", job["result"])

    def test_response_truncation_never_mutates_the_registry(self):
        self._seed("a", created_at=1.0, request="x" * 200, status="done",
                   result="y" * 3000)
        list_jobs(limit=20)
        with _JOB_LOCK:
            self.assertEqual(len(_JOBS["a"]["request"]), 200)
            self.assertEqual(len(_JOBS["a"]["result"]), 3000)

    def test_is_a_pure_read(self):
        """list_jobs must not start, cancel, or otherwise change a job's shape."""
        self._seed("a", created_at=1.0, status="working", result=None)
        list_jobs(limit=20)
        with _JOB_LOCK:
            self.assertEqual(_JOBS["a"]["status"], "working")
            self.assertIsNone(_JOBS["a"]["result"])
            self.assertEqual(set(_JOBS["a"]),
                             {"status", "result", "request", "created_at",
                              "updated_at", "worker_active"})


if __name__ == "__main__":
    unittest.main()
