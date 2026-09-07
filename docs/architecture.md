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
│      │                              │                   │
│      │                              ▼                   │
│      └──────────────────────► Capabilities              │
│                                                         │
│ LOOP Engine ── repeats GRAPH under bounded conditions   │
│                                                         │
│ Trust Model + State Model ── constrain every transition │
│ Provenance ── binds approval, artifact, SHA and result  │
└─────────────────────────────────────────────────────────┘
```

- **GRAPH Engine**: 단계, 조건, artifact dependency와 실행 역할을 선언합니다.
- **LOOP Engine**: 검토 결과를 bounded condition 아래 다음 FIX/개선 실행으로 되돌립니다.
- **Trust Model**: trusted/untrusted 실행과 credential boundary를 강제합니다.
- **Human Approval**: 시작 승인과 최종 Merge를 AI에 넘기지 않습니다.
- **State Model**: 허용된 사건과 전환, FIX 횟수, terminal state를 결정론적으로 강제합니다.
- **Provenance**: 승인, artifact, exact SHA, AI 판단과 결과를 서로 결합합니다.

GRAPH와 LOOP는 Trust Model을 우회하는 자동화가 아닙니다. 모든 실행은 State Model의 허용 전환이며 Human Approval과 Provenance를 계속 보존해야 합니다.

## Roles와 Capabilities

| Role | 주 책임 | 대표 capability | 신뢰 원칙 |
| --- | --- | --- | --- |
| Planner | 요구사항을 실행 가능한 계획으로 구체화 | `PLAN` | Human 승인/merge 권한 없음 |
| Implementer | candidate 변경 생성 | `IMPLEMENT`, `FIX` | untrusted, GitHub write credential 없음 |
| Verifier | 공개된 결과의 기계 검증 | `VERIFY` | exact SHA, Implementer와 runner 분리 |
| Reviewer | verified 결과의 의미적 적합성 판정 | `REVIEW` | untrusted AI reasoning + trusted finalize 분리 |
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
│ Trusted SEAL                                                   │
│   candidate bytes/identity만 검증, code 실행 안 함             │
│      ↓                                                         │
│ Trusted PUBLISH                                                │
│   ai-publish/issue-N, exact publishedHeadSha                   │
│      ↓                                                         │
│ Trusted VERIFY prepare                                         │
│      ↓                                                         │
│ Isolated candidate exact-SHA VERIFY                            │
│      ↓                                                         │
│ Trusted VERIFY finalize → verify.json                          │
│      ↓                                                         │
│ Semantic REVIEW (synchronous reusable workflow in same run)    │
│   ├─ trusted prepare                                           │
│   ├─ isolated AI reviewer                                      │
│   └─ trusted finalize → review.json                            │
└────────────────────────────────────────────────────────────────┘
     ├─ PASS → MERGE_READY → Human Merge
     ├─ STRUCTURAL_CHANGE → STOPPED
     └─ LOCAL_FIX (fixCount < 2) → FIXING → untrusted FIX
                                       ↓
                                 Trusted Rail 재진입
```

현재 `state.ts`에는 이 논리적 상태와 decision contract가 이미 존재하지만 GitHub 실행 orchestration 전체를 아직 state persistence에 연결하지는 않았습니다. `PASS`도 merge를 실행하지 않고 `MERGE_READY`까지만 이동합니다.

## GitHub Actions 실행 구조

GitHub의 `workflow_run` chain 길이 제한 때문에 논리 node마다 별도 chained workflow를 만들지 않습니다.

```text
Trusted AUTHORIZE workflow
        ↓
Untrusted IMPLEMENT workflow
        ↓ candidate artifact
Trusted Rail workflow       ← worker → trusted 단일 진입점
        ├─ seal
        ├─ publish
        ├─ verify_prepare
        ├─ verify_candidate
        ├─ verify_finalize
        └─ review ──uses──► semantic-review.yml (workflow_call)
                           ├─ review_prepare
                           ├─ review_agent
                           └─ review_finalize
```

`semantic-review.yml`은 별도 `workflow_run`이 아니라 **동일 Trusted Rail run의 reusable workflow call**입니다. 즉 실행 단위의 모듈화는 하되 새로운 trust-chain 진입점을 만들지 않습니다.

workflow-level `permissions`는 비워 두고 job별 최소 권한을 사용합니다. 현재 write 권한은 `publish`에만 존재합니다.

