# AI Development Framework MVP 아키텍처

## 목적과 범위

AI Development Framework는 요구사항에서 구현·검증·리뷰·수정·학습·개선까지의 개발 생명주기를 하나의 **신뢰 가능한 반복 개발 프레임워크**로 연결합니다. Self-Improvement는 전체 아키텍처의 이름이 아니라 검증된 결과에서 개선 candidate를 제안하는 하위 capability입니다.

현재 MVP는 완성된 제품이 아니라 이후 모든 실행이 따라야 할 **Core Trust Layer**와 그 수직 단면을 GitHub Actions로 증명하는 단계입니다.

## 최종 제품 방향

현재 개발 단계에서는 외부 ChatGPT가 Trusted Operator / bootstrap cockpit 역할로 GitHub를 직접 다루지만, 이것은 최종 사용자 경험이 아닙니다.

```text
현재 개발 단계
Human → external ChatGPT → GitHub → Framework

최종 목표
Human → AI Development Framework
          ├─ GRAPH / LOOP
          ├─ State / Trust / Provenance
          ├─ Embedded AI Orchestrator
          └─ Repository Adapter
                  ↓
                GitHub
```

프레임워크의 AI 역할은 provider와 분리합니다.

```text
AIProvider
  ├─ OpenAI / Codex
  ├─ Azure OpenAI
  ├─ Anthropic
  └─ Local Model

AgentRuntime
  ├─ PLAN
  ├─ IMPLEMENT
  ├─ VERIFY
  ├─ REVIEW
  └─ IMPROVE
```

따라서 현재 `openai/codex-action` 사용은 GitHub adapter의 한 구현일 뿐 core identity가 아닙니다. 기능 설계의 기준은 **외부 ChatGPT가 없어도 Framework 자체가 AI provider를 호출해 동일한 state/trust rule 아래 실행할 수 있는가**입니다.

## 개념 레이어

```text
                         Human Approval
                    (start / final Merge boundary)
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────┐
│ Core                                                    │
│ GRAPH Engine ── schedules ──► Agents / Roles            │
│ LOOP Engine ── repeats GRAPH under bounded conditions   │
│ Trust Model + State Model ── constrain every transition │
│ Provenance ── binds approval, artifact, SHA and result  │
│ Embedded Orchestrator ── consumes trusted facts         │
└─────────────────────────────────────────────────────────┘
```

- **GRAPH Engine**: 단계, 조건, artifact dependency와 실행 역할을 선언합니다.
- **LOOP Engine**: 검토 결과를 bounded condition 아래 다음 FIX/개선 실행으로 되돌립니다.
- **Trust Model**: trusted/untrusted 실행과 credential boundary를 강제합니다.
- **Human Approval**: 시작 승인과 최종 Merge를 AI에 넘기지 않습니다.
- **State Model**: 허용된 사건과 전환, FIX 횟수, terminal state를 결정론적으로 강제합니다.
- **Provenance**: 승인, artifact, exact SHA, AI 판단과 결과를 서로 결합합니다.
- **Embedded Orchestrator**: trusted provenance를 소비해 다음 상태와 adapter action을 결정합니다. 현재 구현은 새로운 AI 판단 없이 REVIEW decision을 결정론적으로 routing합니다.

GRAPH와 LOOP는 Trust Model을 우회하는 자동화가 아닙니다. 모든 실행은 State Model의 허용 전환이며 Human Approval과 Provenance를 계속 보존해야 합니다.

## Roles와 Capabilities

