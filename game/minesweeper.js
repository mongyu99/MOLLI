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

  // 열린 칸에 인접한 미개봉 칸. 정보가 없는 칸을 후보에서 빼면 학습이 훨씬 잘 붙는다.
  frontierCandidates() {
    const out = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.revealed[r][c] || this.flagged[r][c]) continue;
        if (this.neighbors(r, c).some(([nr, nc]) => this.revealed[nr][nc])) out.push([r, c]);
      }
    }
    return out;
  }

  // 숫자와 미개봉 칸 수가 같으면 그 칸들은 전부 지뢰로 확정된다 (1단계 제약 전파)
  certainMineMap() {
    const cm = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!this.revealed[r][c] || this.count[r][c] === 0) continue;
        const un = this.neighbors(r, c).filter(([nr, nc]) => !this.revealed[nr][nc]);
        if (un.length === this.count[r][c]) {
          for (const [nr, nc] of un) cm[nr][nc] = true;
        }
      }
    }
    return cm;
  }

  static bin(value, bins, lo, hi) {
    const out = new Array(bins).fill(0);
    const t = Math.max(lo, Math.min(hi, value));
    let idx = Math.floor(((t - lo) / (hi - lo)) * bins);
    if (idx >= bins) idx = bins - 1;
    out[idx] = 1;
    return out;
  }

  // 후각엽(AL) 전처리에 해당하는 단계.
  // 실제 초파리도 수용체 신호를 날것 그대로 버섯체에 보내지 않고 정규화/이득조절을 거쳐 보낸다.
  // 여기서도 원시 창 패턴 대신 "이 칸이 지뢰일 국소 증거"를 정규화한 PN 채널로 만들어 보낸다.
  // 무엇이 안전한지에 대한 판단 자체는 학습하지 않은 상태에서 도파민 보상으로 배운다.
  // 한 칸이 지뢰일 국소 증거. 로그에도 그대로 쓰여서 판단 근거를 사람이 읽을 수 있다.
  evidence(r, c, cm = this.certainMineMap()) {
    const known = (list) => list.filter(([x, y]) => cm[x][y] || this.flagged[x][y]).length;

    const revNb = this.neighbors(r, c).filter(([a, b]) => this.revealed[a][b] && this.count[a][b] > 0);
    const ratios = [];
    for (const [a, b] of revNb) {
      const un = this.neighbors(a, b).filter(([x, y]) => !this.revealed[x][y]);
      const k = known(un);
      const rem = un.length - k;
      const need = this.count[a][b] - k;
      ratios.push(rem <= 0 ? 0 : Math.max(0, Math.min(1, need / rem)));
    }

    const unrevealedTotal = this.size * this.size - this.revealedCount;
    return {
      minR: ratios.length ? Math.min(...ratios) : 1,
      maxR: ratios.length ? Math.max(...ratios) : 1,
      meanR: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1,
      revCount: revNb.length,
      myUnrevealed: this.neighbors(r, c).filter(([a, b]) => !this.revealed[a][b]).length,
      density: unrevealedTotal > 0 ? this.mineCount / unrevealedTotal : 0,
      certain: !!cm[r][c],
      hasClue: ratios.length > 0,
    };
  }

  observe(r, c, cm = this.certainMineMap()) {
    const e = this.evidence(r, c, cm);
    const B = MinesweeperEnv.bin;
    return [
      ...B(e.minR, 8, 0, 1),
      ...B(e.maxR, 8, 0, 1),
      ...B(e.meanR, 8, 0, 1),
      ...B(e.revCount, 9, 0, 8),
      ...B(e.myUnrevealed, 9, 0, 8),
      ...B(e.density, 6, 0, 0.6),
      e.certain ? 1 : 0,
      e.hasClue ? 1 : 0,
      e.minR === 0 ? 1 : 0,
    ];
  }
}

MinesweeperEnv.PN_DIM = 51;
