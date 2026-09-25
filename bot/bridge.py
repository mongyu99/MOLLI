"""브라우저에서 내린 판단을 실제 키 입력으로 옮겨주는 로컬 브릿지.

브라우저는 화면을 보고 무엇을 할지 정할 수는 있지만, 샌드박스 때문에 다른 프로그램에
키를 보낼 수 없다. 그 마지막 한 칸만 이 스크립트가 담당한다.

  python bot/bridge.py            # 안전모드 - 실제 입력 없이 로그만 찍는다
  python bot/bridge.py --live     # 실제로 키를 누른다

게임 페이지도 같이 띄워주므로 이것만 실행하면 된다: http://localhost:8743
"""

import argparse
import asyncio
import base64
import functools
import hashlib
import http.cookies
import http.server
import ipaddress
import json
import secrets
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

print = functools.partial(print, flush=True)  # 로그를 파일로 넘겨도 바로 보이도록

GAME_DIR = Path(__file__).resolve().parent.parent / "game"

# 허용할 키만 화이트리스트로 둔다. 브릿지가 임의의 문자를 칠 수 있으면 곤란하다.
# ESC는 뺐다. 대부분의 게임에서 일시정지/종료라, 봇이 실수로 누르면 게임이 꺼진다.
ALLOWED_KEYS = {"w", "a", "s", "d", "up", "down", "left", "right", "enter", "space"}

# 브라우저가 멈추거나 탭이 죽어도 키가 눌린 채 남지 않도록 하는 감시 시간
WATCHDOG_SEC = 0.5

# 이 문자열이 활성 창 제목에 들어 있을 때만 키를 보낸다. 비어 있으면 제한하지 않는다.
#   python bot/bridge.py --window "Vampire Survivors"
# 알트탭으로 다른 창에 가 있는데 거기에 대고 WASD를 치는 일을 막는다.
WINDOW = ""

_user32 = None
if sys.platform == "win32":
    import ctypes

    _user32 = ctypes.windll.user32


def foreground_title() -> str:
    """지금 맨 앞에 있는 창의 제목. 윈도우가 아니면 빈 문자열."""
    if not _user32:
        return ""
    hwnd = _user32.GetForegroundWindow()
    if not hwnd:
        return ""
    n = _user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    _user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def window_ok() -> bool:
    if not WINDOW:
        return True  # 지정하지 않았으면 예전처럼 동작한다
    if not _user32:
        return True  # 창 제목을 알 수 없는 환경에서는 막지 않는다
    return WINDOW.lower() in foreground_title().lower()



class KeyPresser:
    def __init__(self, live: bool):
        self.live = live
        self.held = set()
        self.lock = threading.Lock()
        self._pdi = None
        if live:
            import pydirectinput

            pydirectinput.PAUSE = 0
            pydirectinput.FAILSAFE = False
            self._pdi = pydirectinput


    def _down(self, key):
        if self._pdi:
            self._pdi.keyDown(key)

    def _up(self, key):
        if self._pdi:
            self._pdi.keyUp(key)

    def set_held(self, keys):
        keys = {k for k in keys if k in ALLOWED_KEYS}
        with self.lock:
            for k in keys - self.held:
                self._down(k)
            for k in self.held - keys:
                self._up(k)
            changed = keys != self.held
            self.held = keys
        return changed

    def tap(self, key):
        if key not in ALLOWED_KEYS:
            return False
        with self.lock:
            self._down(key)
            time.sleep(0.03)
            self._up(key)
        return True

    def release_all(self):
        self.set_held(set())


# Ollama가 어디서 도는지. 같은 PC의 도커든, 나중에 서브컴이든 주소만 바꾸면 된다.
#   python bot/bridge.py --ollama http://192.168.0.50:11434
OLLAMA = "http://localhost:11434"


def ollama_models():
    import urllib.request

    with urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=5) as r:
        data = json.load(r)
    return [m["name"] for m in data.get("models", [])]