| Role | 주 책임 | 대표 capability | 신뢰 원칙 |
| --- | --- | --- | --- |
| Planner | 요구사항을 실행 가능한 계획으로 구체화 | `PLAN` | Human 승인/merge 권한 없음 |
| Implementer | candidate 변경 생성 | `IMPLEMENT`, `FIX` | untrusted, GitHub write credential 없음 |
| Verifier | 공개된 결과의 기계 검증 | `VERIFY` | exact SHA, Implementer와 runner 분리 |
| Reviewer | verified 결과의 의미적 적합성 판정 | `REVIEW` | untrusted AI reasoning + trusted finalize 분리 |
| Orchestrator | trusted 결과의 다음 state/action 선택 | orchestration | trusted fact만 소비, deterministic |
| Improver | reviewed provenance에서 개선 candidate 제안 | `SELF-IMPROVEMENT` | 스스로 승인·publish·merge 불가 |

`PUBLISH`는 candidate 생성 Role의 권한이 아니라 Trusted Rail의 최소 write capability입니다. `AUTHORIZE`, `SEAL`, `RECORD_PUBLISHED`, `START_REVIEW` 등은 capability라기보다 State Model event 또는 Trust Boundary입니다.

## 현재 Core Trust Layer 수직 단면

```text
Human SI-승인
     ↓
Trusted AUTHORIZE
     │ authorize.json + approved requirements snapshot
     ↓
Untrusted IMPLEMENT
     │ candidate.patch + implement.json
     ▼
┌────────────────────────── Trusted Rail ──────────────────────────┐
│ Trusted SEAL → sealed.patch + seal.json                         │
│      ↓                                                         │
│ Trusted PUBLISH → ai-publish/issue-N + publishedHeadSha        │
│      ↓                                                         │
│ VERIFY prepare → isolated candidate VERIFY → VERIFY finalize   │
│      ↓                                                         │
│ Semantic REVIEW                                                │
│   trusted prepare → isolated AI reviewer → trusted finalize    │
│      ↓ review.json                                             │
│ Embedded Orchestrator                                          │
│   ├─ PASS → MERGE_READY → exact-SHA Human Merge PR            │
│   ├─ STRUCTURAL_CHANGE → STOPPED                               │
│   └─ LOCAL_FIX → FIXING (FIX Worker는 후속 구현)              │
└────────────────────────────────────────────────────────────────┘
     ↓
Human Merge (Human-only)
```

이전에는 외부 ChatGPT가 `review.json`을 읽고 다음 상태와 GitHub action을 결정했습니다. Issue #26 / PR #27부터 Framework 내부 Orchestrator가 그 역할의 첫 slice를 담당했고, Issue #30 / PR #31에서는 Orchestrator를 같은 Trusted Rail run의 Control Plane으로 재배치합니다.

## GitHub Actions 실행 구조

Trusted Rail 내부의 논리 node들은 별도 `workflow_run` chain으로 쪼개지 않고 job/reusable workflow로 연결합니다.

```text
Trusted AUTHORIZE workflow
        ↓ workflow_run
Untrusted IMPLEMENT workflow
        ↓ workflow_run
Trusted Rail workflow
        ├─ seal
        ├─ publish
        ├─ verify_prepare
        ├─ verify_candidate
        ├─ verify_finalize
        ├─ review ──uses──► semantic-review.yml
        │                  ├─ review_prepare
        │                  ├─ review_agent
        │                  └─ review_finalize
        └─ orchestrate ──uses──► orchestrator.yml
                              ├─ route
                              ├─ merge_boundary (PASS only)
                              └─ record
```

`semantic-review.yml`과 `orchestrator.yml`은 모두 별도 `workflow_run`이 아니라 동일 Trusted Rail run의 reusable workflow call입니다. 따라서 REVIEW 이후 Orchestrator 실행은 GitHub `workflow_run` chain depth에 의존하지 않습니다.

`Re-run failed jobs`로 Trusted Rail의 후반 job만 다시 실행되는 경우에는 성공한 REVIEW job이 재실행되지 않을 수 있습니다. Orchestrator는 이 상황에서 current run의 **현재 attempt 이하 최신 REVIEW artifact**를 선택하고 그 artifact의 실제 attempt를 source REVIEW provenance identity로 사용합니다. 최신 attempt에 artifact가 중복되면 fail-closed 합니다.

