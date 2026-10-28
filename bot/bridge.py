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
import os
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
# 농부 게임에서 몰리가 화면을 읽으며 쌓는 문법 사전. 페이지가 통째로 보내면 그대로 저장한다.
FARM_DICT = GAME_DIR / "knowledge" / "farm_dict.json"
FARM_DICT_MAX = 4 * 2**20

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
    # 화면 배율(125%, 150%…)을 쓰면 DPI 를 모르는 프로그램은 좌표를 배율만큼 줄여서 받는다.
    # 화면 공유 캡처는 실제 픽셀이라, 여기서도 실제 픽셀로 맞춰야 클릭 자리가 맞는다.
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # 모니터별 DPI 인식
    except Exception:
        try:
            _user32.SetProcessDPIAware()
        except Exception:
            pass


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


def find_window(part: str):
    """제목에 part 가 들어 있는 보이는 창 하나. 없으면 None."""
    if not _user32 or not part:
        return None
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def each(hwnd, _):
        if _user32.IsWindowVisible(hwnd):
            n = _user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            _user32.GetWindowTextW(hwnd, buf, n + 1)
            if part.lower() in buf.value.lower():
                found.append(hwnd)
                return False
        return True

    _user32.EnumWindows(each, 0)
    return found[0] if found else None


def bring_to_front(hwnd) -> bool:
    """대상 창을 맨 앞으로. 실제로 맨 앞이 됐는지 돌려준다 — 못 꺼냈는데 누르면 브라우저를 누르게 된다.
    윈도우는 백그라운드 프로세스가 창을 앞으로 꺼내는 걸 막는다.
    Alt 를 한 번 눌렀다 떼면 '사용자 입력이 있었다'로 쳐서 허용되고, 그래도 안 되면 입력 스레드를 붙여서 한다."""
    if _user32.GetForegroundWindow() == hwnd:
        return True
    if _user32.IsIconic(hwnd):
        _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    _user32.keybd_event(0x12, 0, 0, 0)
    _user32.keybd_event(0x12, 0, 2, 0)
    _user32.SetForegroundWindow(hwnd)
    time.sleep(0.12)
    if _user32.GetForegroundWindow() == hwnd:
        return True
    fg = _user32.GetForegroundWindow()
    me = ctypes.windll.kernel32.GetCurrentThreadId()
    other = _user32.GetWindowThreadProcessId(fg, None)
    target = _user32.GetWindowThreadProcessId(hwnd, None)
    for t in {other, target} - {me}:
        _user32.AttachThreadInput(me, t, True)
    _user32.BringWindowToTop(hwnd)
    _user32.SetForegroundWindow(hwnd)
    for t in {other, target} - {me}:
        _user32.AttachThreadInput(me, t, False)
    time.sleep(0.12)
    return _user32.GetForegroundWindow() == hwnd


def window_client_rect(hwnd=None):
    """창(기본은 맨 앞 창)의 내용 영역(제목줄·테두리 뺀 부분)을 화면 좌표 (x, y, w, h) 로. 모르면 None."""
    if not _user32:
        return None
    hwnd = hwnd or _user32.GetForegroundWindow()
    if not hwnd:
        return None
    from ctypes import wintypes

    rc = wintypes.RECT()
    if not _user32.GetClientRect(hwnd, ctypes.byref(rc)):
        return None
    pt = wintypes.POINT(0, 0)
    _user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y, rc.right, rc.bottom


def window_frame_rect(hwnd):
    """창 전체(제목줄 포함)를 화면 좌표 (x, y, w, h) 로. 창 하나만 공유하면 캡처되는 범위가 이것이다.
    GetWindowRect 는 눈에 안 보이는 크기 조절 테두리까지 넣으므로 DWM 이 그리는 실제 경계를 쓴다."""
    from ctypes import wintypes

    rc = wintypes.RECT()
    try:
        ok = ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rc), ctypes.sizeof(rc)) == 0
    except Exception:
        ok = False
    if not ok and not _user32.GetWindowRect(hwnd, ctypes.byref(rc)):
        return None
    return rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top