## Provenance chain

1. `authorize.json`
   - Human approval
   - immutable approver identity
   - trusted policy snapshot
   - 승인 당시 requirements `{title, body, digest}`
   - exact authorized base SHA
2. `implement.json`
   - compact authorization binding
   - candidate patch digest
   - untrusted AI execution identity
3. `seal.json`
   - candidate exact bytes digest
   - IMPLEMENT/SEAL source run identity
4. `publish.json`
   - deterministic publish branch
   - exact remote `publishedHeadSha`
5. `verify.json`
   - exact `verifiedHeadSha`
   - `result: PASS`
6. `review.json`
   - exact `reviewedHeadSha`
   - original approved requirements snapshot/digest
   - reviewer provider/run/output digest
   - `PASS | LOCAL_FIX | STRUCTURAL_CHANGE`
   - structured findings

### 왜 REVIEW에서 AUTHORIZE artifact를 다시 읽는가

PUBLISH/VERIFY까지의 compact provenance는 requirements 본문 전체를 반복 복제하지 않고 digest만 유지합니다. Semantic Review에는 실제 승인된 문장이 필요하므로 VERIFY chain이 가리키는 **원본 AUTHORIZE run/attempt/artifact**를 다시 조회합니다. Trusted code는 원본 `authorize.json`의 digest를 재계산하고 compact chain과 exact match할 때만 Reviewer input으로 승격합니다.

현재 Issue 본문이나 최신 branch의 mutable text를 review 기준으로 사용하지 않습니다.

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
      │ provenance/schema/decision consistency 재검증
      ↓
review.json
```

AI Reviewer가 만든 JSON을 그대로 trusted decision으로 사용하지 않습니다. Trusted finalize가 다음을 강제합니다.

- exact `reviewedHeadSha == verifiedHeadSha`
- requirements digest exact match
- allowed decision 3개만 허용
- `PASS`에는 BLOCKER 금지
- `LOCAL_FIX`는 LOCAL BLOCKER만 허용
- `STRUCTURAL_CHANGE`는 STRUCTURAL BLOCKER 필수
- raw reviewer bytes digest 기록
- rerun artifact ambiguity는 fail-closed

Reviewer는 exact candidate를 읽을 수 있지만 GitHub write credential은 받지 않습니다. Candidate repository의 `AGENTS.md`, `.codex`, README, 주석 등은 data로 취급하고 자동 project instruction 주입을 비활성화합니다. Reviewer는 VERIFY가 이미 수행한 executable 검증을 반복하지 않고 정적 semantic review만 수행합니다.

## State와 REVIEW decision

```text
VERIFIED --START_REVIEW--> REVIEWING

REVIEWING --PASS------------------> MERGE_READY
REVIEWING --STRUCTURAL_CHANGE-----> STOPPED
REVIEWING --LOCAL_FIX, count < 2--> FIXING
REVIEWING --LOCAL_FIX, count >= 2-> STOPPED
```

`LOCAL_FIX` 이후에는 즉시 PASS나 Merge로 갈 수 없습니다. 반드시 `FIX → SEAL → PUBLISH → VERIFY → REVIEW` 전체 경로를 다시 거칩니다.

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
- `src/self-improvement/state.ts`
- `src/self-improvement/review-decision.ts`
- `.github/workflows/authorize.yml`
- `.github/workflows/implement.yml`
- `.github/workflows/trusted-rail.yml`
- `.github/workflows/semantic-review.yml`
- `policy/trusted-approvers.yml`

## 아직 구현하지 않는 것

- untrusted `FIX` Worker와 FIX provenance
- REVIEW decision의 실제 persistent state/GRAPH orchestration
- `MERGE_READY` 자동 상태 기록/PR lifecycle 연결
- Auto Merge (의도적으로 금지)
- Human Merge 자동화
- GRAPH Engine / LOOP Engine
- Embedded AI Orchestrator control plane
- durable provenance ledger

다음 설계 단계에서는 Semantic REVIEW의 실환경 smoke 결과를 기준으로, 단순히 FIX를 바로 붙이기보다 **외부 ChatGPT가 현재 수행하는 orchestration을 Framework 내부로 옮기는 Embedded AI Orchestrator 경계**와 FIX loop의 순서를 함께 결정합니다.
