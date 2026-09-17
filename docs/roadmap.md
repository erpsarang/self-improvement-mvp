# AI Development Framework MVP Roadmap

## Roadmap 원칙

이 문서의 Phase는 단순 구현 순서보다 **신뢰 가능한 AI 개발 프레임워크가 증명해야 하는 능력**을 나타냅니다.

v0.2에서는 여러 과거 실험 Phase를 하나의 실제 end-to-end 수직 루프로 통합했습니다. 따라서 오래된 번호를 현재 개발 순서처럼 해석하지 않습니다.

모든 단계에 공통으로 적용되는 invariant:

- exact SHA / provenance
- fail-closed
- AI Worker 결과는 candidate
- Worker에 GitHub write credential 없음
- Human Approval 우회 금지
- final Merge Human-only
- Auto Merge 금지

## v0.1 — 안전한 실행 코어

v0.1에서 실제로 증명한 핵심:

```text
Human SI-승인
→ Trusted AUTHORIZE
→ Untrusted IMPLEMENT
→ SEAL
→ PUBLISH
→ VERIFY exact published SHA
→ Semantic REVIEW
→ bounded LOCAL_FIX
→ MERGE_READY
→ Human Merge
```

이 단계에서 Trust Model, exact SHA VERIFY, Semantic REVIEW, bounded FIX, Human-only Merge의 기초를 확보했습니다.

## v0.2 Phase 1 — User Requirement → read-only AI PLAN

**증명한 능력:** 사람이 구현 세부사항 대신 업무 요구를 작성하면 read-only Planner가 repository의 bounded Context를 근거로 machine-actionable PLAN을 제안할 수 있습니다.

주요 경계:

- Planner repository write 없음
- Context file/byte budget
- evidence-grounded analysis
- structured `implementationScope`
- exact target SHA
- PLAN은 proposal이며 authority 아님

## v0.2 Phase 2 — PLAN → Human Approval → IMPLEMENT → Trusted Rail → Human Merge

**증명한 능력:** 사람이 승인한 exact PLAN만 bounded Worker 실행 권한으로 승격하고, 결과를 기존 Trusted Rail에 truthful provenance로 연결할 수 있습니다.

```text
PLAN
→ Human PLAN-승인
→ PLAN_AUTHORIZE
→ ImplementContract + Context Pack
→ bounded IMPLEMENT Worker
→ deterministic CI
→ canonical PLAN Bridge
→ SEAL → PUBLISH → VERIFY → REVIEW
→ 필요 시 bounded FIX
→ MERGE_READY
→ Human Merge
```

### Phase 2에서 검증한 세부 capability

- exact PLAN identity / provenance
- immutable Human approval identity
- stale Requirement / target SHA fail-closed
- approved scope → ImplementContract deterministic handoff
- exact-SHA Context Pack
- bounded single-pass Worker
- known-good exact Codex Action pin과 timeout budget
- candidate trusted validation
- deterministic CI
- canonical PLAN Bridge
- PLAN source를 legacy IMPLEMENT로 가장하지 않는 truthful provenance
- Trusted Rail 재사용
- bounded FIX Worker
- exact reviewed SHA Human Merge boundary

## v0.2 Phase 3 — Human Merge → LEARN → IMPROVE → Human-selected LOOP

**증명한 능력:** 실제로 Merge가 끝난 cycle만 evidence-grounded 학습 대상으로 사용하고, 개선 후보가 자기 승인 없이 사람 선택을 거쳐 다음 cycle로 이어질 수 있습니다.

```text
Human Merge
→ Trusted Completed Cycle Record
→ bounded LEARN Input Pack
→ read-only AI LEARN
→ proposal-only Improvement Candidate Pack
→ Human selection
→ next Requirement / PLAN cycle
```

### Phase 3-A — Completed Cycle Record

실제 merged PR, reviewed SHA, merge commit, Trusted Rail/orchestration source를 exact identity로 고정합니다.

### Phase 3-B — bounded LEARN

Trusted control-plane이 bounded evidence pack을 만들고 read-only Learner가 그 exact pack만 읽습니다.