def in_client(hwnd, x, y, margin=2) -> bool:
    """화면 좌표 (x, y) 가 게임 내용 영역 안인가. 제목줄의 ─ □ ✕ 와 창 테두리는 내용 영역 밖이다.
    10-28 에 봇이 게임을 꺼버린 뒤로, 내용 영역 밖은 어떤 경우에도 누르지 않는다."""
    r = window_client_rect(hwnd)
    if not r:
        return False
    return r[0] + margin <= x < r[0] + r[2] - margin and r[1] + margin <= y < r[1] + r[3] - margin


def capture_rect(hwnd, cw=0, ch=0):
    """공유 화면의 비율 좌표를 어느 영역에 대어야 하나. 캡처 크기(cw×ch)와 가장 가까운 쪽을 고른다.
    전체 화면 게임이면 둘이 같고, 창 모드면 보통 제목줄까지 들어간 '창 전체'가 맞는다."""
    client = window_client_rect(hwnd)
    frame = window_frame_rect(hwnd)
    options = [("내용 영역", client), ("창 전체", frame)]
    options = [(n, r) for n, r in options if r and r[2] > 0 and r[3] > 0]
    if not options:
        return None, None
    if cw and ch:
        return min(options, key=lambda o: abs(o[1][2] - cw) + abs(o[1][3] - ch))
    return options[0]


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


