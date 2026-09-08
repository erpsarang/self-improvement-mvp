# AI Development Framework MVP Roadmap

## Roadmap 원칙

이 Roadmap의 Phase는 기능 출시 순서나 구현 체크리스트가 아니라 **신뢰 가능한 AI 개발 프레임워크가 차례로 증명해야 하는 능력**을 나타냅니다. 다음 Phase로 갈수록 앞선 Phase의 Trust Model, Human Approval, State Model과 Provenance invariant를 유지합니다.

Phase 번호는 자동화 수준을 뜻하지 않습니다. 각 Phase의 실제 통합 시점은 달라질 수 있으며, Human-only Merge와 Auto Merge 금지는 모든 Phase에 적용됩니다.

## Phase 0 — Core State / Trust Model

**증명할 능력:** AI 실행을 시작하기 전에 허용 상태, 사건, 신뢰 경계와 terminal state를 결정론적으로 정의하고 위반을 거부할 수 있습니다.

- trusted / untrusted 영역과 credential 경계를 구분합니다.
- `SEAL` 우회, 검증 전 Review, exact SHA 불일치와 정의되지 않은 전환을 거부합니다.
- `MERGE_READY`와 `MERGED`를 분리하고 Human-only Merge를 invariant로 고정합니다.
- 상태 머신과 Trust Boundary를 다른 capability도 재사용할 **Core Trust Layer**로 다룹니다.

**증거:** Issue #1에서 시작한 상태 전환 및 Trust Boundary 도메인 모델과 테스트입니다.

## Phase 1 — Human Authorization

**증명할 능력:** 명시적인 Human 의사만 실행 시작 권한으로 전환하고, 그 근거를 재현·감사할 수 있습니다.

- `SI-승인 → AUTHORIZE`를 capability와 별개인 Human Authorization 인가 경계의 첫 사례로 사용합니다.
- approver, versioned trusted approver policy, 승인 시각을 provenance로 연결합니다.
- live collaborator permission 변화에 의존하지 않고 입력 정규화와 정책 검증을 거칩니다.
- 시작 승인이 최종 Merge 권한까지 포괄하지 않도록 Human 경계를 둘로 분리합니다.

**증거:** Issue #3의 authorization 모델과 테스트입니다. Issue #3의 진행 방향은 이 아키텍처 재정의로 바뀌지 않습니다.

## Phase 2 — AI IMPLEMENT

**증명할 능력:** AI Implementer가 요구사항과 계획을 candidate 변경으로 만들면서 저장소 공개 권한과 분리될 수 있습니다.

- Implementer는 GitHub write credential 없이 동작합니다.
- 결과는 untrusted candidate이며 직접 PUBLISH하거나 Merge하지 못합니다.
- 요구사항, 계획, 실행 환경과 candidate artifact 사이의 provenance를 보존합니다.
- candidate는 Trusted Rail의 검사를 거쳐야 다음 단계로 이동합니다.

**현재 증거:** Issue #10 / PR #11에서 `Trusted AUTHORIZE → untrusted IMPLEMENT → candidate.patch + implement.json`을 구현했습니다. Issue #12 / PR #13은 이 candidate를 실행하지 않고 identity와 digest를 확인해 `sealed.patch + seal.json`으로 승격하는 read-only Trusted `SEAL` 경계를 구현합니다. Worker 이후 trusted 영역으로의 GitHub Actions 진입점은 `.github/workflows/trusted-rail.yml` 하나로 유지합니다.

## Phase 3 — Independent VERIFY

**증명할 능력:** 구현 주체와 독립된 Verifier가 공개된 결과의 동일성과 품질 기준을 재현 가능하게 검사할 수 있습니다.

- Trusted Rail이 기록한 immutable `published_head_sha`를 검증 입력으로 사용합니다.
- checkout 및 검증 대상은 exact SHA match를 만족해야 합니다.
- 검증 명령, 결과와 대상 SHA를 provenance로 결합합니다.
- 실패 결과는 Review 진입이나 이미 완료된 PUBLISH의 검증 성공으로 오인되지 않으며, 전환 거부 또는 Human 경계로 처리합니다. 검증 실패가 REVIEW 없이 `STOPPED`로 전환되는 경로는 허용하지 않습니다.
- GitHub `workflow_run` 연쇄 제한 때문에 VERIFY는 별도 chained workflow가 아니라 Trusted Rail 내부의 독립 최소 권한 job으로 구현합니다.

## Phase 4 — Semantic REVIEW / FIX

**증명할 능력:** 기계적 검증을 통과한 동일 결과를 의미적으로 검토하고, 제한된 수정만 안전하게 반복할 수 있습니다.

- Reviewer는 verified SHA만 입력받고 Implementer와 가능한 한 분리됩니다.
- decision은 `PASS`, `LOCAL_FIX`, `STRUCTURAL_CHANGE`처럼 구조화합니다.
- `LOCAL_FIX`는 다시 `SEAL → PUBLISH → VERIFY → REVIEW` 경계를 거치며 최대 2회로 제한합니다.
- `MERGE_READY`, `STOPPED`, 또는 다음 `FIX`로의 전환은 항상 이 경계를 다시 거친 REVIEW decision 후에만 결정합니다. `STRUCTURAL_CHANGE`나 한도 초과는 자율 범위 확대가 아니라 `STOPPED`로 귀결합니다.

## Phase 5 — GRAPH Orchestration

**증명할 능력:** 개발 단계, 역할, 조건, 산출물과 분기를 명시적인 GRAPH로 표현하고 신뢰 경계를 보존하며 조정할 수 있습니다.

