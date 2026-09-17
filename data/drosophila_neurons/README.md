# Drosophila Olfactory Circuit Neurons (NeuroMorpho.org)

향기 기반 보석찾기 RL(강화학습) 게임 프로젝트를 위해 초파리(Drosophila melanogaster)의
**후각 처리 회로**에 속한 실제 뉴런 3D 형태 데이터(SWC)를 NeuroMorpho.org에서 선별 다운로드했습니다.

## 왜 이 뉴런들인가

초파리의 후각 회로는 "냄새 입력 → 학습 → 행동 출력"으로 이어지는 구조가 뚜렷해서,
향기 기반 탐색(scent-guided navigation) RL 모델을 설계할 때 참고하기 좋습니다.

| 폴더 | 역할 | RL 설계에서의 대응 |
|---|---|---|
| `antennal_lobe/projection_neurons` | 후각수용체 뉴런의 냄새 정보를 뇌 중심부로 전달 (PN, uniglomerular) | 환경의 "냄새 세기/방향" 관측(state) 입력 인코딩 |
| `antennal_lobe/local_neurons` | 후각엽 내 측면 억제 (GABAergic interneuron) | 입력 정규화 / gain control |
| `mushroom_body/kenyon_cells` | 냄새를 희소(sparse)하게 고차원으로 표현 (KC) | state의 고차원 feature expansion |
| `mushroom_body/dopaminergic_neurons_DAN` | 보상/처벌 신호 전달 (PAM, PPL1 등) | 보상 신호 / TD-error에 해당하는 학습 신호 |
| `mushroom_body/output_neurons_MBON` | 학습된 냄새-행동 연합의 최종 출력 (MBON) | action-value / 정책 출력 |
| `mushroom_body/inhibitory_APL` | 버섯체 전역 억제 뉴런 (APL) | 전역 정규화 / winner-take-all |

이 구조는 실제로 "버섯체 = 보상 신호로 학습하는 compartmentalized RL 네트워크"라는
관점으로 여러 계산신경과학 논문에서 다뤄집니다 (예: Aso et al. 2014; Bennett, Uchida & Gershman 2021).

## 파일 구성

- 각 `*.swc` 파일: 뉴런 1개의 3D 형태 재구성 데이터 (표준 SWC 포맷: 좌표, 반지름, 연결 구조)
- `metadata.csv`: 뉴런별 ID, 이름, 분류(cell_type), 뇌 영역(brain_region), 출처 아카이브, 원 논문 PMID/DOI

## 규모

- 총 107개 뉴런, 약 22MB
- antennal_lobe/projection_neurons: 20개
- antennal_lobe/local_neurons: 10개
- mushroom_body/kenyon_cells: 18개
- mushroom_body/output_neurons_MBON: 20개
- mushroom_body/dopaminergic_neurons_DAN: 35개
- mushroom_body/inhibitory_APL: 4개

## 출처 및 인용

데이터 출처: [NeuroMorpho.org](https://neuromorpho.org) (공개 학술 데이터베이스, API를 통해 다운로드)
NeuroMorpho.org 정책상 이 데이터를 연구/발표 등에 사용할 경우 `metadata.csv`의
`reference_pmid`/`reference_doi`에 명시된 원 논문을 인용해야 합니다.

주요 원본 데이터 출처:
- FlyEM (Janelia) — hemibrain 커넥톰 기반 버섯체 뉴런
- Cardona lab — 버섯체 형태 재구성
- Jefferis lab, Chiang lab — 후각엽 투사뉴런/국소뉴런
- Bock lab — 후각엽 투사뉴런