def ollama_ask(model: str, prompt: str, image_b64: str | None, timeout: int):
    """Ollama에 한 번 물어본다. 레벨업 화면은 게임이 멈춰 있어서 몇 초 걸려도 괜찮다."""
    import urllib.request

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        # thinking 모델(qwen3-vl 등)은 생각한 내용이 response가 아니라 thinking으로 빠진다.
        # 그래서 num_predict가 작으면 생각만 하다 한도에 걸려 response가 빈 채로 끝난다.
        # think:false를 무시하는 모델도 있어서, 한도도 넉넉히 준다.
        "think": False,
        # 모델이 VRAM에서 내려가면 다음 레벨업에서 다시 올리느라 40초 넘게 걸린다.
        # 올라가 있으면 4초. 계속 물고 있게 둔다.
        "keep_alive": "30m",
        "options": {"temperature": 0.2, "num_predict": 900},
    }
    if image_b64:
        payload["images"] = [image_b64]
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.load(r)
    text = d.get("response") or ""
    if not text.strip():
        # 생각만 하다 끝난 경우, 그 안에 답이 들어있을 수 있어 그대로 넘긴다
        text = d.get("thinking") or ""
    return text


class Ocr:
    """윈도우에 들어 있는 글자 인식. 설치할 것이 없다.

    PowerShell 로 ocr.ps1 을 한 번 띄워두고, 이미지를 base64 한 줄로 보내면 JSON 한 줄로
    답한다. 띄우는 데 1~2초 걸리지만 그다음부터는 한 장에 0.2초 안쪽이다.
    LLM 은 글자를 지어낼 때가 있다. 이건 못 읽으면 빈칸이지, 없는 글자를 만들지 않는다.
    """

    SCRIPT = Path(__file__).resolve().parent / "ocr.ps1"

    def __init__(self):
        self.proc = None
        self.lang = ""
        self.lock = threading.Lock()

    def _start(self):
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.proc = subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
            creationflags=flags,
        )
        ready = self._line()
        self.lang = ready.get("lang", "")

    def _line(self):
        line = self.proc.stdout.readline()
        if not line:
            self.proc = None
            raise RuntimeError("OCR 프로세스가 끝났습니다")
        return json.loads(line.lstrip("﻿"))

    def start(self):
        if sys.platform != "win32":
            raise RuntimeError("윈도우에서만 됩니다")
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                self._start()
        return self.lang

    def read(self, image_b64: str):
        self.start()
        base64.b64decode(image_b64, validate=True)  # 망가진 요청은 여기서 거른다
        with self.lock:
            self.proc.stdin.write("b64:" + image_b64 + "\n")
            self.proc.stdin.flush()
            return self._line()

    def kill(self):
        # 응답이 안 오면 죽이고 다음 요청 때 새로 띄운다. 읽던 스레드는 빈 줄을 받고 끝난다.
        if self.proc:
            self.proc.kill()
            self.proc = None


REMOTE_DEVICES = Path(__file__).resolve().parent / "remote_devices.json"
REMOTE_PAGE = Path(__file__).resolve().parent / "remote.html"


