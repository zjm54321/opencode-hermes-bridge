"""Minimal PID-1 supervisor; never imports the companion or opens its database."""

import errno
import os
import signal
import sys
import time


def _send(target, signum, *, group=False):
    try:
        (os.killpg if group else os.kill)(target, signum)
    except ProcessLookupError:
        pass


def _exit_code(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 128 + os.WTERMSIG(status)


def _supervise(argv, *, grace=20.0, kill_after=25.0, finish_after=27.0,
               cleanup_term=5.0, cleanup_reap=2.0, poll=0.025):
    """Own waitpid exclusively. Timing injection is internal, for offline tests.

    Group signals do not reach descendants which create a new session. In
    production the final PID-1 exit also tears down the private PID namespace.
    """
    stopping = False

    def request_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    previous = {sig: signal.getsignal(sig)
                for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in previous:
        signal.signal(sig, request_stop)
    try:
        child = os.fork()
        if child == 0:
            try:
                os.setsid()
                for sig in (*previous, signal.SIGCHLD):
                    signal.signal(sig, signal.SIG_DFL)
                signal.pthread_sigmask(signal.SIG_SETMASK, [])
                os.execv(argv[0], argv)
            except BaseException:
                # No exception/argv/environment disclosure and no parent atexit.
                try:
                    os.write(2, b"hermes_bridge.init: child exec failed\n")
                finally:
                    os._exit(127)

        main_status = None
        stop_at = None
        term_at = kill_at = finish_at = None
        term_sent = kill_sent = False
        cleanup_started = False
        while True:
            no_children = False
            # Only this interpreter reaps its children and adopted orphans.
            # The companion's subprocess.wait() runs in a separate interpreter.
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except OSError as exc:
                    if exc.errno == errno.EINTR:
                        continue
                    if exc.errno == errno.ECHILD:
                        no_children = True
                        break
                    raise
                if pid == 0:
                    break
                if pid == child:
                    main_status = status

            now = time.monotonic()
            if stopping and stop_at is None:
                stop_at = now
                if main_status is None:
                    term_at = now + grace
                    kill_at = now + kill_after
                    finish_at = now + finish_after
                    # Let HTTP KeyboardInterrupt close gracefully first.
                    _send(child, signal.SIGINT)

            if main_status is not None and not cleanup_started:
                cleanup_started = True
                term_at = now
                kill_at = min(kill_at, now + cleanup_term) if kill_at is not None else now + cleanup_term
                end = now + cleanup_term + cleanup_reap
                finish_at = min(finish_at, end) if finish_at is not None else end

            if no_children:
                return _exit_code(main_status) if main_status is not None else 1
            if term_at is not None and now >= term_at and not term_sent:
                _send(child, signal.SIGTERM, group=True)
                term_sent = True
            if kill_at is not None and now >= kill_at and not kill_sent:
                _send(child, signal.SIGKILL, group=True)
                kill_sent = True
            if finish_at is not None and now >= finish_at:
                return _exit_code(main_status) if main_status is not None else 1
            time.sleep(poll)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main():
    if os.getpid() != 1:
        print("hermes_bridge.init: must run as PID 1", file=sys.stderr)
        return 1
    if not os.path.isabs(sys.executable):
        print("hermes_bridge.init: absolute Python executable required", file=sys.stderr)
        return 1
    return _supervise([sys.executable, "-m", "hermes_bridge", *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
