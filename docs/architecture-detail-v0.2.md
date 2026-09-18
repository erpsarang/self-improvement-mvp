# AI Development Framework MVP v0.2 상세 아키텍처 — Archived Reference

> 이 문서는 기존 v0.2 상세 구현 아키텍처를 보존한 참고 문서입니다.
> 현재 설계의 최상위 기준은 [architecture.md](architecture.md)입니다.

## 목적

AI Development Framework는 요구사항에서 계획·구현·검증·리뷰·수정·Human Merge·학습·개선까지를 하나의 **신뢰 가능한 반복 개발 프레임워크**로 연결합니다.

Self-Improvement는 전체 프레임워크의 이름이 아니라, 완료된 개발 cycle에서 evidence-grounded 개선 후보를 만들고 사람이 선택한 후보만 다음 Requirement로 연결하는 하위 capability입니다.

v0.2의 핵심 성과는 범용 개발 플랫폼 전체를 완성한 것이 아니라, 다음 end-to-end 수직 단면을 실제 GitHub Actions와 dogfood 프로젝트에서 증명한 것입니다.

```text
Requirement
→ PLAN
→ Human Approval
→ bounded IMPLEMENT
→ deterministic validation
→ Trusted Rail
→ Human Merge
→ LEARN
→ IMPROVE
→ Human-selected LOOP
```

## 상위 레이어

```text
AI Development Framework
├─ Core
│  ├─ State Model
│  ├─ Trust Model
│  ├─ Provenance
│  ├─ Human Approval
│  ├─ GRAPH / Orchestration
│  └─ LOOP / bounded repetition
├─ Semantic Roles
│  ├─ Planner
│  ├─ Reviewer
│  └─ Learner / Improver
├─ Candidate Producers
│  ├─ IMPLEMENT Worker
│  └─ FIX Worker
└─ Trusted Control Plane
   ├─ PLAN_AUTHORIZE
   ├─ Contract / Context Handoff
   ├─ Candidate Bridge
   ├─ SEAL / PUBLISH / VERIFY
   ├─ Review finalize / Orchestrator
   └─ Completed Cycle / LEARN source finalize
```

GRAPH와 LOOP는 Trust Model을 우회하는 자동화가 아닙니다. 모든 edge는 허용된 state transition이어야 하고, 반복할 때도 exact provenance와 Human Boundary를 유지합니다.

## v0.2 canonical 실행 흐름

```text
User Requirement
      ↓
read-only AI PLAN
      │ PLAN + implementationScope + provenance
      ↓
Human exact PLAN-승인
      ↓
Trusted PLAN_AUTHORIZE
      ↓
ImplementContract + exact-SHA Context Pack
      ↓
bounded untrusted IMPLEMENT Worker
      │ candidate artifact only
      ↓
Trusted Candidate Bridge
      │ clean exact-base apply + deterministic CI
      ↓
┌──────────────────── Trusted Rail ────────────────────┐
│ SEAL                                                 │
│   ↓                                                  │
│ PUBLISH → immutable publishedHeadSha                 │
│   ↓                                                  │
│ isolated VERIFY exact published SHA                  │
│   ↓                                                  │
│ Semantic REVIEW                                      │
│   ├─ PASS → MERGE_READY                              │
│   ├─ LOCAL_FIX → Trusted FIX Request → bounded FIX  │
│   └─ STRUCTURAL_CHANGE / limit → STOPPED             │
└──────────────────────────────────────────────────────┘
      ↓ PASS only
Human Merge PR
      ↓
Human Merge
      ↓
Trusted Completed Cycle Record
      ↓
bounded LEARN Input Pack
      ↓
read-only AI LEARN
      ↓
proposal-only Improvement Candidate Pack
      ↓
Human candidate selection
      ↓
next Requirement / PLAN cycle
```

## Human Boundary

v0.2는 Human 의사결정을 자동화와 분리합니다.

### 1. PLAN 승인

AI PLAN은 proposal입니다. Trusted `PLAN_AUTHORIZE`는 사람이 승인한 **exact PLAN**만 authority로 승격합니다.

최소 binding:

- Requirement Issue / digest
- PLAN run / attempt
- PLAN artifact / digest / provenance
- target repository
- frozen target SHA
- approval comment ID
- approver immutable user ID

Requirement나 target SHA가 바뀌면 최신 값을 몰래 대체하지 않고 fail-closed합니다.

### 2. 최종 Merge

Semantic REVIEW가 PASS해도 Framework가 Merge하지 않습니다.

```text
PASS
→ MERGE_READY
→ exact reviewed SHA Human Merge PR
→ Human Merge
```

Auto Merge는 금지됩니다.

### 3. Improvement 선택

LEARN/IMPROVE가 만든 candidate는 authority가 아닙니다. 사람에게 선택되지 않은 후보는 proposal-only 상태로 남습니다.

## read-only semantic roles

### Planner

Planner는 bounded Context만 읽어 구현 PLAN을 제안합니다. repository write, commit, push, PR 권한이 없습니다.

### Reviewer

Reviewer는 exact verified SHA와 승인 Requirement를 읽고 `PASS | LOCAL_FIX | STRUCTURAL_CHANGE`를 구조화해 제안합니다. raw AI output은 trusted 사실이 아니며 trusted finalize를 통과해야 합니다.

### Learner

Learner는 exact Completed Cycle에 결합된 bounded LEARN Input Pack만 읽습니다. latest main, unrelated Issue/PR, repository-wide 탐색을 authority로 사용하지 않습니다.