class MouseClicker:
    """마우스 클릭. pydirectinput 의 moveTo 는 주 모니터 기준이라 모니터가 여러 대면 좌표가 튄다.
    SetCursorPos 는 가상 화면 좌표를 그대로 받으므로 직접 부른다."""

    DOWN_UP = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010)}

    def __init__(self, live: bool):
        self.live = live and _user32 is not None

    def click(self, hwnd, fx: float, fy: float, button: str = "left", cw: int = 0, ch: int = 0) -> dict:
        """fx, fy 는 공유 화면 안의 비율(0~1). cw, ch 는 공유 화면의 픽셀 크기 (어느 영역 기준인지 고르는 데 쓴다).
        페이지에서 클릭하면 브라우저가 맨 앞이 되므로, 누르기 전에 대상 창을 앞으로 꺼낸다."""
        if button not in self.DOWN_UP or not (0 <= fx <= 1 and 0 <= fy <= 1):
            return {"error": "좌표가 0~1 밖입니다"}
        if self.live and not bring_to_front(hwnd):
            return {"error": "게임 창을 맨 앞으로 꺼내지 못해 누르지 않았습니다"}
        basis, rect = capture_rect(hwnd, cw, ch)
        if not rect:
            return {"error": "게임 창 크기를 알 수 없습니다"}
        x = rect[0] + round(fx * (rect[2] - 1))
        y = rect[1] + round(fy * (rect[3] - 1))
        if not in_client(hwnd, x, y):
            return {"error": "게임 내용 영역 밖(제목줄·테두리)이라 누르지 않았습니다", "outside": True, "at_refused": [x, y]}
        if self.live:
            down, up = self.DOWN_UP[button]
            # 게임(Unity)은 프레임마다 입력을 읽는다. 순간이동 후 바로 누르면 버튼이 '마우스가 올라옴'을
            # 못 느끼거나, 짧게 눌렀다 뗀 걸 통째로 놓친다. 올려놓고, 살짝 흔들고, 넉넉히 누른다.
            _user32.SetCursorPos(x, y)
            time.sleep(0.06)
            _user32.SetCursorPos(x + 1, y)
            time.sleep(0.03)
            _user32.SetCursorPos(x, y)
            time.sleep(0.05)
            _user32.mouse_event(down, 0, 0, 0, 0)
            time.sleep(0.08)
            _user32.mouse_event(up, 0, 0, 0, 0)
        return {"at": [x, y], "basis": basis, "rect": list(rect)}

    def drag(self, hwnd, f1, f2, cw: int = 0, ch: int = 0) -> dict:
        """왼쪽 버튼을 누른 채 f1 → f2 로 끈다 (창 옮기기). 두 점 모두 게임 내용 영역 안이어야 한다."""
        if not all(0 <= v <= 1 for v in (*f1, *f2)):
            return {"error": "좌표가 0~1 밖입니다"}
        if self.live and not bring_to_front(hwnd):
            return {"error": "게임 창을 맨 앞으로 꺼내지 못해 끌지 않았습니다"}
        basis, rect = capture_rect(hwnd, cw, ch)
        if not rect:
            return {"error": "게임 창 크기를 알 수 없습니다"}
        pt = lambda f: (rect[0] + round(f[0] * (rect[2] - 1)), rect[1] + round(f[1] * (rect[3] - 1)))
        (x1, y1), (x2, y2) = pt(f1), pt(f2)
        if not (in_client(hwnd, x1, y1) and in_client(hwnd, x2, y2)):
            return {"error": "게임 내용 영역 밖(제목줄·테두리)이라 끌지 않았습니다", "outside": True}
        if self.live:
            _user32.SetCursorPos(x1, y1)
            time.sleep(0.08)
            _user32.SetCursorPos(x1 + 1, y1)
            time.sleep(0.03)
            _user32.SetCursorPos(x1, y1)
            time.sleep(0.05)
            _user32.mouse_event(0x0002, 0, 0, 0, 0)  # 왼쪽 누름
            time.sleep(0.1)
            # 한 번에 순간이동하면 게임이 끌기로 못 알아본다. 20번에 나눠 옮긴다.
            for i in range(1, 21):
                _user32.SetCursorPos(x1 + (x2 - x1) * i // 20, y1 + (y2 - y1) * i // 20)
                time.sleep(0.02)
            time.sleep(0.1)
            _user32.mouse_event(0x0004, 0, 0, 0, 0)  # 뗌
        return {"from": [x1, y1], "to": [x2, y2], "basis": basis}

    def scroll(self, hwnd, fx: float, fy: float, clicks: int, cw: int = 0, ch: int = 0) -> dict:
        """마우스 휠. 휠은 커서 밑에 있는 창·패널만 움직이므로 먼저 (fx, fy) 로 커서를 옮긴다.
        clicks 가 양수면 아래로, 음수면 위로. 한 칸 = 휠 한 눈금."""
        if not (0 <= fx <= 1 and 0 <= fy <= 1):
            return {"error": "좌표가 0~1 밖입니다"}
        clicks = max(-15, min(15, int(clicks)))
        if not clicks:
            return {"error": "스크롤 양이 0입니다"}
        if self.live and not bring_to_front(hwnd):
            return {"error": "게임 창을 맨 앞으로 꺼내지 못해 스크롤하지 않았습니다"}
        basis, rect = capture_rect(hwnd, cw, ch)
        if not rect:
            return {"error": "게임 창 크기를 알 수 없습니다"}
        x = rect[0] + round(fx * (rect[2] - 1))
        y = rect[1] + round(fy * (rect[3] - 1))
        if not in_client(hwnd, x, y):
            return {"error": "게임 내용 영역 밖(제목줄·테두리)이라 스크롤하지 않았습니다", "outside": True}
        if self.live:
            _user32.SetCursorPos(x, y)
            time.sleep(0.06)
            # 윈도우 휠 값은 위로가 양수다. 한 눈금씩 나눠 보내야 게임이 칸 수를 제대로 센다.
            step = -120 if clicks > 0 else 120
            for _ in range(abs(clicks)):
                _user32.mouse_event(0x0800, 0, 0, step, 0)  # MOUSEEVENTF_WHEEL
                time.sleep(0.04)
        return {"at": [x, y], "basis": basis, "clicks": clicks}


class Typer:
    """글자 입력. 코드 게임이라 편집기에 코드를 쳐야 한다.
    SendInput 의 유니코드 모드로 보내서 한글·기호도 자판 배치와 상관없이 그대로 들어간다.
    ESC 는 비상 정지 키라 여기서도 절대 보내지 않는다."""

    VK = {
        "enter": 0x0D, "tab": 0x09, "backspace": 0x08, "delete": 0x2E, "space": 0x20,
        "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27, "home": 0x24, "end": 0x23,
        "pageup": 0x21, "pagedown": 0x22, "f1": 0x70, "f5": 0x74,
    }
    # ctrl 조합은 편집에 필요한 것만
    CTRL = {"ctrl+a": 0x41, "ctrl+c": 0x43, "ctrl+v": 0x56, "ctrl+x": 0x58, "ctrl+z": 0x5A, "ctrl+s": 0x53}
    MAX_TEXT = 4000

    def __init__(self, live: bool):
        self.live = live and _user32 is not None
        if not self.live:
            return
        from ctypes import wintypes

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

        class MOUSEINPUT(ctypes.Structure):  # 공용체 크기를 맞추려고만 둔다
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

        class _U(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

        class INPUT(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("u", _U)]

        self._KI, self._INPUT = KEYBDINPUT, INPUT

    def _send(self, vk=0, scan=0, flags=0):
        inp = self._INPUT(type=1)  # INPUT_KEYBOARD
        inp.u.ki = self._KI(vk, scan, flags, 0, 0)
        _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))

    def _vk(self, vk):
        self._send(vk=vk)
        time.sleep(0.01)
        self._send(vk=vk, flags=0x0002)  # KEYUP

    def type_text(self, text: str):
        """줄바꿈은 Enter, 탭은 공백 4칸으로 보낸다."""
        text = text.replace("\r\n", "\n").replace("\t", "    ")[: self.MAX_TEXT]
        if not self.live:
            return len(text)
        for ch in text:
            if ch == "\n":
                self._vk(0x0D)
            elif ch == "\x1b":
                continue
            else:
                code = ord(ch)
                self._send(scan=code, flags=0x0004)           # KEYEVENTF_UNICODE
                self._send(scan=code, flags=0x0004 | 0x0002)
            time.sleep(0.008)
        return len(text)

    def _clip_get(self):
        k = ctypes.windll.kernel32
        u = _user32
        k.GlobalLock.restype = ctypes.c_void_p
        u.GetClipboardData.restype = ctypes.c_void_p
        if not u.OpenClipboard(None):
            return None
        try:
            h = u.GetClipboardData(13)  # CF_UNICODETEXT
            if not h:
                return None
            p = k.GlobalLock(ctypes.c_void_p(h))
            try:
                return ctypes.wstring_at(p)
            finally:
                k.GlobalUnlock(ctypes.c_void_p(h))
        finally:
            u.CloseClipboard()

    def _clip_set(self, text: str) -> bool:
        k = ctypes.windll.kernel32
        u = _user32
        k.GlobalAlloc.restype = ctypes.c_void_p
        k.GlobalLock.restype = ctypes.c_void_p
        data = ctypes.create_unicode_buffer(text)
        size = ctypes.sizeof(data)
        h = k.GlobalAlloc(0x0002, size)  # GMEM_MOVEABLE
        if not h:
            return False
        p = k.GlobalLock(ctypes.c_void_p(h))
        ctypes.memmove(p, data, size)
        k.GlobalUnlock(ctypes.c_void_p(h))
        for _ in range(10):  # 다른 프로그램이 클립보드를 잡고 있으면 잠깐 기다린다
            if u.OpenClipboard(None):
                break
            time.sleep(0.05)
        else:
            return False
        try:
            u.EmptyClipboard()
            u.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
            return bool(u.SetClipboardData(13, ctypes.c_void_p(h)))
        finally:
            u.CloseClipboard()

    def paste(self, text: str) -> int:
        """클립보드에 넣고 Ctrl+V. 한 글자씩 치면 게임 편집기의 자동 완성·자동 들여쓰기가 끼어들어
        코드가 망가진다 (10-28). 붙여넣기는 그대로 들어간다. 원래 클립보드 글자는 끝나고 되돌린다."""
        text = text.replace("\r\n", "\n").replace("\t", "    ")[: self.MAX_TEXT]
        if not self.live:
            return len(text)
        old = self._clip_get()
        if not self._clip_set(text):
            raise RuntimeError("클립보드에 넣지 못했습니다")
        time.sleep(0.05)
        self.press("ctrl+v")
        time.sleep(0.25)
        if old is not None:
            self._clip_set(old)
        return len(text)

    def press(self, key: str) -> bool:
        key = key.lower().strip()
        if key in self.CTRL:
            if self.live:
                self._send(vk=0x11)
                self._vk(self.CTRL[key])
                self._send(vk=0x11, flags=0x0002)
            return True
        if key in self.VK:
            if self.live:
                self._vk(self.VK[key])
            return True
        return False


