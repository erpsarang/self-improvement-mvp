# AI Development Framework MVP

AI를 이용해 소프트웨어의 요구사항 해석, 구현, 검증, 리뷰, 수정과 최종 반영을 하나의 **신뢰 가능한 반복 개발 프레임워크**로 연결하는 실험 저장소입니다.

저장소 이름은 `self-improvement-mvp`이지만 프로젝트의 주어는 **AI Development Framework MVP**입니다. Self-Improvement는 전체 프레임워크가 아니라 후속 capability입니다.

## v0.1 상태

**MVP v0.1의 핵심 bounded FIX loop는 실제 GitHub Actions 런타임에서 끝까지 검증되었습니다.**

Smoke Test #48 / PR #49에서 다음 전체 경로가 성공했습니다.

```text
Issue에 요구사항 작성
→ Human: SI-승인
→ Trusted AUTHORIZE
→ Untrusted IMPLEMENT
→ Trusted Rail
   → SEAL
   → PUBLISH
   → VERIFY exact published SHA
   → Semantic REVIEW
       ├─ PASS
       │   → MERGE_READY
       │   → exact-SHA Human Merge PR
       │   → Human Merge
       ├─ LOCAL_FIX
       │   → Trusted FIX Request
       │   → Untrusted FIX Worker
       │   → 다시 SEAL → PUBLISH → VERIFY → REVIEW
       └─ STRUCTURAL_CHANGE
           → STOPPED / Human 판단
```

최종 Merge는 **Human-only**이며 Auto Merge를 사용하지 않습니다.

## 이 프레임워크가 해결하려는 문제

AI에게 단순히 "코드를 만들어서 바로 Merge하라"고 맡기지 않습니다.

```text
AI가 만들었다 ≠ 신뢰할 수 있다
```

따라서 구현과 검증, 리뷰, 수정, 최종 승인 사이에 명확한 Trust Boundary를 둡니다.

```text
Human
  ├─ 시작 승인: SI-승인
  └─ 최종 승인: Human Merge

Untrusted
  ├─ IMPLEMENT Worker
  ├─ FIX Worker
  └─ AI Semantic Reviewer

Trusted
  ├─ AUTHORIZE
  ├─ SEAL / PUBLISH / VERIFY
  ├─ REVIEW provenance finalize
  ├─ FIX Request
  └─ Embedded Orchestrator
```

## 핵심 원칙

- Human start는 Issue의 정확한 `SI-승인` 1회입니다.
- 최종 Merge는 **Human-only**입니다.
- Auto Merge는 금지합니다.
- `IMPLEMENT` / `FIX` Worker에는 GitHub write credential을 주지 않습니다.
- Worker 결과는 곧바로 신뢰하지 않고 candidate artifact로만 취급합니다.
- candidate는 Trusted `SEAL`을 거친 뒤에만 publish할 수 있습니다.
- `VERIFY`는 branch 이름이 아니라 exact published SHA를 검증합니다.
- Semantic REVIEW는 승인 당시 requirements와 exact verified SHA를 함께 검토합니다.
- AI Reviewer의 raw output은 trusted 사실이 아니며 trusted finalize 후에만 `review.json` provenance가 됩니다.
- `LOCAL_FIX`는 최대 2회까지 허용하며, 매 FIX 후 전체 `SEAL → PUBLISH → VERIFY → REVIEW`를 다시 실행합니다.
- `STRUCTURAL_CHANGE`는 자동 수정하지 않고 사람에게 돌려보냅니다.
- `PASS`에서만 exact reviewed SHA에 대한 Human Merge PR을 생성합니다.

## GitHub Actions 역할

| Workflow | 역할 |
| --- | --- |
| `Trusted AUTHORIZE` | 사람의 `SI-승인`을 검증하고 요구사항과 기준 SHA를 고정 |
| `Untrusted IMPLEMENT` | Codex가 최초 구현을 수행하고 candidate artifact 생성 |
| `Trusted Rail` | candidate를 `SEAL → PUBLISH → VERIFY → REVIEW`로 검증 |
| `Semantic REVIEW` | 요구사항 충족 여부를 `PASS / LOCAL_FIX / STRUCTURAL_CHANGE`로 판정 |
| `Embedded Orchestrator` | REVIEW 결과에 따라 MERGE_READY / FIX / STOPPED로 routing |
| `Trusted FIX Request` | 수정 대상 SHA와 수정 지시를 immutable artifact로 고정 |
| `Untrusted FIX Worker` | Codex가 제한된 수정 수행 후 새 candidate artifact 생성 |
| `CI` | Framework 자체 PR의 workflow/test/build 정적 검증 |