각 observation/lesson/hypothesis는 Input Pack의 evidence ID에 grounding되어야 합니다.

## untrusted candidate producer

IMPLEMENT/FIX Worker는 의도적으로 untrusted입니다.

- GitHub write credential 없음
- 승인 범위 밖 변경 금지
- bounded Context / file / byte budget
- 결과는 candidate artifact
- 직접 publish / PR / Merge 금지

PLAN 경로의 IMPLEMENT Worker 결과는 Trusted Candidate Bridge에서 clean exact-base checkout에 다시 적용됩니다. approved Contract의 validation command를 deterministic하게 실행해 PASS한 경우에만 canonical bridge artifact가 됩니다.

## Trusted Rail

Trusted Rail은 candidate를 공개·검증 가능한 exact 결과로 승격하는 경계입니다.

### SEAL

candidate provenance와 bytes/digest를 검증하고 봉인합니다.

### PUBLISH

SEAL된 결과만 deterministic publish branch에 게시합니다. PUBLISH만 최소한의 repository write capability를 갖습니다.

### VERIFY

VERIFY는 branch 이름을 신뢰하지 않고 exact `publishedHeadSha`를 검증합니다.

```text
remote publish HEAD
== publishedHeadSha
== isolated candidate checkout HEAD
== verifiedHeadSha
```

Candidate code 실행 runner와 trusted provenance finalize runner를 분리해 candidate가 credential이나 trusted filesystem을 이용하지 못하게 합니다.

### Semantic REVIEW / FIX

REVIEW는 verified SHA와 승인 Requirement를 exact binding합니다.

`LOCAL_FIX`인 경우:

```text
reviewed SHA + bounded fix instruction
→ Trusted FIX Request
→ Untrusted FIX Worker
→ candidate
→ 다시 SEAL → PUBLISH → VERIFY → REVIEW
```

FIX 결과도 전체 Trusted Rail을 다시 통과해야 합니다.

## Provenance chain

v0.2 PLAN 경로는 최소 다음 identity를 이어 붙입니다.

```text
Requirement digest
→ PLAN run/artifact/provenance + target SHA
→ Human PLAN approval
→ PLAN_AUTHORIZE
→ ImplementContract / Context digest
→ Worker candidate digest
→ deterministic validation evidence
→ candidatePatchDigest
→ SEAL sealedPatchDigest
→ PUBLISH publishedHeadSha
→ VERIFY verifiedHeadSha
→ REVIEW reviewedHeadSha
→ Human Merge PR / merge commit
→ Completed Cycle Record
→ LEARN Input Pack
→ LEARN report
→ Improvement Candidate Pack
```

각 단계는 latest state를 암묵적으로 재해석하지 않고 exact source identity를 보존합니다.

## test-execution evidence

v0.2에서는 Semantic REVIEW의 서술과 실제 테스트 실행 증거를 분리합니다.

허용된 trusted-content-chain은 다음과 같습니다.

```text
exact base + candidate patch
→ deterministicValidation PASS
→ candidatePatchDigest == sealedPatchDigest
→ PUBLISH publishedHeadSha
→ VERIFY verifiedHeadSha
→ Semantic REVIEW reviewedHeadSha
→ Completed Cycle reviewedHeadSha
```

이 chain이 모두 일치할 때만 LEARN Input Pack에 별도 `test-execution` evidence가 들어갑니다. 일반 PR CI metadata나 REVIEW 문장에서 tests passed를 추론하지 않습니다.

## LEARN / IMPROVE Trust Boundary

Human Merge 이후 trusted source가 실제 GitHub merge facts와 orchestration provenance를 다시 검증해 Completed Cycle과 bounded Input Pack을 만듭니다.

LEARN report는 untrusted semantic output이며 trusted verifier가 다음을 확인합니다.

- exact source pack digest
- valid evidence references
- resource budget
- schema / item uniqueness
- deterministic output digest

Improvement Candidate Pack은 검증된 hypothesis를 deterministic하게 1:1 투영할 뿐 새 semantic 판단이나 ranking을 추가하지 않습니다.

```text
authority = proposal-only
decision = pending-human
```

## 실제 dogfood 증거

`erpsarang/sales-order-exception-analyzer` Issue #8에서 v0.2 PLAN 기반 업무 개발 cycle을 실제로 완주했습니다.

- Human Merge PR #24
- reviewed SHA `fdfc6996aade470efbea1fb8ec4e4185a7dcc3fc`
- Trusted Rail `34968101704 / attempt 1`

이 cycle에서 나온 Improvement Candidate 중 사람이 `candidate-hyp-01`을 선택해 Framework Requirement #171로 연결했습니다. #171 구현·Human Merge 후 dogfood에 재동기화하고, 기존 Issue #8 exact provenance를 새 LEARN runtime으로 replay했습니다.

Trusted LEARN Source `35243815590 / attempt 1`은 성공했고 `npm test / PASS / exitCode 0 / signal null`의 별도 test-execution evidence를 생성했습니다.

## v0.2에서 의도적으로 남겨 둔 범위

다음은 v0.2에서 일반화하지 않습니다.

- 범용 GRAPH DSL / 독립 scheduler
- GitHub 외 repository adapter
- SAP RAP/ABAP 등 기술별 verifier adapter
- durable append-only provenance 저장소
- 운영용 UI/observability
- provider-neutral embedded runtime의 완전한 제품화

이 영역을 확장할 때도 exact provenance, fail-closed, untrusted Worker, Human Approval, Human-only Merge 원칙을 유지해야 합니다.