class RemoteHub:
    """폰에서 몰리를 보고 지시하는 창구. 폰이 키를 직접 누르지는 않는다 — 지시를 받아두면
    PC 탭이 화면을 보고 처리하고, 키는 거기서도 허용된 것만 나간다. 정지만은 여기서 바로 먹는다.

    폰이 게임 페이지를 직접 열어도 소용없다. 화면 공유와 몰리의 상태는 PC 브라우저 탭
    안에만 있기 때문이다. 그래서 PC 탭이 2초마다 상태와 화면을 브릿지로 보내고
    (WebSocket, 이 PC 안에서만), 폰은 브릿지가 여는 이 HTTP 창구에서 가져다 본다.

    아무나 보면 안 된다. PC 화면에 뜬 6자리 코드를 넣은 기기만 등록되고, 등록된 기기는
    쿠키로 알아본다. 코드는 2분만 유효하고 다섯 번 틀리면 무효가 된다. 파일에는 쿠키 값이
    아니라 그 해시만 남긴다.
    """

    COOKIE = "molli_remote"
    CODE_TTL = 120
    CODE_TRIES = 5
    CMD_TTL = 60        # PC 탭이 이만큼 안에 못 가져간 지시는 버린다 (한참 뒤에 "시작" 되면 곤란)
    CMD_TEXT_MAX = 200

    def __init__(self):
        self.lock = threading.Lock()
        self.state = None
        self.state_at = 0.0
        self.images = {}
        self.code = None
        self.code_until = 0.0
        self.code_tries = 0
        self.last_poll = 0.0
        # 폰에서 온 지시. PC 탭이 2초마다 상태를 보낼 때 받아간다.
        self.commands = []
        # 폰에서 정지를 누르면 켜진다. 켜져 있으면 브릿지가 키를 아예 안 보낸다 —
        # PC 탭이 멈춰서 지시를 못 받아도 정지는 먹게 하려는 것이다.
        self.hold = False
        self.on_stop = None
        try:
            self.devices = json.loads(REMOTE_DEVICES.read_text("utf-8"))
        except Exception:
            self.devices = []

    def _save(self):
        REMOTE_DEVICES.write_text(json.dumps(self.devices, ensure_ascii=False, indent=1), "utf-8")

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def new_code(self) -> str:
        with self.lock:
            self.code = f"{secrets.randbelow(10**6):06d}"
            self.code_until = time.time() + self.CODE_TTL
            self.code_tries = 0
            return self.code

    def pair(self, code: str, name: str):
        with self.lock:
            if not self.code or time.time() > self.code_until:
                return None, "코드가 없거나 시간이 지났습니다. PC 에서 새로 만드세요."
            if not secrets.compare_digest(str(code).strip(), self.code):
                self.code_tries += 1
                if self.code_tries >= self.CODE_TRIES:
                    self.code = None
                    return None, "여러 번 틀려서 코드가 무효가 됐습니다. PC 에서 새로 만드세요."
                return None, "코드가 맞지 않습니다."
            self.code = None  # 한 번 쓰면 끝
            token = secrets.token_urlsafe(32)
            self.devices.append({
                "hash": self._hash(token),
                "name": name[:80],
                "since": time.strftime("%Y-%m-%d %H:%M"),
            })
            self._save()
            return token, None

    def check(self, token) -> bool:
        if not token:
            return False
        h = self._hash(token)
        with self.lock:
            ok = any(secrets.compare_digest(d["hash"], h) for d in self.devices)
            if ok:
                self.last_poll = time.time()
            return ok

    def revoke_all(self):
        with self.lock:
            self.devices = []
            self.last_poll = 0.0  # 방금까지 보던 폰도 이제 못 본다
            self._save()

    def update(self, state, images):
        with self.lock:
            self.state = state
            self.state_at = time.time()
            for k, v in images.items():
                if v:
                    self.images[k] = base64.b64decode(v)

    def watching(self) -> bool:
        return time.time() - self.last_poll < 10

    def page_alive(self) -> bool:
        return time.time() - self.state_at < 8

    def command(self, kind: str, text: str):
        """폰에서 온 지시를 받아둔다. 정지는 여기서 바로 먹인다."""
        with self.lock:
            if kind == "stop":
                self.hold = True
            elif kind == "start":
                self.hold = False
            self.commands.append({"kind": kind, "text": text, "at": time.time()})
        if kind == "stop" and self.on_stop:
            self.on_stop()  # 잡고 있던 키부터 뗀다

    def take_commands(self):
        with self.lock:
            now = time.time()
            fresh = [c for c in self.commands if now - c["at"] < self.CMD_TTL]
            self.commands = []
        return [{"kind": c["kind"], "text": c["text"]} for c in fresh]

    def info(self, port: int):
        with self.lock:
            return {
                "on": True,
                "port": port,
                "addrs": lan_addrs(),
                "kinds": {a: addr_kind(a) for a in lan_addrs()},
                "devices": [{"name": d["name"], "since": d["since"]} for d in self.devices],
                "watching": self.watching(),
                # 코드는 한 번 쓰면 없어진다. 페이지가 쓴 코드를 계속 띄우지 않게 알려준다.
                "code_active": bool(self.code) and time.time() < self.code_until,
            }