## 신규 프로그래밍 요구사항에 사용하는 방법

가장 기본적인 사용 흐름은 다음과 같습니다.

```text
1. 신규 개발 요구사항 Issue 작성
2. 목표 / 범위 / 완료조건 / 검증방법을 명확히 기재
3. `policy/trusted-approvers.yml`에 등록된 trusted approver가 Issue에 SI-승인 댓글 작성
4. Framework가 자동으로 IMPLEMENT → 검증 → REVIEW 수행
5. LOCAL_FIX면 Framework가 제한된 FIX loop 자동 수행
6. PASS면 Human Merge PR 자동 생성
7. 사람이 최종 diff와 상태를 확인하고 Merge
```

예:

```text
요구사항
Sales Order 조회 API에 Sold-to Party 필터를 추가한다.

완료조건
- Sold-to Party로 조회 가능
- 기존 조회 조건 영향 없음
- 테스트 추가
- build/test 통과

금지사항
- 무관한 파일 수정 금지
- main 직접 push 금지
```

자세한 실사용 절차는 [`docs/usage.md`](docs/usage.md)를 참고하세요. 신규 Issue를 만들 때는 **AI 개발 요구사항** 템플릿을 사용할 수 있습니다.

## 프레임워크 구조

```text
AI Development Framework
├─ Core
│  ├─ GRAPH / Orchestration
│  ├─ LOOP / bounded retry
│  ├─ Trust Model
│  ├─ Human Approval
│  ├─ State Model
│  └─ Provenance
├─ Roles
│  ├─ Implementer
│  ├─ Verifier
│  ├─ Reviewer
│  └─ Orchestrator
└─ Capabilities
   ├─ IMPLEMENT / VERIFY / REVIEW
   ├─ FIX / PUBLISH
   └─ SELF-IMPROVEMENT (후속)
```

상세 레이어 관계는 [`docs/architecture.md`](docs/architecture.md), 단계별 방향은 [`docs/roadmap.md`](docs/roadmap.md)를 참고하세요.

## v0.1에서 실제 증명된 것

- Human `SI-승인 → AUTHORIZE` provenance
- write credential 없는 untrusted IMPLEMENT
- candidate artifact와 clean trusted provenance 기록
- Trusted SEAL
- force push 없는 deterministic PUBLISH
- exact published SHA VERIFY
- isolated read-only Semantic REVIEW
- `PASS / LOCAL_FIX / STRUCTURAL_CHANGE` decision
- Embedded Orchestrator routing
- immutable Trusted FIX Request
- explicit dispatch 기반 Untrusted FIX Worker
- FIX 결과의 full Trusted Rail 재진입
- bounded LOCAL_FIX loop
- `PASS → MERGE_READY → exact-SHA Human Merge PR`
- 최종 Human-only Merge

Smoke Test #48에서는 첫 구현을 의도적으로 `LOCAL_FIX` 상태로 만든 뒤, FIX #1이 수행되고 두 번째 Semantic REVIEW가 `PASS`하여 Human Merge PR #49가 자동 생성되었으며 사람이 최종 Merge했습니다.

## 아직 v0.1 범위 밖인 것

- PR 생성 후 외부 `@codex review` 실패를 공식 FIX loop에 연결
- FIX #2 강제 runtime smoke test
- durable / append-only 장기 provenance 저장소
- 범용 GRAPH Engine 전체 구현
- 자동 Self-Improvement loop
- Auto Merge

이 항목들은 v0.1 완료를 막지 않으며 후속 버전에서 다룹니다.

## 관련 문서

- [`docs/usage.md`](docs/usage.md) — 신규 요구사항 실사용 방법
- [`docs/architecture.md`](docs/architecture.md) — Framework 구조와 Trust Boundary
- [`docs/roadmap.md`](docs/roadmap.md) — 단계별 발전 방향
- [`docs/phase-5-review.md`](docs/phase-5-review.md) — Semantic REVIEW 설계
- [`docs/phase-6-orchestrator.md`](docs/phase-6-orchestrator.md) — Embedded Orchestrator 설계