def watch_esc(on_esc):
    """ESC 를 누르면 on_esc 를 부른다. 게임 창이 앞에 있어도 잡히도록 키 상태를 직접 읽는다.
    봇은 ESC 를 절대 누르지 않으므로(ALLOWED_KEYS) 이건 항상 사람이 누른 것이다."""
    if not _user32:
        return
    was = False
    while True:
        now = bool(_user32.GetAsyncKeyState(0x1B) & 0x8000)
        if now and not was:
            on_esc()
        was = now
        time.sleep(0.03)


# LLM 을 어디에 물을지. 페이지와 주고받는 메시지(llm_models/llm_ask)는 같고, 여기서만 갈린다.
#   ollama - 로컬 모델. 주소만 바꾸면 도커든 서브컴이든 된다
#              python bot/bridge.py --ollama http://192.168.0.50:11434
#   api    - OpenAI 호환 API (기본은 Meta Llama API). 키는 환경변수로 받는다
#              $env:LLM_API_KEY = "..."; python bot/bridge.py --llm api
#            다른 곳을 쓰려면 --api-base 만 바꾼다 (OpenAI, Together, Groq 등 /chat/completions 가 있는 곳)
# 나중에 로컬 LLM 으로 돌아갈 때는 --llm ollama (키가 없으면 기본이 ollama).
OLLAMA = "http://localhost:11434"
LLM = "ollama"
API_BASE = "https://api.llama.com/compat/v1"
API_KEY = ""
# /models 를 못 주는 곳도 있어서, 그때 페이지 목록에 띄울 기본 모델
API_DEFAULT_MODELS = ["Llama-4-Maverick-17B-128E-Instruct-FP8", "Llama-4-Scout-17B-16E-Instruct-FP8"]