_MESH = ipaddress.ip_network("100.64.0.0/10")  # Tailscale·NordVPN 메시넷 같은 사설망이 쓰는 대역


def addr_kind(a: str) -> str:
    """폰에서 이 주소를 언제 쓰는지."""
    ip = ipaddress.ip_address(a)
    if ip in _MESH:
        return "밖에서 (Tailscale 등 사설망)"
    if a.startswith("192.168."):
        return "집 와이파이"
    return ""  # 도커·WSL 이 만든 가상 주소(172.x 등) — 폰은 못 쓴다


def lan_addrs():
    """이 PC 의 IPv4 주소들 (폰에서 칠 주소). 쓸 수 있는 것부터."""
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except Exception:
        addrs = set()
    addrs = [a for a in addrs if not a.startswith(("127.", "169.254."))]
    order = {"밖에서 (Tailscale 등 사설망)": 0, "집 와이파이": 1, "": 2}
    return sorted(addrs, key=lambda a: (order[addr_kind(a)], a))


def remote_handler(hub: RemoteHub):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # 2초마다 오는 요청으로 콘솔을 덮지 않는다

        def _send(self, code, body: bytes, ctype, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj, extra=None):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8", extra)

        def _paired(self):
            jar = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
            return hub.check(jar[hub.COOKIE].value if hub.COOKIE in jar else None)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                return self._send(200, REMOTE_PAGE.read_bytes(), "text/html; charset=utf-8")
            if not self._paired():
                return self._json(401, {"error": "등록되지 않은 기기"})
            if path == "/state":
                with hub.lock:
                    body = {
                        "state": hub.state,
                        "age": time.time() - hub.state_at if hub.state_at else None,
                        "hold": hub.hold,
                    }
                return self._json(200, body)
            if path in ("/view.jpg", "/sight.jpg"):
                img = hub.images.get(path[1:-4])
                if not img:
                    return self._send(404, b"", "text/plain")
                return self._send(200, img, "image/jpeg")
            self._send(404, b"", "text/plain")

        def do_POST(self):
            if self.path not in ("/pair", "/command"):
                return self._send(404, b"", "text/plain")
            n = int(self.headers.get("Content-Length") or 0)
            if n > 2000:
                return self._send(413, b"", "text/plain")
            try:
                data = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                data = {}
            who = self.client_address[0]

            # 폰에서 온 지시. 등록된 기기만. 키를 바로 누르지는 않는다 — PC 탭이 받아서
            # 화면을 보고 처리하고, 키는 거기서도 허용된 것만 나간다.
            if self.path == "/command":
                if not self._paired():
                    return self._json(401, {"error": "등록되지 않은 기기"})
                kind = str(data.get("kind", ""))
                text = str(data.get("text", "")).strip()[: hub.CMD_TEXT_MAX]
                if kind not in ("stop", "start", "say") or (kind == "say" and not text):
                    return self._json(400, {"error": "알 수 없는 지시"})
                hub.command(kind, text)
                print(f"[폰] 지시: {kind}{' — ' + text if text else ''}")
                return self._json(200, {"ok": True, "page": hub.page_alive(), "hold": hub.hold})

            token, err = hub.pair(data.get("code", ""), self.headers.get("User-Agent", "") or who)
            if not token:
                print(f"[폰] 연결 실패 ({who}): {err}")
                return self._json(403, {"error": err})
            print(f"[폰] 새 기기 연결됨 ({who})")
            cookie = f"{hub.COOKIE}={token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict"
            self._json(200, {"ok": True}, {"Set-Cookie": cookie})

    return Handler