- `REQUIREMENT → PLAN → IMPLEMENT → SEAL → PUBLISH → VERIFY exact published SHA → REVIEW`의 의존 관계와 Review 후 bounded `FIX` 분기를 표현합니다.
- `PLAN`, `IMPLEMENT`, `VERIFY`, `REVIEW`, `FIX`, `PUBLISH`, `SELF-IMPROVEMENT`를 capability로 분류합니다. Human Authorization은 인가 경계, `AUTHORIZE` / `SEAL` / `RECORD_PUBLISHED`는 state event 또는 trust event, `REQUIREMENT` / `LEARN` / `IMPROVE`는 workflow 입력·node로 구분합니다.
- 각 node가 필요한 입력 provenance와 생성할 출력을 선언합니다.
- Agent 배치는 capability 권한을 자동 확대하지 않습니다.
- State Model에 없는 edge와 Trust Model을 우회하는 실행을 거부합니다.

## Phase 6 — LOOP Execution

**증명할 능력:** GRAPH를 피드백에 따라 반복하면서도 횟수, 비용, 시간, 상태와 Human Approval 같은 종료 조건을 지킬 수 있습니다.

- Review / FIX와 실패 복구를 bounded loop로 실행합니다.
- 각 반복이 어떤 이전 결과에서 시작했는지 provenance chain을 유지합니다.
- 무한 반복이나 자동 권한 확대 없이 `STOPPED`, Human escalation과 정상 종료를 구분합니다.
- LOOP는 GRAPH를 대체하지 않고, 허용된 GRAPH 실행을 반복합니다.

## Phase 7 — Self-Improvement

**증명할 능력:** 실행과 검증 결과에서 학습해 프레임워크 자체의 개선 candidate를 만들되 자기 승인 문제를 만들지 않습니다.

- `LEARN`은 verified 결과와 review provenance를 근거로 합니다.
- `LEARN`은 `PASS → MERGE_READY` 상태 전환을 대체하지 않는 별도 후속 흐름이며 Human-only Merge 경계를 우회하지 않습니다.
- Improver가 제안한 변경은 다른 untrusted candidate와 동일하게 취급합니다.
- `SELF-IMPROVEMENT`는 Human Approval, 독립 VERIFY / REVIEW와 Trusted Rail을 우회할 수 없습니다.
- 개선 전후의 기준과 효과를 추적해 반복이 실제 개선인지 평가합니다.

## Phase 8 — Dogfooding

**증명할 능력:** 프레임워크가 자기 자신과 실제 애플리케이션을 모두 개발하면서 특정 저장소나 기술 스택에 종속되지 않음을 보여 줍니다.

- 프레임워크 자체 변경에 전체 GRAPH / LOOP / Trust 흐름을 적용합니다.
- SAP RAP 같은 실전 개발 사례에도 같은 역할, capability와 provenance 계약을 적용합니다.
- 서로 다른 대상에서 검증 가능성, 감사 가능성과 Human 통제 원칙이 유지되는지 평가합니다.
- Dogfooding 결과를 다음 개선 candidate로 연결하되 최종 Merge는 계속 Human-only로 유지합니다.

## 현재 위치와 경계

현재 저장소는 **Phase 0 Core State / Trust Model**, **Phase 1 Human Authorization**, **Phase 2 AI IMPLEMENT**, **Phase 3 Independent VERIFY**, **Phase 4 Semantic REVIEW의 PASS/LOCAL_FIX/STRUCTURAL_CHANGE 판정**, 그리고 **Phase 5 GRAPH Orchestration의 첫 embedded control-plane slice**까지 실제 코드와 GitHub Actions로 연결했습니다.

현재 검증된 수직 흐름은 다음과 같습니다.

```text
Human SI-승인
→ AUTHORIZE
→ untrusted IMPLEMENT
→ Trusted Rail
   → SEAL
   → PUBLISH
   → VERIFY exact published SHA
   → Semantic REVIEW
   → Embedded Orchestrator
       ├─ PASS → MERGE_READY → exact-SHA Human Merge PR
       ├─ LOCAL_FIX → FIXING
       └─ STRUCTURAL_CHANGE → STOPPED
→ Human Merge
```

Issue #28 / PR #29 Smoke Test는 `PASS → MERGE_READY → exact-SHA Human Merge PR → Human Merge` 경로를 실환경에서 end-to-end로 증명했습니다. `review.json.reviewedHeadSha`, remote `ai-publish/issue-<N>` HEAD, Human Merge PR head SHA가 동일하게 유지됐고, `main`은 Human Merge 전까지 변경되지 않았습니다.

Issue #30 / PR #31은 Embedded Orchestrator가 마지막 허용 `workflow_run` chain depth에 의존하던 임시 구조를 제거하고, Semantic REVIEW 성공 뒤 **같은 Trusted Rail run 안에서 reusable Control Plane으로 직접 실행**되도록 재배치합니다. REVIEW artifact는 current Trusted Rail `run_id` / `run_attempt`에 exact binding되며 route와 provenance record 사이에서 다시 선택·검증합니다.

이 재배치가 완료되면 `AUTHORIZE → IMPLEMENT → Trusted Rail`까지만 `workflow_run` 진입 경계를 사용하고, Trusted Rail 내부에서는 `SEAL → PUBLISH → VERIFY → REVIEW → Orchestrator`가 명시적 job dependency / reusable workflow call로 연결됩니다. 이후 `LOCAL_FIX → untrusted FIX → SEAL → PUBLISH → VERIFY → REVIEW` bounded loop를 추가해도 Orchestrator 자체가 추가 `workflow_run` chain depth를 소비하지 않습니다.

아직 구현하지 않은 핵심은 **untrusted FIX Worker와 최대 2회 bounded FIX loop**, 전체 GRAPH Engine, LOOP Execution, LEARN / IMPROVE 기반 Self-Improvement 확장입니다. Auto Merge는 계속 금지하며 최종 Merge는 Human-only입니다.
