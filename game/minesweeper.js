// 표준 규칙 지뢰찾기 (9x9, 지뢰 10개)
class MinesweeperEnv {
  constructor(size = 9, mineCount = 10) {
    this.size = size;
    this.mineCount = mineCount;
    this.reset();
  }

  reset() {
    const n = this.size;
    this.mine = Array.from({ length: n }, () => new Array(n).fill(false));
    this.count = Array.from({ length: n }, () => new Array(n).fill(0));
    this.revealed = Array.from({ length: n }, () => new Array(n).fill(false));
    this.flagged = Array.from({ length: n }, () => new Array(n).fill(false));
    this.minesPlaced = false;
    this.dead = false;
    this.won = false;
    this.revealedCount = 0;
    this.lastHit = null;
  }

  inBounds(r, c) {
    return r >= 0 && r < this.size && c >= 0 && c < this.size;
  }

  neighbors(r, c) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        if (this.inBounds(r + dr, c + dc)) out.push([r + dr, c + dc]);
      }
    }
    return out;
  }

  // 첫 클릭 칸과 그 주변 8칸은 지뢰에서 제외 -> 첫 수는 항상 안전하고 빈 칸이 열린다
  placeMines(safeR, safeC) {
    const banned = new Set([`${safeR},${safeC}`]);
    for (const [r, c] of this.neighbors(safeR, safeC)) banned.add(`${r},${c}`);

    const spots = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!banned.has(`${r},${c}`)) spots.push([r, c]);
      }
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    for (let i = 0; i < this.mineCount && i < spots.length; i++) {
      const [r, c] = spots[i];
      this.mine[r][c] = true;
    }
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        this.count[r][c] = this.neighbors(r, c).filter(([nr, nc]) => this.mine[nr][nc]).length;
      }
    }
    this.minesPlaced = true;
  }

  safeCellTotal() {
    return this.size * this.size - this.mineCount;
  }

  // 반환: { hitMine, opened, won }
  reveal(r, c) {
    if (this.dead || this.won) return { hitMine: false, opened: 0, won: this.won };
    if (this.revealed[r][c] || this.flagged[r][c]) return { hitMine: false, opened: 0, won: false };
    if (!this.minesPlaced) this.placeMines(r, c);

    if (this.mine[r][c]) {
      this.dead = true;
      this.lastHit = { r, c };
      return { hitMine: true, opened: 0, won: false };
    }

    // 0인 칸은 주변까지 연쇄적으로 열림
    let opened = 0;
    const stack = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      if (this.revealed[cr][cc] || this.flagged[cr][cc]) continue;
      this.revealed[cr][cc] = true;
      this.revealedCount++;
      opened++;
      if (this.count[cr][cc] === 0) {
        for (const [nr, nc] of this.neighbors(cr, cc)) {
          if (!this.revealed[nr][nc]) stack.push([nr, nc]);
        }
      }
    }

    if (this.revealedCount >= this.safeCellTotal()) this.won = true;
    return { hitMine: false, opened, won: this.won };
  }

  toggleFlag(r, c) {
    if (this.dead || this.won || this.revealed[r][c]) return;
    this.flagged[r][c] = !this.flagged[r][c];
  }

  candidates() {
    const out = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!this.revealed[r][c] && !this.flagged[r][c]) out.push([r, c]);
      }
    }
    return out;
  }

  progress() {
    return this.revealedCount / this.safeCellTotal();
  }

  // 후보 칸 주변 5x5를 에이전트 입력(PN)으로 변환: 칸마다 [열림여부, 숫자/8, 판밖여부]
  observe(r, c) {
    const obs = [];
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (!this.inBounds(nr, nc)) {
          obs.push(0, 0, 1);
        } else if (this.revealed[nr][nc]) {
          obs.push(1, this.count[nr][nc] / 8, 0);
        } else {
          obs.push(0, 0, 0);
        }
      }
    }
    return obs;
  }
}