def serve_remote(hub: RemoteHub, host: str, port: int):
    class Server(http.server.ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    # 폰이 붙어야 하니 기본은 이 PC 밖에서도 받는다(0.0.0.0). 대신 등록한 기기만 본다.
    with Server((host, port), remote_handler(hub)) as httpd:
        httpd.serve_forever()


def serve_http(port: int):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(GAME_DIR))

    class Quiet(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with Quiet(("127.0.0.1", port), handler) as httpd:
        httpd.serve_forever()


async def main_async(args):
    import websockets

    presser = KeyPresser(args.live)
    state = {"last_msg": 0.0, "last_block_log": 0.0}
    ocr = Ocr()

    # 첫 요청 때 띄우면 그 한 번이 1~2초 늦는다. 미리 띄워둔다.
    def warm_ocr():
        try:
            print(f"OCR         : 윈도우 내장 글자 인식 준비됨 ({ocr.start()})")
        except Exception as e:
            print(f"OCR         : 못 씀 — {e} (글자 판별 없이 LLM 만 씁니다)")

    threading.Thread(target=warm_ocr, daemon=True).start()

    remote = RemoteHub() if args.remote else None
    if remote:
        remote.on_stop = presser.release_all
        threading.Thread(
            target=serve_remote, args=(remote, args.remote_host, args.remote_port), daemon=True
        ).start()

    async def watchdog():
        while True:
            await asyncio.sleep(0.1)
            if presser.held and time.time() - state["last_msg"] > WATCHDOG_SEC:
                print("[watchdog] 명령이 끊겨 모든 키를 뗍니다")
                presser.release_all()

    async def handler(ws):
        origin = None
        try:
            origin = ws.request.headers.get("Origin")
        except Exception:
            pass
        # 로컬에 열린 WebSocket은 아무 웹페이지나 접속할 수 있다. 우리 페이지만 받는다.
        allowed_origins = {f"http://localhost:{args.port}", f"http://127.0.0.1:{args.port}"}
        if origin is not None and origin not in allowed_origins:
            print(f"[거부] 허용되지 않은 origin: {origin}")
            await ws.close(code=4003, reason="origin not allowed")
            return

        print(f"[연결] 브라우저 접속됨 (모드: {'실제 입력' if args.live else '안전모드'})")
        state["last_msg"] = time.time()
        # 페이지가 묻기 전에 알려준다: 입력 모드, 폰으로 보기가 켜졌는지
        await ws.send(json.dumps({"live": args.live, "remote": remote is not None}))
        try:
            async for raw in ws:
                state["last_msg"] = time.time()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                kind = msg.get("type")

                # 창 설정은 키를 보내는 것과 무관하므로 먼저 처리한다
                if kind == "set_window":
                    global WINDOW
                    WINDOW = str(msg.get("window", "") or "").strip()
                    print(f"[창] 이제 '{WINDOW}' 창이 활성일 때만 키를 보냅니다" if WINDOW
                          else "[창] 제한을 풀었습니다 — 활성 창이 무엇이든 키를 보냅니다")
                    await ws.send(json.dumps({
                        "id": msg.get("id"), "window": WINDOW, "foreground": foreground_title(),
                    }))
                    continue
                if kind == "win_info":
                    await ws.send(json.dumps({
                        "id": msg.get("id"), "window": WINDOW,
                        "foreground": foreground_title(), "ok": window_ok(),
                    }))
                    continue

                # 폰으로 보기. 키와 무관하다.
                if kind in ("remote_push", "remote_info", "remote_code", "remote_revoke", "remote_unhold"):
                    rid = msg.get("id")
                    if remote is None:
                        await ws.send(json.dumps({"id": rid, "on": False}))
                        continue
                    if kind == "remote_push":
                        remote.update(msg.get("state"), {"view": msg.get("view"), "sight": msg.get("sight")})
                        # 폰에서 온 지시는 이때 넘겨준다
                        await ws.send(json.dumps({
                            "id": rid, "watching": remote.watching(),
                            "hold": remote.hold, "commands": remote.take_commands(),
                        }))
                    elif kind == "remote_unhold":
                        # PC 앞에서 '조작 시작' 을 눌렀다 — 폰에서 걸어둔 정지를 푼다
                        if remote.hold:
                            print("[폰] PC 에서 조작을 시작해서 폰 정지를 풉니다")
                        remote.hold = False
                        await ws.send(json.dumps({"id": rid, "hold": False}))
                    elif kind == "remote_code":
                        code = remote.new_code()
                        print(f"[폰] 연결 코드 {code} ({RemoteHub.CODE_TTL // 60}분 동안 유효)")
                        await ws.send(json.dumps({"id": rid, "code": code, "ttl": RemoteHub.CODE_TTL,
                                                  **remote.info(args.remote_port)}))
                    elif kind == "remote_revoke":
                        remote.revoke_all()
                        print("[폰] 연결한 기기를 모두 끊었습니다")
                        await ws.send(json.dumps({"id": rid, **remote.info(args.remote_port)}))
                    else:
                        await ws.send(json.dumps({"id": rid, **remote.info(args.remote_port)}))
                    continue

                # 지정한 창이 아니면 키를 보내지 않는다. 잡고 있던 키부터 놓는다 —
                # 안 놓으면 다른 창에 키가 눌린 채로 남는다.
                if kind in ("move", "tap") and not window_ok():
                    if presser.held:
                        presser.release_all()
                    now = time.time()
                    if now - state["last_block_log"] > 3:
                        state["last_block_log"] = now
                        print(f"[차단] 활성 창이 '{foreground_title()}' 이라 키를 보내지 않습니다")
                    await ws.send(json.dumps({"ok": True, "live": args.live, "blocked": True}))
                    continue

                # 폰에서 정지했으면 키를 보내지 않는다 (PC 탭이 아직 모르고 계속 보내도)
                if kind in ("move", "tap") and remote is not None and remote.hold:
                    if presser.held:
                        presser.release_all()
                    await ws.send(json.dumps({"ok": True, "live": args.live, "held": True}))
                    continue

                if kind == "move":
                    keys = msg.get("keys") or []
                    if presser.set_held(set(keys)) and not args.live:
                        print(f"[안전모드] 이동키 {sorted(keys) or '없음'}")
                elif kind == "tap":
                    key = msg.get("key", "")
                    if presser.tap(key) and not args.live:
                        print(f"[안전모드] 탭 {key}")
                elif kind == "stop":
                    presser.release_all()
                    print("[정지] 모든 키 해제")
                elif kind == "llm_models":
                    try:
                        models = await asyncio.to_thread(ollama_models)
                        await ws.send(json.dumps({"id": msg.get("id"), "models": models}))
                    except Exception as e:
                        await ws.send(json.dumps({"id": msg.get("id"), "error": f"ollama 연결 실패: {e}"}))
                    continue
                elif kind == "llm_ask":
                    # 블로킹 HTTP 호출을 그냥 await하면 이벤트 루프가 멈춰서
                    # 그동안 워치독도 안 돈다. 반드시 스레드로 빼야 한다.
                    try:
                        t0 = time.time()
                        text = await asyncio.to_thread(
                            ollama_ask,
                            msg.get("model", ""),
                            msg.get("prompt", ""),
                            msg.get("image"),
                            int(msg.get("timeout", 30)),
                        )
                        took = time.time() - t0
                        print(f"[LLM] {took:.1f}초 · {text.strip()[:80]}")
                        await ws.send(json.dumps({"id": msg.get("id"), "text": text, "took": took}))
                    except Exception as e:
                        print(f"[LLM 실패] {e}")
                        await ws.send(json.dumps({"id": msg.get("id"), "error": str(e)}))
                    continue
                elif kind == "ocr":
                    try:
                        res = await asyncio.wait_for(
                            asyncio.to_thread(ocr.read, msg.get("image") or ""), timeout=15
                        )
                        if res.get("error"):
                            print(f"[OCR 실패] {res['error']}")
                        else:
                            words = " / ".join(l["text"] for l in res.get("lines", []))
                            print(f"[OCR] {res.get('ms', 0)}ms · {words[:80] or '(글자 없음)'}")
                        await ws.send(json.dumps({"id": msg.get("id"), **res}))
                    except asyncio.TimeoutError:
                        ocr.kill()
                        print("[OCR 실패] 15초 안에 답이 없어 다시 띄웁니다")
                        await ws.send(json.dumps({"id": msg.get("id"), "error": "OCR 응답 없음"}))
                    except Exception as e:
                        print(f"[OCR 실패] {e}")
                        await ws.send(json.dumps({"id": msg.get("id"), "error": str(e)}))
                    continue
                await ws.send(json.dumps({"ok": True, "live": args.live}))
        finally:
            presser.release_all()
            print("[연결 종료] 모든 키 해제")

    # 도커의 nginx가 페이지를 서빙하는 경우에는 여기서 또 열 필요가 없다.
    # 포트 번호는 그래도 계속 쓴다 - WebSocket Origin 검사 기준이라서.
    if args.no_web:
        print(f"게임 페이지 : http://localhost:{args.port} (도커 web 컨테이너가 서빙)")
    else:
        threading.Thread(target=serve_http, args=(args.port,), daemon=True).start()
        print(f"게임 페이지 : http://localhost:{args.port}")

    print(f"브릿지      : ws://localhost:{args.ws_port}")
    print(f"Ollama      : {OLLAMA}")
    print(f"대상 창     : {WINDOW or '제한 없음 (활성 창이 무엇이든 키를 보냅니다)'}")
    if remote:
        shown = [a for a in lan_addrs() if addr_kind(a)]
        if not shown:
            print(f"폰으로 보기 : 포트 {args.remote_port} (폰이 쓸 만한 주소를 못 찾았습니다)")
        for i, a in enumerate(shown):
            head = "폰으로 보기 :" if i == 0 else "             "
            print(f"{head} http://{a}:{args.remote_port}  ← {addr_kind(a)}")
        if not any(ipaddress.ip_address(a) in _MESH for a in shown):
            print("              밖(모바일 데이터)에서 보려면 Tailscale 을 PC·폰에 켜세요 — bot/README.md '밖에서 보려면'")
        print(f"              보기 + 정지·시작·말 지시. 처음 한 번 PC 페이지에서 만든 연결 코드를 넣어야 합니다 "
              f"(등록된 기기 {len(remote.devices)}대)")
    if not args.live:
        print("\n지금은 안전모드입니다. 실제로 키를 누르게 하려면 --live 를 붙여 다시 실행하세요.")
    else:
        print("\n실제 입력 모드입니다. 게임 창을 활성화해 두세요. 중단하려면 이 창에서 Ctrl+C.")

    # 글자 인식용 이미지는 작은 글씨를 살리려고 2배로 키워 보내서 1MB(기본 한도)를 넘는다
    async with websockets.serve(handler, "127.0.0.1", args.ws_port, max_size=16 * 2**20):
        await watchdog()


def main():
    global OLLAMA, WINDOW
    p = argparse.ArgumentParser()
    p.add_argument("--live", action="store_true", help="실제로 키를 누른다 (기본은 로그만)")
    p.add_argument("--port", type=int, default=8743, help="게임 페이지 HTTP 포트")
    p.add_argument(
        "--no-web",
        action="store_true",
        help="페이지를 직접 서빙하지 않는다 (도커 nginx가 대신할 때). 포트 번호는 Origin 검사에 계속 쓴다",
    )
    p.add_argument("--ws-port", type=int, default=8744, help="브릿지 WebSocket 포트")
    p.add_argument(
        "--window",
        default="",
        help='이 문자열이 활성 창 제목에 들어 있을 때만 키를 보낸다 (예: --window "Vampire Survivors"). '
        "비우면 제한하지 않는다",
    )
    p.add_argument(
        "--remote",
        action="store_true",
        help="폰으로 보기 창구를 연다 (보기 + 정지·시작·말 지시, 연결 코드로 등록한 기기만). 기본은 닫혀 있다",
    )
    p.add_argument("--remote-port", type=int, default=8745, help="폰으로 보기 포트")
    p.add_argument(
        "--remote-host",
        default="0.0.0.0",
        help="폰으로 보기를 받을 주소. 기본은 모든 네트워크. 특정 네트워크(예: VPN 주소)에서만 받으려면 그 주소",
    )
    p.add_argument(
        "--ollama",
        default=OLLAMA,
        help="Ollama 주소. 도커든 다른 PC든 여기만 바꾸면 된다 (기본 http://localhost:11434)",
    )
    args = p.parse_args()
    OLLAMA = args.ollama.rstrip("/")
    WINDOW = args.window.strip()

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n종료합니다")


if __name__ == "__main__":
    main()
