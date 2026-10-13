"""Offline Linux subreaper simulation, not a container/PID-1 acceptance gate."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


FIXTURE = Path(__file__).with_name("init_fixture.py")


class InitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hermes-init-", dir="/tmp/opencode")
        self.events = Path(self.temp.name) / "events.jsonl"
        self.process = None

    def records(self):
        if not self.events.exists():
            return []
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def alive(self, record):
        try:
            return Path(f"/proc/{record['pid']}/stat").read_text().split()[21] == record["start"]
        except FileNotFoundError:
            return False

    def tearDown(self):
        # Only private fixture PIDs with matching Linux start times; no pgrep.
        for record in reversed(self.records()):
            if record["pid"] != (self.process.pid if self.process else None) and self.alive(record):
                try:
                    os.kill(record["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if self.process is not None:
            try:
                self.process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.communicate(timeout=2)
        self.temp.cleanup()

    def start(self, mode):
        self.process = subprocess.Popen(
            [sys.executable, str(FIXTURE), "supervisor", "unused", str(self.events), mode],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def wait_event(self, name):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            matches = [r for r in self.records() if r["event"] == name]
            if matches:
                return matches[0]
            if self.process.poll() == 77:
                self.skipTest("Linux PR_SET_CHILD_SUBREAPER unavailable; real PID 1 not tested")
            if self.process.poll() is not None:
                self.fail(f"fixture exited before {name}: {self.process.communicate()}")
            time.sleep(0.01)
        self.fail(f"fixture did not emit {name}")

    def finish(self, code):
        output = self.process.communicate(timeout=3)
        if self.process.returncode == 77:
            self.skipTest("Linux PR_SET_CHILD_SUBREAPER unavailable; real PID 1 not tested")
        self.assertEqual(self.process.returncode, code, output)
        self.assertIn("drained", [r["event"] for r in self.records()])
        self.assertNotIn("not_drained", [r["event"] for r in self.records()])
        # All recorded children (including double-fork orphans) were reaped.
        self.assertFalse([r for r in self.records() if self.alive(r)])

    def test_graceful_shutdown_forwards_one_interrupt(self):
        self.start("graceful")
        self.wait_event("ready")
        os.kill(self.process.pid, signal.SIGTERM)
        self.wait_event("interrupt")
        os.kill(self.process.pid, signal.SIGTERM)
        os.kill(self.process.pid, signal.SIGINT)
        self.finish(0)
        self.assertEqual(sum(r["event"] == "interrupt" for r in self.records()), 1)
        self.assertNotIn("terminate", [r["event"] for r in self.records()])

    def test_blocker_killed_without_resetting_deadline(self):
        self.start("blocker")
        self.wait_event("ready")
        start = time.monotonic()
        os.kill(self.process.pid, signal.SIGTERM)
        self.wait_event("interrupt")
        for _ in range(5):
            time.sleep(0.10)
            os.kill(self.process.pid, signal.SIGINT)
        self.finish(128 + signal.SIGKILL)
        self.assertLess(time.monotonic() - start, 1.05)
        records = self.records()
        self.assertEqual(sum(r["event"] == "interrupt" for r in records), 1)
        terms = [r for r in records if r["event"] == "terminate"]
        self.assertEqual(len(terms), 1)
        self.assertGreaterEqual(terms[0]["time"] - start, 0.30)

    def test_double_fork_new_session_orphan_reaped(self):
        self.start("orphan")
        self.finish(7)
        self.assertIn("orphan", [r["event"] for r in self.records()])


if __name__ == "__main__":
    unittest.main()
