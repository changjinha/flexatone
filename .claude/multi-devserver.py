"""One process, several ports: open a different preset on each port.
Autosave (IndexedDB + localStorage) is per origin, so each port keeps its own project
across refreshes. Tabs on the same port share one autosave slot.
한 프로세스로 여러 포트를 엽니다. 자동 저장은 origin(포트)별이라 포트마다 다른 프리셋이 유지됩니다.

Usage: python3 .claude/multi-devserver.py 8101 8104   (ports 8101..8104)
"""
import sys
import threading
import http.server
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from devserver import NoCacheHandler  # noqa: E402

if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 8101
    last = int(sys.argv[2]) if len(sys.argv) > 2 else first + 3
    servers = [http.server.ThreadingHTTPServer(("", p), NoCacheHandler) for p in range(first, last + 1)]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("Flexatone preset slots: " + ", ".join(f"http://localhost:{p}" for p in range(first, last + 1)), flush=True)
    servers[0].serve_forever()
