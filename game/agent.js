// 초파리 후각 회로를 본뜬 에이전트
// PN(후각엽 투사뉴런, 입력) -> KC(버섯체 케니언 세포, 희소 고차원 확장) -> MBON(출력뉴런, 행동 가치)
// 학습 신호는 도파민 뉴런(DAN)이 전달하는 보상예측오차(TD-error)로, 활성화된 KC->MBON 시냅스만 갱신한다.
class FlyBrain {
  constructor({
    nInputs = 5,
    nKC = 200,
    sparsity = 0.1, // APL 전역 억제로 남기는 활성 KC 비율 (실제 초파리도 ~5~10%)
    nActions = 5,
    lr = 0.15,
    gamma = 0.9,
    dopamineClip = 2.0, // 실제 DAN도 발화율에 한계가 있어 보상예측오차가 무한정 커지지 않는다
  } = {}) {
    this.nInputs = nInputs;
    this.nKC = nKC;
    this.kActive = Math.max(1, Math.round(nKC * sparsity));
    this.nActions = nActions;
    this.lr = lr;
    this.gamma = gamma;
    this.dopamineClip = dopamineClip;

    // PN -> KC: 고정된 무작위 희소 연결 (실제 안테나엽 -> 버섯체 배선도 고정, 무작위에 가깝다)
    this.W_pn_kc = [];
    for (let i = 0; i < nKC; i++) {
      const row = new Float32Array(nInputs);
      for (let j = 0; j < nInputs; j++) {
        row[j] = Math.random() < 0.6 ? Math.random() * 2 - 1 : 0;
      }
      this.W_pn_kc.push(row);
    }

    // KC -> MBON: 학습되는 가중치 (도파민 신호로 갱신), 시작은 0
    this.W_kc_mbon = [];
    for (let a = 0; a < nActions; a++) this.W_kc_mbon.push(new Float32Array(nKC));
  }

  // PN 입력을 받아 KC 층에서 희소 코드(활성 뉴런 집합)로 변환
  encode(obs) {
    const drive = new Float32Array(this.nKC);
    for (let i = 0; i < this.nKC; i++) {
      let s = 0;
      const row = this.W_pn_kc[i];
      for (let j = 0; j < this.nInputs; j++) s += row[j] * obs[j];
      drive[i] = s;
    }
    const order = [...drive.keys()].sort((a, b) => drive[b] - drive[a]);
    return order.slice(0, this.kActive); // 상위 k개만 활성 (APL 전역 억제 효과)
  }

  qValues(activeKC) {
    const q = new Float32Array(this.nActions);
    for (let a = 0; a < this.nActions; a++) {
      const w = this.W_kc_mbon[a];
      let s = 0;
      for (const i of activeKC) s += w[i];
      q[a] = s;
    }
    return q;
  }

  act(obs, epsilon) {
    const activeKC = this.encode(obs);
    const q = this.qValues(activeKC);
    let action;
    if (Math.random() < epsilon) {
      action = Math.floor(Math.random() * this.nActions);
    } else {
      action = 0;
      for (let a = 1; a < this.nActions; a++) if (q[a] > q[action]) action = a;
    }
    return { action, activeKC, q };
  }

  // 도파민(DAN) 매개 가소성: TD-error를 보상예측오차로 사용해 활성 KC->MBON 시냅스만 갱신
  learn(activeKC, action, reward, nextObs, done) {
    let target = reward;
    if (!done) {
      const nextActive = this.encode(nextObs);
      const nextQ = this.qValues(nextActive);
      target += this.gamma * Math.max(...nextQ);
    }
    const w = this.W_kc_mbon[action];
    let currentQ = 0;
    for (const i of activeKC) currentQ += w[i];
    let dopamine = target - currentQ;
    dopamine = Math.max(-this.dopamineClip, Math.min(this.dopamineClip, dopamine));
    // 활성 KC 개수로 정규화: 활성 시냅스 수가 늘어나도 한 스텝의 총 가중치 변화량은 일정하게 유지
    // (희소코딩 문헌의 표준 관례이자, 값 발산을 막는 핵심 장치)
    const step = (this.lr * dopamine) / activeKC.length;
    for (const i of activeKC) {
      w[i] += step;
    }
    return dopamine;
  }
}