def llm_models():
    return api_models() if LLM == "api" else ollama_models()


# 마지막 Ollama 호출의 시간 내역. 페이지가 '어디서 느린지' 보여줄 때 쓴다.
LAST_STATS: dict = {}


def llm_ask(model: str, prompt: str, image_b64: str | None, timeout: int,
            as_json: bool = False, max_tokens: int | None = None):
    if LLM == "api":
        return api_ask(model, prompt, image_b64, timeout, max_tokens)
    return ollama_ask(model, prompt, image_b64, timeout, as_json, max_tokens)


def _api_request(path: str, payload: dict | None, timeout: int):
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # 키가 틀렸는지, 모델 이름이 틀렸는지는 본문에만 적혀 온다
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None


def api_models():
    try:
        d = _api_request("/models", None, 10)
        names = [m.get("id") for m in d.get("data", []) if m.get("id")]
    except Exception as e:
        print(f"[LLM] 모델 목록을 못 받아 기본 목록을 씁니다: {e}")
        names = []
    return sorted(names) or API_DEFAULT_MODELS


def api_ask(model: str, prompt: str, image_b64: str | None, timeout: int, max_tokens: int | None = None):
    """OpenAI 호환 /chat/completions 로 한 번 물어본다. 이미지는 data URL 로 붙인다."""
    content: list[dict] = [{"type": "text", "text": prompt}]
    if image_b64:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}})
    d = _api_request(
        "/chat/completions",
        {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.2,
            "max_tokens": max_tokens or 900,
        },
        timeout,
    )
    return d["choices"][0]["message"].get("content") or ""


def ollama_models():
    import urllib.request

    with urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=5) as r:
        data = json.load(r)
    return [m["name"] for m in data.get("models", [])]


