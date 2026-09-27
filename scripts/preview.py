"""Preview local edits, optionally reading merged catalog data from an isolated Git mirror."""
import argparse
import json
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from scripts.build_site import SOURCE, build
from scripts.catalog import ROOT

PROJECT = Path(__file__).resolve().parents[1]


class ApprovedMirror:
    """Fetch main without touching the developer's checkout or executing remote code."""
    def __init__(self, directory, remote, branch='main'):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.remote = remote
        self.branch = branch
        self.sha = None
        self.git('init', '--quiet')
        self.git('config', 'core.hooksPath', '/dev/null')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.directory), *args], check=True,
                              capture_output=True, text=True, timeout=45).stdout.strip()

    def refresh(self):
        self.git('fetch', '--quiet', '--no-tags', self.remote, f'refs/heads/{self.branch}')
        sha = self.git('rev-parse', 'FETCH_HEAD')
        if sha == self.sha:
            return False
        # Only this disposable mirror is checked out. Builds always use local Python code.
        self.git('checkout', '--quiet', '--detach', '--force', sha)
        self.sha = sha
        return True

    @property
    def data(self):
        return self.directory / 'data'


def fingerprint(paths):
    return tuple((str(file), file.stat().st_mtime_ns, file.stat().st_size)
                 for path in paths for file in sorted(path.rglob('*')) if file.is_file())


def serve(port=8000, github=False, interval=60):
    with tempfile.TemporaryDirectory(prefix='ai-impacts-preview-') as temporary:
        directory = Path(temporary)
        mirror = None
        if github:
            remote = subprocess.check_output(['git', 'remote', 'get-url', 'origin'], cwd=PROJECT, text=True).strip()
            mirror = ApprovedMirror(directory / 'mirror', remote)
            mirror.refresh()
        data = mirror.data if mirror else ROOT
        state = {'version': 0, 'output': None}
        lock = threading.Lock()
        stop = threading.Event()

        def rebuild():
            target = directory / f'site-{state["version"] + 1}'
            if target.exists():
                shutil.rmtree(target)
            build(data, target, SOURCE)
            with lock:
                state.update(version=state['version'] + 1, output=target)
            for old in directory.glob('site-*'):
                if int(old.name.split('-')[1]) < state['version'] - 2:
                    shutil.rmtree(old, ignore_errors=True)
            print('Preview updated from ' + ('GitHub main.' if mirror else 'local files.'), flush=True)

        rebuild()

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                with lock:
                    current = state['output']
                super().__init__(*args, directory=str(current), **kwargs)

            def end_headers(self):
                self.send_header('Cache-Control', 'no-store')
                super().end_headers()

            def do_GET(self):
                if self.path == '/__preview_version':
                    payload = json.dumps({'version': state['version']}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                return super().do_GET()

        def watch():
            stamp = fingerprint([SOURCE] + ([] if mirror else [ROOT]))
            next_fetch = time.monotonic() + interval
            while not stop.wait(1):
                try:
                    changed = False
                    if mirror and time.monotonic() >= next_fetch:
                        next_fetch = time.monotonic() + interval
                        changed = mirror.refresh()
                    latest = fingerprint([SOURCE] + ([] if mirror else [ROOT]))
                    if changed or latest != stamp:
                        rebuild()
                        stamp = latest
                except (OSError, ValueError, subprocess.SubprocessError):
                    # Never replace a working preview with a partial or invalid build.
                    print('Could not update preview; keeping the last valid build. Will retry.', flush=True)
                    next_fetch = time.monotonic() + interval
                    # Retry validation even when the remote commit has not changed.
                    stamp = None

        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        threading.Thread(target=watch, daemon=True).start()
        print(f'Preview: http://localhost:{port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            stop.set()
            server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--github', action='store_true', help='Sync merged main every 60 seconds in an isolated mirror')
    args = parser.parse_args()
    serve(args.port, args.github)
