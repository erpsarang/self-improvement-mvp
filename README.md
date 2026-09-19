# AI Development Framework MVP

AI를 이용해 소프트웨어의 **요구사항 해석 → 계획 → 구현 → 검증 → 리뷰 → 수정 → Human Merge → 학습 → 개선**을 하나의 신뢰 가능한 개발 루프로 연결하는 실험 프레임워크입니다.

저장소 이름은 `self-improvement-mvp`이지만 프로젝트의 주어는 **AI Development Framework**입니다. Self-Improvement는 전체 프레임워크가 아니라 Human Merge 이후의 하위 capability입니다.

## v0.2 검증 상태

v0.2에서는 비개발자 수준의 업무 요구를 시작점으로 다음 수직 흐름을 실제 GitHub Actions와 외부 dogfood 프로젝트에서 끝까지 검증했습니다.

```text
User Requirement
→ read-only AI PLAN
→ Human PLAN-승인
→ Trusted PLAN_AUTHORIZE
→ ImplementContract + exact-SHA Context Pack
→ bounded untrusted IMPLEMENT Worker
→ deterministic CI
→ canonical PLAN Bridge
→ Trusted Rail
   → SEAL
   → PUBLISH
   → VERIFY exact published SHA
   → Semantic REVIEW
   → 필요 시 bounded FIX
→ MERGE_READY
→ Human Merge
→ Trusted Completed Cycle Record
→ bounded LEARN Input Pack
→ read-only AI LEARN
→ proposal-only Improvement Candidate
→ Human-selected LOOP
→ 다음 Requirement / PLAN cycle
```

최종 Merge는 **Human-only**이며 Auto Merge를 사용하지 않습니다.

## Trust Model

이 프레임워크의 핵심은 AI가 만든 결과를 곧바로 신뢰하지 않는 것입니다.

```text
AI가 만들었다 ≠ trusted
```

역할은 다음처럼 분리합니다.

| 영역 | 역할 | 권한 원칙 |
| --- | --- | --- |
| Human | 요구 선택, `PLAN-승인`, 최종 Merge, 개선 후보 선택 | authority boundary |
| read-only AI | Planner, Learner | repository write 없음 |
| untrusted Worker | IMPLEMENT, FIX | GitHub write credential 없음, candidate만 생성 |
| Trusted control-plane | PLAN_AUTHORIZE, Bridge, SEAL, PUBLISH, VERIFY, provenance finalize, orchestration | exact identity와 최소 권한 |
| Semantic AI | REVIEW | isolated reasoning + trusted finalize |

모든 중요한 전환은 Issue/run/artifact/digest/SHA를 provenance로 묶고, 불일치는 **fail-closed**합니다.

## v0.2의 핵심 능력

### 1. Requirement → PLAN

사용자는 구현 방법을 세세하게 지시하지 않아도 됩니다. read-only AI Planner가 bounded Context를 보고 구조화된 `implementationScope`를 제안합니다.

PLAN은 proposal이며, exact PLAN identity를 사람이 `PLAN-승인`한 뒤에만 다음 단계로 이동합니다.

### 2. 승인된 PLAN → bounded IMPLEMENT

Trusted control-plane이 승인된 scope를 `ImplementContract`와 exact-SHA `Context Pack`으로 고정합니다.

Worker는 제한된 문맥만 보고 한 번의 candidate 변경안을 만들며 repository write credential을 받지 않습니다. candidate는 deterministic CI와 canonical PLAN Bridge를 통과한 뒤에만 Trusted Rail로 진입합니다.

### 3. Trusted Rail

```text
candidate
→ SEAL
→ PUBLISH
→ VERIFY exact published SHA
→ Semantic REVIEW
```

`LOCAL_FIX`가 필요하면 bounded FIX Worker가 수정 candidate를 만들고 전체 Trusted Rail을 다시 통과합니다. `PASS`에서만 `MERGE_READY`가 되고 Human Merge PR이 생성됩니다.

### 4. Human Merge → LEARN → IMPROVE

Merge가 실제 완료된 뒤에만 Completed Cycle Record를 만듭니다. LEARN은 exact completed-cycle provenance에 결합된 bounded evidence만 읽습니다.

LEARN 결과는 authority가 아니라 evidence-grounded proposal이고, Improvement Candidate도 `proposal-only / pending-human`입니다. 사람이 선택한 candidate만 새 Requirement / PLAN cycle로 연결됩니다.

## 실제 dogfood 증거

첫 v0.2 E2E 실증은 `erpsarang/sales-order-exception-analyzer`의 실제 업무 요구 Issue #8로 수행했습니다.

- Human Merge PR: #24
- reviewed exact SHA: `fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc`
- Trusted Rail: `34968101704 / attempt 1`
- Framework 개선 #171을 다시 dogfood에 동기화한 뒤 LEARN historical replay 성공
- Trusted LEARN Source: `35243815590 / attempt 1`
- 별도 `test-execution` evidence에서 `npm test / PASS / exitCode 0 / signal null` 확인

Semantic REVIEW의 문장과 실제 deterministic test execution 증거를 분리하고, exact provenance chain으로 LEARN에 결합하는 것까지 검증했습니다.

## v0.1과의 차이

v0.1은 `SI-승인 → IMPLEMENT → Trusted Rail → bounded FIX → Human Merge`라는 안전한 실행 코어를 증명했습니다.

v0.2는 그 위에 다음을 추가했습니다.

- User Requirement → read-only AI PLAN
- exact PLAN provenance + Human `PLAN-승인`
- machine-actionable ImplementContract / bounded Context
- bounded PLAN Worker + deterministic Bridge
- PLAN provenance를 보존한 Trusted Rail 연결
- Human Merge 이후 Completed Cycle / LEARN / IMPROVE
- Human-selected Self-Improvement LOOP
- actual deterministic test execution evidence의 LEARN 결합

## 현재 범위와 한계

v0.2는 신뢰 가능한 **수직 개발 루프**를 증명한 MVP입니다. 다음은 아직 일반화/확장 대상입니다.

- 범용 GRAPH DSL / 독립 실행 엔진
- GitHub 외 Repository Adapter
- Node 이외 SAP RAP/ABAP 등 전용 verifier adapter
- durable / append-only 장기 provenance store
- 운영 UI와 관측성 개선
- 비용·시간 최적화
- Framework/App별 OpenAI Project·API Key 분리와 AI call dedup / budget guardrail

Auto Merge는 향후 목표가 아니며, 최종 Merge는 계속 Human-only입니다.

## 문서

- [`docs/usage.md`](docs/usage.md) — v0.2 실제 사용 흐름
- [`docs/architecture.md`](docs/architecture.md) — Trust Boundary, provenance, 비용 경계 구조
- [`docs/roadmap.md`](docs/roadmap.md) — 현재 검증 위치와 다음 확장 방향
- [`docs/phase-5-review.md`](docs/phase-5-review.md) — Semantic REVIEW 설계
- [`docs/phase-6-orchestrator.md`](docs/phase-6-orchestrator.md) — Embedded Orchestrator 설계