이 same-run 배치는 향후 `LOCAL_FIX → FIX → SEAL → PUBLISH → VERIFY → REVIEW → Orchestrator` bounded loop를 Framework Control Plane 안에서 연결하기 위한 기반입니다.

## 권한 구조

workflow-level 권한은 기본적으로 비워 두고 job별 최소 권한을 사용합니다.

- AUTHORIZE: 필요한 Issue/Actions read/write 최소 권한
- IMPLEMENT: untrusted worker에 GitHub write credential 없음
- SEAL: `contents: read`, `actions: read`
- PUBLISH: `contents: write`, `actions: read`
- VERIFY trusted jobs: `contents: read`, `actions: read`
- VERIFY candidate: `contents: read`, checkout credential 없음
- REVIEW trusted jobs: read-only
- REVIEW agent: exact SHA read-only, GitHub write credential 없음
- Orchestrator route/record: `contents: read`, `actions: read`
- Orchestrator merge boundary: `contents: read`, `pull-requests: write`

Orchestrator의 PR job에는 `contents: write`가 없으므로 publish branch나 `main`을 수정할 수 없습니다. PR 생성은 Merge와 분리됩니다.

## Provenance chain

1. `authorize.json`
   - Human approval, policy snapshot, 승인 requirements, exact authorized base SHA
2. `implement.json`
   - compact authorization binding, candidate patch digest, worker identity
3. `seal.json`
   - candidate exact bytes digest, IMPLEMENT/SEAL run identity
4. `publish.json`
   - deterministic publish branch, exact remote `publishedHeadSha`
5. `verify.json`
   - exact `verifiedHeadSha`, `result: PASS`
6. `review.json`
   - exact `reviewedHeadSha`
   - original approved requirements snapshot/digest
   - reviewer provider/run/output digest
   - `PASS | LOCAL_FIX | STRUCTURAL_CHANGE`
   - structured findings
7. `orchestration.json`
   - source REVIEW artifact/provenance와 실제 source REVIEW attempt
   - `fromState = REVIEWING`
   - REVIEW decision
   - `nextState = MERGE_READY | FIXING | STOPPED`
   - exact reviewed branch/SHA와 requirements digest
   - PASS인 경우 Human Merge PR number/url/base/head/exact SHA

## VERIFY Trust Boundary

VERIFY는 세 runner로 분리합니다.

```text
trusted verify_prepare
      ↓ exact published SHA
isolated verify_candidate
      ↓ job success/failure only
fresh trusted verify_finalize
      ↓
verify.json
```

Candidate code의 `postinstall`, test, build가 trusted handler/provenance filesystem을 변조하지 못하도록 runner 자체를 격리합니다. candidate artifact/output은 trusted provenance 입력으로 사용하지 않습니다.

성공 invariant:

```text
remote publish branch HEAD
== publish.json.publishedHeadSha
== isolated candidate checkout HEAD
== verify.json.verifiedHeadSha
```

## Semantic REVIEW Trust Boundary

REVIEW도 같은 패턴을 적용합니다.

```text
trusted review_prepare
      │ verify.json + original authorize.json 검증
      ↓
isolated review_agent
      │ exact verified SHA, read-only
      │ reviewer.json = untrusted
      ↓
fresh trusted review_finalize
      ↓
review.json
```

AI Reviewer가 만든 JSON을 그대로 trusted decision으로 사용하지 않습니다. Trusted finalize가 exact SHA, requirements digest, allowed decision, finding consistency, raw output digest와 rerun artifact identity를 검증합니다.

Reviewer는 exact candidate를 읽을 수 있지만 GitHub write credential은 받지 않습니다. Candidate repository의 `AGENTS.md`, `.codex`, README, 주석 등은 data로 취급하고 자동 project instruction 주입을 비활성화합니다.

## Embedded Orchestrator Trust Boundary

