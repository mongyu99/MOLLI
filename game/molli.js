// 몰리: 중절모를 쓴 저폴리 3D 마스코트.
// 외부 3D 라이브러리 없이 캔버스 2D 위에 직접 그린다 — 박스 몇 개로 이루어진 모델이라
// 면 단위 평면 셰이딩 + 뒷면 제거 + 화가 알고리즘(먼 면부터 그리기)만으로 충분하다.
// 활성 탭에 따라 행동이 바뀐다: 향기 추적이면 곡괭이질, 지뢰찾기면 지뢰를 들고 조심조심 걷기.
(function () {
  const canvas = document.getElementById("molliCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const FOCAL = 225;
  const CAM_Z = 7.2;
  const WALK_RANGE = 0.85;
  const GROUND_Y = -0.79;

  function normalize(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }
  const LIGHT = normalize({ x: -0.45, y: 0.82, z: 0.55 });

  function matMul(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
        o[r * 3 + c] = s;
      }
    }
    return o;
  }
  function matVec(m, v) {
    return {
      x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
      y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
      z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
    };
  }
  const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rotX = (t) => [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)];
  const rotY = (t) => [Math.cos(t), 0, Math.sin(t), 0, 1, 0, -Math.sin(t), 0, Math.cos(t)];
  const rotZ = (t) => [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
  const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

  const CORNERS = [
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  ];
  const FACES = [
    { idx: [0, 1, 2, 3], n: V(0, 0, 1) },
    { idx: [5, 4, 7, 6], n: V(0, 0, -1) },
    { idx: [1, 5, 6, 2], n: V(1, 0, 0) },
    { idx: [4, 0, 3, 7], n: V(-1, 0, 0) },
    { idx: [3, 2, 6, 7], n: V(0, 1, 0) },
    { idx: [4, 5, 1, 0], n: V(0, -1, 0) },
  ];

  function shade(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * amount)));
    return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
  }

  function project(v) {
    const depth = CAM_Z - v.z;
    const s = FOCAL / Math.max(0.1, depth);
    // 시선 높이를 얼굴 쪽에 맞춘다. 낮게 두면 모자챙 밑면이 얼굴을 가린다.
    return { x: W / 2 + v.x * s, y: H / 2 - (v.y - 0.48) * s };
  }

  // 파트 트리를 순회하며 모든 면을 월드 좌표로 펼친다
  function collect(part, M, O, out) {
    const rot = part.rot || [0, 0, 0];
    const R = matMul(matMul(rotY(rot[1]), rotX(rot[0])), rotZ(rot[2]));
    const M2 = matMul(M, R);
    const O2 = add(matVec(M, part.pos || V()), O);

    if (part.size) {
      const c = part.center || V();
      const [hx, hy, hz] = [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2];
      const verts = CORNERS.map(([sx, sy, sz]) =>
        add(matVec(M2, V(c.x + sx * hx, c.y + sy * hy, c.z + sz * hz)), O2)
      );
      for (const f of FACES) {
        const n = matVec(M2, f.n);
        const quad = f.idx.map((i) => verts[i]);
        const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
        const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
        const cz = (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4;
        // 뒷면 제거: 면이 카메라 반대쪽을 보면 건너뛴다
        const toCam = { x: -cx, y: -cy, z: CAM_Z - cz };
        if (n.x * toCam.x + n.y * toCam.y + n.z * toCam.z <= 0) continue;
        const lambert = Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
        out.push({
          quad,
          z: cz,
          // 눈·입처럼 얼굴에 붙는 작은 파트는 깊이만으로 정렬하면 머리 면에 묻힌다.
          // 몰리는 정면에서 ±35도까지만 돌기 때문에 이 파트들을 항상 나중에 그려도 안전하다.
          layer: part.layer || 0,
          color: shade(part.color, 0.45 + 0.62 * lambert),
          alpha: part.alpha === undefined ? 1 : part.alpha,
        });
      }
    }
    for (const child of part.children || []) collect(child, M2, O2, out);
  }

  const C = {
    body: "#a06a2a",
    bodyDark: "#7a4a1e",
    stripe: "#2a1c0c",
    head: "#b5772f",
    eye: "#d94f3f",
    glint: "#ffe9e2",
    hat: "#33333c",
    hatDark: "#26262e",
    band: "#4fd8e0",
    wing: "#e2ecf7",
    iron: "#aab3c0",
    wood: "#c89a5b",
    stone: "#4a4a52",
    gem: "#4fd8e0",
    mine: "#2f2f36",
    mineCore: "#c0392b",
  };

  function head(walk) {
    return {
      pos: V(0, 0.66, 0.02),
      rot: [Math.sin(walk * 2) * 0.05, 0, 0],
      children: [
        { size: [0.72, 0.56, 0.58], color: C.head },
        { size: [0.24, 0.3, 0.14], center: V(-0.2, -0.01, 0.28), color: C.eye, layer: 1 },
        { size: [0.24, 0.3, 0.14], center: V(0.2, -0.01, 0.28), color: C.eye, layer: 1 },
        { size: [0.08, 0.09, 0.06], center: V(-0.26, 0.08, 0.34), color: C.glint, layer: 2 },
        { size: [0.08, 0.09, 0.06], center: V(0.14, 0.08, 0.34), color: C.glint, layer: 2 },
        { size: [0.18, 0.05, 0.06], center: V(0, -0.21, 0.28), color: C.stripe, layer: 1 },
        // 중절모
        { size: [0.9, 0.07, 0.76], center: V(0, 0.31, 0), color: C.hatDark },
        { size: [0.6, 0.1, 0.56], center: V(0, 0.38, 0), color: C.band },
        { size: [0.58, 0.3, 0.54], center: V(0, 0.56, 0), color: C.hat },
        { size: [0.22, 0.11, 0.5], center: V(0, 0.71, 0), color: C.hatDark },
      ],
    };
  }

  function wings(flutter) {
    return [
      { pos: V(-0.2, 0.36, -0.22), rot: [0.12, -0.18, 0.85 + flutter], size: [0.58, 0.05, 0.34], center: V(-0.29, 0, 0), color: C.wing, alpha: 0.75 },
      { pos: V(0.2, 0.36, -0.22), rot: [0.12, 0.18, -0.85 - flutter], size: [0.58, 0.05, 0.34], center: V(0.29, 0, 0), color: C.wing, alpha: 0.75 },
    ];
  }

  const torso = () => [
    { size: [0.64, 0.66, 0.46], color: C.body },
    { size: [0.66, 0.15, 0.48], center: V(0, -0.14, 0), color: C.stripe },
    { size: [0.66, 0.15, 0.48], center: V(0, 0.16, 0), color: C.stripe },
  ];

  const arm = (side, rot, children) => ({
    pos: V(0.42 * side, 0.2, 0),
    rot,
    size: [0.16, 0.46, 0.16],
    center: V(0, -0.23, 0),
    color: C.bodyDark,
    children,
  });
  const leg = (side, swing) => ({
    pos: V(0.18 * side, -0.33, 0),
    rot: [swing, 0, 0],
    size: [0.18, 0.46, 0.18],
    center: V(0, -0.23, 0),
    color: C.bodyDark,
  });

  // 곡괭이: 손 끝(팔 아래쪽)에 매달아 팔 스윙을 그대로 따라가게 한다.
  // 손잡이는 팔과 같은 갈색으로 두면 팔에 묻혀 안 보여서 밝은 나무색으로 구분했다.
  const pickaxe = () => ({
    pos: V(0, -0.46, 0),
    rot: [0.45, 0, 0],
    children: [
      { size: [0.09, 0.66, 0.09], center: V(0, -0.26, 0), color: C.wood },
      { size: [0.54, 0.11, 0.13], center: V(0, -0.57, 0), color: C.iron },
      { size: [0.13, 0.19, 0.13], center: V(-0.24, -0.5, 0), rot: [0, 0, 0.55], color: C.iron },
      { size: [0.13, 0.19, 0.13], center: V(0.24, -0.5, 0), rot: [0, 0, -0.55], color: C.iron },
    ],
  });

  // 들고 다니는 지뢰
  const mineProp = (wobble) => ({
    pos: V(0, 0.08, 0.6),
    rot: [wobble * 0.6, wobble, 0],
    children: [
      { size: [0.44, 0.44, 0.44], color: C.mine },
      { size: [0.26, 0.26, 0.26], color: C.mineCore, layer: 1 },
      { size: [0.12, 0.6, 0.12], color: C.stripe },
      { size: [0.6, 0.12, 0.12], color: C.stripe },
      { size: [0.12, 0.12, 0.6], color: C.stripe },
    ],
  });

  function digPose(t, phase) {
    // 팔은 아래로 늘어진 상태가 기준이라, 각도가 양수면 뒤로(들어올림) 음수면 앞으로(내리찍기) 간다.
    let armAngle;
    if (phase < 0.45) armAngle = lerp(-0.35, 2.3, Math.pow(phase / 0.45, 0.6));
    else if (phase < 0.6) armAngle = lerp(2.3, -0.8, Math.pow((phase - 0.45) / 0.15, 1.8));
    else armAngle = lerp(-0.8, -0.35, (phase - 0.6) / 0.4);

    const lean = phase > 0.45 && phase < 0.75 ? 0.2 : 0.07;
    const crouch = phase > 0.5 && phase < 0.7 ? -0.05 : 0;

    return {
      pos: V(0, crouch, 0),
      // 거의 옆모습으로 세워야 곡괭이가 다리에 가리지 않고 궤적이 보인다
      rot: [lean, 1.0, 0],
      children: [
        ...torso(),
        head(0),
        // 곡괭이는 카메라에 가까운 쪽 팔(-X)에 들려야 몸에 가리지 않는다
        arm(-1, [armAngle, 0, 0.12], [pickaxe()]),
        arm(1, [armAngle * 0.85, 0, -0.16]),
        leg(-1, 0.12),
        leg(1, -0.12),
        ...wings(Math.sin(t * 22) * 0.38),
      ],
    };
  }

  function carryPose(t, walk, facing) {
    const swing = Math.sin(walk) * 0.34; // 조심조심 종종걸음
    const tremble = Math.sin(t * 17) * 0.02;
    const bob = Math.abs(Math.sin(walk)) * 0.035;

    return {
      pos: V(0, bob, 0),
      rot: [0.05, facing, tremble],
      children: [
        ...torso(),
        head(walk),
        arm(1, [-1.45, 0, -0.22]),
        arm(-1, [-1.45, 0, 0.22]),
        leg(-1, swing),
        leg(1, -swing),
        mineProp(tremble * 1.5),
        ...wings(Math.sin(t * 26) * 0.5),
      ],
    };
  }

  // 곡괭이가 내리꽂히는 지점의 구덩이. 발 밑 기준으로 배치해서 곡괭이 끝과 어긋나지 않게 한다.
  const DIG_SPOT = V(0.42, GROUND_Y, 0.6);
  const digSite = () => ({
    pos: DIG_SPOT,
    children: [
      { size: [0.7, 0.12, 0.6], center: V(0, -0.02, 0), color: "#20242f" },
      { size: [0.24, 0.22, 0.22], center: V(-0.22, 0.12, 0.1), color: C.stone },
      { size: [0.2, 0.18, 0.2], center: V(0.24, 0.1, -0.12), color: C.stone },
      { size: [0.18, 0.2, 0.18], center: V(0.04, 0.13, 0.16), color: C.gem },
    ],
  });

  const particles = [];
  function spawnChips(originX) {
    for (let i = 0; i < 7; i++) {
      particles.push({
        pos: V(originX + DIG_SPOT.x + (Math.random() - 0.5) * 0.3, GROUND_Y + 0.12, DIG_SPOT.z + (Math.random() - 0.5) * 0.3),
        vel: V((Math.random() - 0.3) * 1.4, 1.2 + Math.random() * 1.3, (Math.random() - 0.5) * 0.9),
        life: 0.5 + Math.random() * 0.35,
        size: 0.05 + Math.random() * 0.06,
        spin: Math.random() * 6,
        color: Math.random() < 0.35 ? C.gem : C.stone,
      });
    }
  }

  function currentMode() {
    return "dig";
  }

  let x = 0;
  let dir = 1;
  let walk = 0;
  let digPhase = 0;
  let last = performance.now();
  let lastMode = null;
  const caption = document.getElementById("molliCaption");
  const CAPTIONS = { dig: "땅굴 파는 중", carry: "지뢰 옮기는 중" };

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!document.hidden) {
      const t = now / 1000;
      const mode = currentMode();
      if (mode !== lastMode) {
        lastMode = mode;
        caption.textContent = CAPTIONS[mode];
      }
      let root;
      let originX;

      if (mode === "dig") {
        const prev = digPhase;
        digPhase = (digPhase + dt * 0.85) % 1;
        // 곡괭이가 바닥에 닿는 순간에 파편을 튀긴다
        if (prev < 0.6 && (digPhase >= 0.6 || digPhase < prev)) spawnChips(-0.3);
        originX = -0.3;
        root = digPose(t, digPhase);
      } else {
        x += dir * dt * 0.34;
        if (x > WALK_RANGE) { x = WALK_RANGE; dir = -1; }
        if (x < -WALK_RANGE) { x = -WALK_RANGE; dir = 1; }
        walk += dt * 5.2;
        originX = x;
        root = carryPose(t, walk, dir * 0.62);
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.vel.y -= 5.2 * dt;
        p.pos = add(p.pos, { x: p.vel.x * dt, y: p.vel.y * dt, z: p.vel.z * dt });
        p.spin += dt * 9;
        p.life -= dt;
        if (p.life <= 0 || p.pos.y < GROUND_Y) particles.splice(i, 1);
      }

      ctx.clearRect(0, 0, W, H);

      const foot = project(V(originX, GROUND_Y - 0.03, 0));
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, 26, 7, 0, 0, Math.PI * 2);
      ctx.fill();

      const faces = [];
      collect(root, IDENT, V(originX, 0, 0), faces);
      if (mode === "dig") {
        collect(digSite(), IDENT, V(originX, 0, 0), faces);
        for (const p of particles) {
          collect(
            { pos: p.pos, rot: [p.spin, p.spin * 0.7, 0], size: [p.size, p.size, p.size], color: p.color },
            IDENT, V(), faces
          );
        }
      }

      faces.sort((a, b) => a.layer - b.layer || a.z - b.z);
      for (const f of faces) {
        ctx.globalAlpha = f.alpha;
        ctx.fillStyle = f.color;
        ctx.beginPath();
        const p0 = project(f.quad[0]);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < 4; i++) {
          const p = project(f.quad[i]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
