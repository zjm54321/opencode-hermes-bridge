"""Offline supervisor/child fixtures. Never used by the production entrypoint."""

import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def event(name, value=None):
    record = {"event": name, "pid": os.getpid(), "value": value,
              "time": time.monotonic(),
              "start": Path(f"/proc/{os.getpid()}/stat").read_text().split()[21]}
    fd = os.open(sys.argv[3], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (json.dumps(record) + "\n").encode())
    finally:
        os.close(fd)


def pause():
    while True:
        time.sleep(0.01)


def child(mode):
    event("owned")
    if mode.startswith("exit"):
        return int(mode[4:])
    if mode == "wait":
        result = subprocess.run([sys.executable, __file__, "child", "unused", sys.argv[3], "exit23"])
        event("wait_result", result.returncode)
        return 0 if result.returncode == 23 else 99
    if mode == "orphan":
        if os.fork() == 0:
            os.setsid()
            event("owned")
            if os.fork() == 0:
                event("orphan")
                time.sleep(0.15)
                os._exit(31)
            os._exit(19)
        time.sleep(0.03)
        return 7
    if mode == "descendant":
        if os.fork() == 0:
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            event("descendant_ready")
            pause()
        time.sleep(0.08)
        return 0
    if mode == "cleanup_signal":
        ready_read, ready_write = os.pipe()
        if os.fork() == 0:
            os.close(ready_read)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGTERM, lambda *_: event("cleanup_started"))
            event("descendant_ready")
            os.write(ready_write, b"1")
            os.close(ready_write)
            pause()
        os.close(ready_write)
        os.read(ready_read, 1)
        os.close(ready_read)
        return 7
    if mode in ("blocker", "graceful"):
        signal.signal(signal.SIGINT, lambda *_: event("interrupt"))
        signal.signal(signal.SIGTERM, lambda *_: event("terminate"))
        event("ready")
        if mode == "graceful":
            while not any(r["event"] == "interrupt" for r in
                          map(json.loads, Path(sys.argv[3]).read_text().splitlines())):
                time.sleep(0.01)
            time.sleep(0.10)
            return 0
        pause()
    raise ValueError(mode)


def supervisor(mode):
    # PR_SET_CHILD_SUBREAPER is test-only; this does NOT prove real PID-1 behavior.
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            return 77
    except (AttributeError, OSError):
        return 77
    from hermes_bridge.init import _supervise
    event("supervisor")
    argv = [sys.executable, __file__, "child", "unused", sys.argv[3], mode]
    if mode == "execfail":
        argv = [str(Path(sys.argv[3]).parent / "nonexistent-python")]
    code = _supervise(argv, grace=0.35, kill_after=0.65, finish_after=0.95,
                      cleanup_term=0.25, cleanup_reap=0.15, poll=0.01)
    try:
        remaining = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        event("drained")
    else:
        event("not_drained", remaining)
    event("result", code)
    return code


if __name__ == "__main__":
    sys.exit(supervisor(sys.argv[4]) if sys.argv[1] == "supervisor" else child(sys.argv[4]))