def ollama_ask(model: str, prompt: str, image_b64: str | None, timeout: int,
               as_json: bool = False, max_tokens: int | None = None):
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
        "options": {"temperature": 0.2, "num_predict": max_tokens or 900},
    }
    # 농부 페이지처럼 JSON 만 받는 곳은 Ollama 가 문법에 맞는 JSON 만 내게 묶는다 (앞뒤 잡담이 없어 짧아진다)
    if as_json:
        payload["format"] = "json"
    if image_b64:
        payload["images"] = [image_b64]
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.load(r)
    ns = 1e9
    LAST_STATS.clear()
    LAST_STATS.update({
        "load": round(d.get("load_duration", 0) / ns, 2),
        "read": round(d.get("prompt_eval_duration", 0) / ns, 2),
        "write": round(d.get("eval_duration", 0) / ns, 2),
        "in_tokens": d.get("prompt_eval_count", 0),
        "out_tokens": d.get("eval_count", 0),
    })
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

    def __init__(self, lang: str = "ko"):
        # 엔진 언어. 한글 게임(뱀서)은 ko, 영어로 돌리는 게임(농부)은 en-US 가 코드 글꼴까지 훨씬 잘 읽는다.
        self.want = lang
        self.proc = None
        self.lang = ""
        self.lock = threading.Lock()

    def _start(self):
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.proc = subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.SCRIPT), "-Lang", self.want],
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
    clicker = MouseClicker(args.live)
    typer = Typer(args.live)
    # halted: ESC 로 멈춘 상태. 페이지에서 '조작 시작'(resume)을 다시 누를 때까지 입력을 막는다.
    state = {"last_msg": 0.0, "last_block_log": 0.0, "halted": False}
    clients = set()
    loop = asyncio.get_running_loop()

    async def tell_all(obj):
        for c in list(clients):
            try:
                await c.send(json.dumps(obj))
            except Exception:
                pass

    def on_esc():
        presser.release_all()
        if not state["halted"]:
            state["halted"] = True
            print("[ESC] 조작을 멈췄습니다 — 페이지에서 '조작 시작'을 누르면 다시 움직입니다")
        asyncio.run_coroutine_threadsafe(tell_all({"halted": True}), loop)

    threading.Thread(target=watch_esc, args=(on_esc,), daemon=True).start()
    ocr = Ocr()
    # 페이지가 언어를 고를 수 있다 ({"type": "ocr", "lang": "en-US"}). 언어마다 프로세스를 하나씩 띄워 둔다.
    ocrs = {"ko": ocr}

    def ocr_for(lang):
        lang = lang if lang in ("ko", "en-US") else "ko"
        if lang not in ocrs:
            ocrs[lang] = Ocr(lang)
        return ocrs[lang]

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

        clients.add(ws)
        print(f"[연결] 브라우저 접속됨 (모드: {'실제 입력' if args.live else '안전모드'})")
        state["last_msg"] = time.time()
        # 페이지가 묻기 전에 알려준다: 입력 모드, 폰으로 보기가 켜졌는지
        await ws.send(json.dumps({"live": args.live, "remote": remote is not None, "halted": state["halted"]}))
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

                # 농부 문법 사전. 키와 무관하다.
                if kind == "kb_load":
                    try:
                        data = json.loads(FARM_DICT.read_text(encoding="utf-8")) if FARM_DICT.exists() else None
                        await ws.send(json.dumps({"id": msg.get("id"), "dict": data}))
                    except Exception as e:
                        await ws.send(json.dumps({"id": msg.get("id"), "error": str(e)}))
                    continue
                if kind == "kb_save":
                    try:
                        body = json.dumps(msg.get("dict"), ensure_ascii=False, indent=1)
                        if len(body.encode("utf-8")) > FARM_DICT_MAX:
                            raise ValueError("사전이 너무 큽니다")
                        # 쓰다가 죽어도 이전 파일이 망가지지 않게 임시 파일에 쓰고 바꿔치기한다
                        tmp = FARM_DICT.with_suffix(".tmp")
                        tmp.write_text(body, encoding="utf-8")
                        os.replace(tmp, FARM_DICT)
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": True}))
                    except Exception as e:
                        print(f"[사전 저장 실패] {e}")
                        await ws.send(json.dumps({"id": msg.get("id"), "error": str(e)}))
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

                if kind == "resume":
                    if state["halted"]:
                        print("[ESC] 정지를 풀었습니다")
                    state["halted"] = False
                    await ws.send(json.dumps({"id": msg.get("id"), "halted": False}))
                    continue

                # ESC 로 멈췄으면 아무것도 누르지 않는다
                if kind in ("move", "tap", "click", "scroll", "drag", "type", "key", "paste") and state["halted"]:
                    if presser.held:
                        presser.release_all()
                    await ws.send(json.dumps({"id": msg.get("id"), "ok": True, "live": args.live, "halted": True}))
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
                    await ws.send(json.dumps({"id": msg.get("id"), "ok": True, "live": args.live, "blocked": True}))
                    continue

                # 폰에서 정지했으면 키를 보내지 않는다 (PC 탭이 아직 모르고 계속 보내도)
                if kind in ("move", "tap", "click", "scroll", "drag", "type", "key", "paste") and remote is not None and remote.hold:
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
                elif kind == "click":
                    try:
                        fx, fy = float(msg.get("x")), float(msg.get("y"))
                    except (TypeError, ValueError):
                        fx = fy = -1
                    # 클릭은 대상 창을 직접 찾아서 누른다. 대상 창을 안 정했으면 어디를 누를지 모르니 막는다.
                    hwnd = find_window(WINDOW)
                    if not hwnd:
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": False, "live": args.live, "no_window": True}))
                        continue
                    res = clicker.click(hwnd, fx, fy, str(msg.get("button", "left")),
                                        int(msg.get("cw") or 0), int(msg.get("ch") or 0))
                    if res.get("at"):
                        tag = "클릭" if args.live else "[안전모드] 클릭"
                        print(f"{tag} {msg.get('button', 'left')} @ {res['at'][0]},{res['at'][1]} ({res['basis']} 기준)")
                    else:
                        print(f"[클릭 실패] {res.get('error')}")
                    await ws.send(json.dumps({"id": msg.get("id"), "ok": bool(res.get("at")), "live": args.live, **res}))
                    continue
                elif kind == "drag":
                    hwnd = find_window(WINDOW)
                    if not hwnd:
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": False, "live": args.live, "no_window": True}))
                        continue
                    try:
                        f1 = (float(msg.get("x1")), float(msg.get("y1")))
                        f2 = (float(msg.get("x2")), float(msg.get("y2")))
                    except (TypeError, ValueError):
                        f1 = f2 = (-1, -1)
                    res = clicker.drag(hwnd, f1, f2, int(msg.get("cw") or 0), int(msg.get("ch") or 0))
                    if res.get("from"):
                        tag = "끌기" if args.live else "[안전모드] 끌기"
                        print(f"{tag} {res['from'][0]},{res['from'][1]} → {res['to'][0]},{res['to'][1]}")
                    else:
                        print(f"[끌기 실패] {res.get('error')}")
                    await ws.send(json.dumps({"id": msg.get("id"), "ok": bool(res.get("from")), "live": args.live, **res}))
                    continue
                elif kind == "scroll":
                    hwnd = find_window(WINDOW)
                    if not hwnd:
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": False, "live": args.live, "no_window": True}))
                        continue
                    try:
                        fx, fy, n = float(msg.get("x")), float(msg.get("y")), int(msg.get("clicks"))
                    except (TypeError, ValueError):
                        fx = fy = -1
                        n = 0
                    res = clicker.scroll(hwnd, fx, fy, n, int(msg.get("cw") or 0), int(msg.get("ch") or 0))
                    if res.get("at"):
                        tag = "스크롤" if args.live else "[안전모드] 스크롤"
                        print(f"{tag} {'아래' if n > 0 else '위'} {abs(res['clicks'])}칸 @ {res['at'][0]},{res['at'][1]}")
                    else:
                        print(f"[스크롤 실패] {res.get('error')}")
                    await ws.send(json.dumps({"id": msg.get("id"), "ok": bool(res.get("at")), "live": args.live, **res}))
                    continue
                elif kind in ("type", "key", "paste"):
                    # 클릭과 같이 대상 창을 직접 찾아 앞으로 꺼낸 뒤 보낸다
                    hwnd = find_window(WINDOW)
                    if not hwnd:
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": False, "live": args.live, "no_window": True}))
                        continue
                    if args.live and not bring_to_front(hwnd):
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": False, "live": args.live,
                                                  "error": "게임 창을 맨 앞으로 꺼내지 못해 입력하지 않았습니다"}))
                        continue
                    if kind == "paste":
                        text = str(msg.get("text", ""))
                        try:
                            n = typer.paste(text)
                        except Exception as e:
                            await ws.send(json.dumps({"id": msg.get("id"), "ok": False, "live": args.live, "error": str(e)}))
                            continue
                        print(f"{'붙여넣기' if args.live else '[안전모드] 붙여넣기'} {n}글자: {text[:60]!r}")
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": True, "live": args.live, "typed": n}))
                    elif kind == "type":
                        text = str(msg.get("text", ""))
                        n = typer.type_text(text)
                        if not args.live:
                            print(f"[안전모드] 입력 {n}글자: {text[:60]!r}")
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": True, "live": args.live, "typed": n}))
                    else:
                        key = str(msg.get("key", ""))
                        ok = typer.press(key)
                        if ok and not args.live:
                            print(f"[안전모드] 키 {key}")
                        await ws.send(json.dumps({"id": msg.get("id"), "ok": ok, "live": args.live,
                                                  "error": None if ok else f"허용되지 않은 키: {key}"}))
                    continue
                elif kind == "stop":
                    presser.release_all()
                    print("[정지] 모든 키 해제")
                elif kind == "llm_models":
                    try:
                        models = await asyncio.to_thread(llm_models)
                        await ws.send(json.dumps({"id": msg.get("id"), "models": models}))
                    except Exception as e:
                        await ws.send(json.dumps({"id": msg.get("id"), "error": f"{LLM} 연결 실패: {e}"}))
                    continue
                elif kind == "llm_ask":
                    # 블로킹 HTTP 호출을 그냥 await하면 이벤트 루프가 멈춰서
                    # 그동안 워치독도 안 돈다. 반드시 스레드로 빼야 한다.
                    try:
                        t0 = time.time()
                        text = await asyncio.to_thread(
                            llm_ask,
                            msg.get("model", ""),
                            msg.get("prompt", ""),
                            msg.get("image"),
                            int(msg.get("timeout", 30)),
                            bool(msg.get("json")),
                            int(msg["max_tokens"]) if msg.get("max_tokens") else None,
                        )
                        took = time.time() - t0
                        print(f"[LLM] {took:.1f}초 · {text.strip()[:80]}")
                        await ws.send(json.dumps({"id": msg.get("id"), "text": text, "took": took,
                                                  "stats": dict(LAST_STATS) if LLM != "api" else None}))
                    except Exception as e:
                        print(f"[LLM 실패] {e}")
                        await ws.send(json.dumps({"id": msg.get("id"), "error": str(e)}))
                    continue
                elif kind == "ocr":
                    eng = ocr_for(msg.get("lang"))
                    try:
                        res = await asyncio.wait_for(
                            asyncio.to_thread(eng.read, msg.get("image") or ""), timeout=15
                        )
                        if res.get("error"):
                            print(f"[OCR 실패] {res['error']}")
                        else:
                            words = " / ".join(l["text"] for l in res.get("lines", []))
                            print(f"[OCR] {res.get('ms', 0)}ms · {words[:80] or '(글자 없음)'}")
                        await ws.send(json.dumps({"id": msg.get("id"), **res}))
                    except asyncio.TimeoutError:
                        eng.kill()
                        print("[OCR 실패] 15초 안에 답이 없어 다시 띄웁니다")
                        await ws.send(json.dumps({"id": msg.get("id"), "error": "OCR 응답 없음"}))
                    except Exception as e:
                        print(f"[OCR 실패] {e}")
                        await ws.send(json.dumps({"id": msg.get("id"), "error": str(e)}))
                    continue
                await ws.send(json.dumps({"ok": True, "live": args.live}))
        finally:
            clients.discard(ws)
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
    if LLM == "api":
        print(f"LLM         : API {API_BASE} (키 {'있음' if API_KEY else '없음 — LLM_API_KEY 를 넣으세요'})")
    else:
        print(f"LLM         : Ollama {OLLAMA}")
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
        print("\n실제 입력 모드입니다. 게임 창을 활성화해 두세요. 급히 멈추려면 ESC, 끄려면 이 창에서 Ctrl+C.")

    # 글자 인식용 이미지는 작은 글씨를 살리려고 2배로 키워 보내서 1MB(기본 한도)를 넘는다
    async with websockets.serve(handler, "127.0.0.1", args.ws_port, max_size=16 * 2**20):
        await watchdog()


def main():
    global OLLAMA, WINDOW, LLM, API_BASE, API_KEY
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
    p.add_argument(
        "--llm",
        choices=["ollama", "api"],
        default=None,
        help="LLM 을 어디에 물을지. 기본은 API 키가 있으면 api, 없으면 ollama",
    )
    p.add_argument(
        "--api-base",
        default=os.environ.get("LLM_API_BASE", API_BASE),
        help=f"OpenAI 호환 API 주소 (기본 {API_BASE}, 환경변수 LLM_API_BASE)",
    )
    p.add_argument(
        "--api-key",
        default="",
        help="API 키. 명령줄 기록에 남으니 되도록 환경변수 LLM_API_KEY 로 넣는다",
    )
    args = p.parse_args()
    OLLAMA = args.ollama.rstrip("/")
    API_BASE = args.api_base.rstrip("/")
    API_KEY = args.api_key or os.environ.get("LLM_API_KEY", "")
    LLM = args.llm or ("api" if API_KEY else "ollama")
    WINDOW = args.window.strip()

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n종료합니다")


if __name__ == "__main__":
    main()