Orchestrator는 같은 Trusted Rail run의 exact REVIEW artifact를 다시 검증합니다. mutable Issue 본문이나 branch text는 next-state 판단에 사용하지 않습니다.

```text
trusted review.json
      ↓ exact revalidation
route
      ├─ PASS → MERGE_READY
      ├─ LOCAL_FIX → FIXING
      └─ STRUCTURAL_CHANGE → STOPPED
      ↓
PASS only: merge_boundary
      ↓ remote ai-publish HEAD exact recheck
Human Merge PR
      ↓
fresh record
      ↓ source REVIEW 재검증
orchestration.json
```

Human Merge PR invariant:

```text
review.json.reviewedHeadSha
== remote ai-publish/issue-N HEAD
== PR head SHA
```

기존 PR은 head/base 기준으로 exact open PR 하나일 때만 재사용합니다. 중복 PR, closed PR, head SHA mismatch는 fail-closed 합니다. Orchestrator는 PR을 merge하거나 Auto Merge를 활성화하지 않습니다.

## State와 REVIEW decision

```text
VERIFIED --START_REVIEW--> REVIEWING

REVIEWING --PASS------------------> MERGE_READY
REVIEWING --STRUCTURAL_CHANGE-----> STOPPED
REVIEWING --LOCAL_FIX, count < 2--> FIXING
REVIEWING --LOCAL_FIX, count >= 2-> STOPPED
```

현재 Orchestrator는 첫 REVIEW cycle의 `PASS/LOCAL_FIX/STRUCTURAL_CHANGE` routing을 실행에 연결합니다. FIX count persistence와 재검토 LOOP는 아직 구현하지 않습니다.

`LOCAL_FIX` 이후에는 즉시 PASS나 Merge로 갈 수 없습니다. 후속 구현에서도 반드시 `FIX → SEAL → PUBLISH → VERIFY → REVIEW` 전체 경로를 다시 거쳐야 합니다.

## Repository Adapter 방향

현재 실행 adapter는 GitHub이지만 core는 GitHub에 종속되지 않는 방향으로 유지합니다.

```text
Core Framework
    │
    ├─ GitHub Adapter
    ├─ GitLab Adapter
    ├─ Azure DevOps Adapter
    └─ SAP/BTP Adapter
```

Actions artifact는 현재 **operational trust anchor**이지 영구 provenance ledger가 아닙니다. 장기 append-only/durable provenance는 후속 설계 과제입니다.

## 현재 구현 구성 요소

- `src/self-improvement/authorization.ts` / `authorize-handler.ts`
- `src/self-improvement/implement.ts` / `implement-handler.ts`
- `src/self-improvement/seal.ts` / `seal-handler.ts`
- `src/self-improvement/publish.ts` / `publish-handler.ts`
- `src/self-improvement/verify.ts` / `verify-handler.ts`
- `src/self-improvement/review.ts` / `review-handler.ts`
- `src/self-improvement/orchestrator.ts` / `orchestrator-handler.ts`
- `src/self-improvement/state.ts`
- `.github/workflows/authorize.yml`
- `.github/workflows/implement.yml`
- `.github/workflows/trusted-rail.yml`
- `.github/workflows/semantic-review.yml`
- `.github/workflows/orchestrator.yml`
- `policy/trusted-approvers.yml`

## 아직 구현하지 않는 것

- untrusted `FIX` Worker와 FIX provenance
- FIX count의 persistent orchestration 및 재진입 LOOP
- 전체 GRAPH Engine / LOOP Engine
- Auto Merge (의도적으로 금지)
- Human Merge 자동화
- AI 자동 승인 / risk-based autonomy
- durable provenance ledger

다음 핵심 단계는 `FIXING` 상태를 실제 untrusted FIX Worker와 다시 `SEAL → PUBLISH → VERIFY → REVIEW → Embedded Orchestrator`로 연결하고, FIX 횟수 최대 2회의 bounded loop를 same-run Control Plane 위에서 증명하는 것입니다.
