// 10x10 격자 위에서 보석(gem)이 향기를 퍼뜨리고, 초파리(fly)가 그 향기를 따라가는 환경
class GridWorld {
  constructor(size = 10, maxSteps = 150) {
    this.size = size;
    this.maxSteps = maxSteps;
    this.reset(true);
  }

  reset(randomizeGem = true) {
    this.fly = { x: Math.floor(this.size / 2), y: Math.floor(this.size / 2) };
    if (randomizeGem || !this.gem) {
      do {
        this.gem = {
          x: Math.floor(Math.random() * this.size),
          y: Math.floor(Math.random() * this.size),
        };
      } while (this.gem.x === this.fly.x && this.gem.y === this.fly.y);
    }
    this.steps = 0;
    this.trail = [{ ...this.fly }];
    return this.getObservation();
  }

  // 거리 기반 향기 세기 (보석에 가까울수록 강함)
  scentAt(x, y) {
    const dx = x - this.gem.x;
    const dy = y - this.gem.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return Math.exp(-dist / 2.5);
  }

  // 후각엽 투사뉴런(PN) 입력에 해당: 현재 칸 + 상하좌우 4칸의 향기 세기
  getObservation() {
    const { x, y } = this.fly;
    const dirs = [
      [0, 0],
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    return dirs.map(([dx, dy]) => this.scentAt(x + dx, y + dy));
  }

  // action: 0=제자리, 1=위, 2=아래, 3=왼쪽, 4=오른쪽
  step(action) {
    const moves = [
      [0, 0],
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    const [dx, dy] = moves[action];
    let nx = this.fly.x + dx;
    let ny = this.fly.y + dy;
    let bumped = false;
    if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) {
      nx = this.fly.x;
      ny = this.fly.y;
      bumped = true;
    }
    this.fly = { x: nx, y: ny };
    this.trail.push({ ...this.fly });
    if (this.trail.length > 40) this.trail.shift();
    this.steps++;

    const found = this.fly.x === this.gem.x && this.fly.y === this.gem.y;
    let reward = -0.01;
    if (bumped) reward -= 0.1;
    if (found) reward += 10;
    const done = found || this.steps >= this.maxSteps;

    return { obs: this.getObservation(), reward, done, found, bumped };
  }
}
