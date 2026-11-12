"""Serve the read API.

    python3 -m api [--cache garmin_cache.json] [--lactate-threshold lactate_threshold.csv]
                  [--host 127.0.0.1] [--port 8081] [--static web]
"""

import argparse
import signal

from .server import make_server


def _exit(signum, frame):
    """SIGTERM: stop serving at once. In the pod the API is PID 1, which ignores SIGTERM without a handler, so the
    pod would otherwise take its whole grace period (30s) to stop."""
    raise SystemExit(0)


def main():
    ap = argparse.ArgumentParser(prog="python3 -m api", description="Serve the Garmin cache as a JSON API.")
    ap.add_argument("--cache", default="garmin_cache.json")
    ap.add_argument("--lactate-threshold", default="lactate_threshold.csv", metavar="CSV",
                    help="hand-kept lactate threshold log (date,heart_rate,pace); optional")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8081)
    ap.add_argument("--static", metavar="DIR", help="also serve the frontend from this directory at / (e.g. web)")
    args = ap.parse_args()

    server = make_server(args.cache, args.host, args.port, args.static, args.lactate_threshold)
    print(f"api on http://{args.host}:{args.port}" + (f" (serving {args.static} at /)" if args.static else ""), flush=True)
    signal.signal(signal.SIGTERM, _exit)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
