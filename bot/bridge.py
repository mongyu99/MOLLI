"""브라우저에서 내린 판단을 실제 키 입력으로 옮겨주는 로컬 브릿지.

브라우저는 화면을 보고 무엇을 할지 정할 수는 있지만, 샌드박스 때문에 다른 프로그램에
키를 보낼 수 없다. 그 마지막 한 칸만 이 스크립트가 담당한다.

  python bot/bridge.py            # 안전모드 - 실제 입력 없이 로그만 찍는다
  python bot/bridge.py --live     # 실제로 키를 누른다

게임 페이지도 같이 띄워주므로 이것만 실행하면 된다: http://localhost:8743
"""

import argparse
import asyncio
import functools
import http.server
import json
import socketserver
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
    if not args.live:
        print("\n지금은 안전모드입니다. 실제로 키를 누르게 하려면 --live 를 붙여 다시 실행하세요.")
    else:
        print("\n실제 입력 모드입니다. 게임 창을 활성화해 두세요. 중단하려면 이 창에서 Ctrl+C.")

    async with websockets.serve(handler, "127.0.0.1", args.ws_port):
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