AI output은 evidence ID에 grounding되어야 하며 trusted finalize를 통과해야 합니다.

### Phase 3-C — Improvement Candidate

검증된 LEARN hypothesis를 deterministic하게 `proposal-only / pending-human` candidate로 투영합니다.

자동 ranking, Issue 생성, IMPLEMENT 시작은 하지 않습니다.

### Phase 3-D — Human-selected LOOP

사람이 선택한 candidate만 새 Requirement로 연결합니다.

실제 dogfood Improvement Candidate의 `candidate-hyp-01`을 사람이 선택해 Framework Issue #171로 연결했고, #171을 PLAN → IMPLEMENT/FIX → Trusted Rail → Human Merge까지 완주했습니다.

## v0.2 추가 증명 — exact test execution evidence

#171을 통해 LEARN이 Semantic REVIEW 문구와 실제 deterministic test 실행 사실을 구분하도록 확장했습니다.

```text
exact base + candidate patch
→ deterministicValidation PASS
→ candidatePatchDigest == sealedPatchDigest
→ publishedHeadSha
→ verifiedHeadSha
→ reviewedHeadSha
→ completed-cycle reviewedHeadSha
```

전체 chain이 exact match일 때만 `test-execution` evidence를 생성합니다.

Dogfood historical replay에서 `npm test / PASS / exitCode 0 / signal null`을 실제 evidence로 확인했습니다.

## v0.2 Release Candidate

현재 단계는 새 capability를 추가하는 단계가 아니라 **v0.2 전체 회귀·문서 정합성·dogfood 재현성을 고정하는 Release Candidate 단계**입니다.

Release blocker로 보는 것:

- regression 실패
- invalid canonical workflow
- exact SHA/provenance invariant 훼손
- Worker/Learner의 예상치 못한 write authority
- Human Approval 우회
- dogfood proof와 canonical implementation 불일치
- Auto Merge 또는 Human-only Merge 훼손

스타일 리팩터링, UI 개선, 실행시간 최적화, 새로운 기술 지원은 v0.2 Release blocker가 아닙니다.

## v0.3 이후 후보

### 1. 범용 GRAPH Engine

현재 GitHub Actions로 증명한 수직 graph를 provider/repository와 분리된 선언형 graph로 일반화합니다.

- node / edge / condition / artifact contract
- state transition validation
- bounded loop policy
- Human boundary 선언

### 2. Repository Adapter 분리

현재 GitHub adapter 중심 구현을 core와 분리합니다.

- GitHub
- 향후 GitLab 등

adapter가 Trust Model 자체가 되지 않도록 합니다.

### 3. 기술별 Verifier Adapter

Node 외 프로젝트에 동일한 exact-SHA 검증 계약을 적용합니다.

우선 후보:

- SAP RAP / ABAP Cloud
- Java / Maven / Gradle
- Python

### 4. durable provenance

GitHub Actions artifact retention을 넘어 장기 감사 가능한 append-only provenance 저장 구조를 검토합니다.

### 5. 운영 UI / Observability

사람이 다음을 한눈에 볼 수 있도록 합니다.

- 현재 state
- exact source SHA
- Human action 필요 여부
- Worker/Review/LEARN 비용과 시간
- failure/recovery chain

### 6. Embedded Orchestrator 제품화

현재 bootstrap Trusted Operator 역할을 점진적으로 Framework 내부의 provider-neutral orchestration interface로 흡수합니다.

단, embedded orchestration이 Human Approval이나 final Merge authority를 획득하는 것을 의미하지 않습니다.

## 장기 목표

```text
Human Requirement
        ↓
AI Development Framework
  GRAPH + LOOP
  Trust + State + Provenance
  Human Approval
  Provider / Repository / Verifier Adapters
        ↓
검증 가능한 software change
        ↓
Human Merge
        ↓
Evidence-grounded LEARN / IMPROVE
```

목표는 “AI가 더 많이 자동화한다”가 아니라 **AI가 더 많은 일을 하더라도 무엇을 근거로 했고 어디까지 권한이 있었는지 증명 가능한 개발 시스템**을 만드는 것입니다.
