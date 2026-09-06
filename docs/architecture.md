# AI Development Framework MVP 아키텍처

## 목적과 범위

AI Development Framework는 요구사항에서 학습과 개선까지의 개발 생명주기를 신뢰 가능한 하나의 반복 흐름으로 연결합니다. 현재 MVP는 외부 자동화를 실행하는 완성된 플랫폼이 아니라, 이후 모든 실행이 따라야 할 **Core Trust Layer**의 상태, 권한, 증거와 경계를 고정하는 순수 도메인 모델입니다.

Self-Improvement는 아키텍처 전체의 이름이 아닙니다. 다른 capability의 검증된 결과를 학습하고 개선 candidate를 만드는 `SELF-IMPROVEMENT` capability이며, 그 candidate 역시 동일한 Trust Model, Human Approval, State Model과 Provenance를 거쳐야 합니다.

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

### Core

- **GRAPH Engine**: `REQUIREMENT → PLAN → IMPLEMENT → SEAL → PUBLISH → VERIFY exact published SHA → REVIEW` 같은 단계, 분기, 의존 산출물과 실행 역할을 선언하는 orchestration model입니다. GRAPH는 권한을 부여하지 않으며 Trust Model이 허용한 전환만 조정합니다.
- **LOOP Engine**: GRAPH의 실행 결과를 `LEARN → IMPROVE`로 연결하고 다음 실행에 반영하는 반복 모델입니다. 무한 자율 실행이 아니라 상태, 횟수 제한, 종료 조건과 Human Approval을 따르는 bounded loop입니다.
- **Trust Model**: trusted와 untrusted 실행을 분리하고 credential 및 publish 권한을 제한합니다.
- **Human Approval**: Human의 의사 결정을 검증 가능한 실행 권한으로 바꾸되, 시작 승인과 최종 Merge 경계를 AI에 넘기지 않습니다.
- **State Model**: 허용된 사건과 전환, `FIX` 횟수, terminal state를 결정론적으로 강제합니다.
- **Provenance**: 누가 어떤 policy version으로 승인했는지, 어떤 artifact가 공개됐는지, 어느 exact SHA가 검증·리뷰됐는지를 연결해 동일성과 감사 가능성을 제공합니다.

이 요소들은 독립된 우회 경로가 아닙니다. GRAPH가 역할과 capability를 배치하고 LOOP가 GRAPH를 반복하더라도, 각 실행은 State Model의 전환이어야 하고 Trust Model 및 Human Approval을 통과해야 하며 Provenance를 다음 단계에 전달해야 합니다.

### Agents / Roles와 Capabilities

| Role | 주 책임 | 대표 capability | 분리 원칙 |
| --- | --- | --- | --- |
| Planner | 요구사항을 실행 가능한 계획과 GRAPH로 구체화 | PLAN | 구현 결과를 사후 승인하는 역할과 구분 |
| Implementer | candidate 변경 생성 | `IMPLEMENT`, `FIX` | untrusted, GitHub write credential 없음 |
| Verifier | 공개 산출물의 기계적·재현 가능한 검증 | `VERIFY` | Implementer와 독립, exact SHA만 입력 |
| Reviewer | verified 결과의 의미적 적합성 판정 | REVIEW | 구현과 가능한 한 분리 |
| Improver | 결과에서 개선 candidate 제안 | `SELF-IMPROVEMENT` | 스스로 승인·공개·merge할 수 없음 |

capability의 정규 집합은 `PLAN`, `IMPLEMENT`, `VERIFY`, `REVIEW`, `FIX`, `PUBLISH`, `SELF-IMPROVEMENT`입니다. `PUBLISH`는 candidate 생성 Role의 권한이 아니라 Trusted Rail에 배치된 capability입니다. Role은 책임 주체를, capability는 수행 가능한 동작 권한을 뜻합니다. 하나의 Agent가 여러 Role을 구현할 수 있더라도 논리적 책임과 신뢰 경계는 유지합니다.

Human Authorization은 capability 집합의 항목이 아니라 Human Approval을 검증 가능한 실행 권한으로 변환하는 인가 경계입니다. `AUTHORIZE`, `SEAL`, `RECORD_PUBLISHED`, `START_REVIEW`는 State Model의 event 또는 Trust Boundary이고, `REQUIREMENT`, `LEARN`, `IMPROVE`는 GRAPH / LOOP의 입력·node이므로 capability와 구분합니다.

## Core Trust Layer의 현재 수직 단면

Issue #1의 상태 머신과 Trust Boundary는 별도의 Self-Improvement 전용 구조가 아니라 **Core Trust Layer**의 첫 구현입니다. Issue #3의 `SI-승인 → AUTHORIZE`는 그 위에서 동작하는 **Human Authorization** 인가 경계의 첫 구현입니다.

```text
Human SI-승인                     Human Approval
     ↓
Trusted AUTHORIZE                authorization provenance
     ↓
Untrusted IMPLEMENT              candidate patch, no write credential
     ↓
Trusted SEAL                     trusted artifact boundary
     ↓
Trusted PUBLISH                  published_head_sha
     ↓
Exact SHA VERIFY                 verification provenance
     ↓
Semantic Review                  verified SHA only
     ├─ PASS ───────────────────→ MERGE_READY → Human Merge (Human-only)
     ├─ STRUCTURAL_CHANGE ──────────→ STOPPED
     └─ LOCAL FIX (fixCount < 2) ─────────→ FIXING
                                          ↓
                         SEAL → PUBLISH → VERIFY exact published SHA → REVIEW
                                          └─ 재검토 decision에서만
                                             MERGE_READY / STOPPED / 다음 FIX
```

`LOCAL FIX` 분기는 terminal decision으로 직행하지 않습니다. `FIXING --SEAL--> SEALED`로 복귀해 `PUBLISH → VERIFY exact published SHA → REVIEW`를 반드시 재실행하며, `MERGE_READY`, `STOPPED`, 또는 다음 `FIX`는 이 재검토의 decision에서만 결정됩니다.

`state.ts`는 위 흐름에서 이미 발생한 사건을 검증해 기록할 뿐 GitHub 또는 Codex를 호출하지 않습니다. `RECORD_PUBLISHED`는 실제 PUBLISH 구현이 아니라 Trusted Rail이 반환할 immutable `published_head_sha`를 기록하는 경계입니다. `PASS` 역시 `MERGE_READY`까지만 이동하며 merge를 실행하지 않습니다.

### 상태와 Provenance의 결합

1. `AUTHORIZE`는 approver, policy version, 승인 시각을 authorization provenance로 남깁니다.
2. untrusted `IMPLEMENT` / `FIX` 결과는 직접 공개되지 않고 trusted `SEAL`을 통과합니다.
3. Trusted Rail의 `PUBLISH` 결과인 immutable `published_head_sha`를 상태에 기록합니다.
4. `VERIFY`는 실제 대상 SHA가 `published_head_sha`와 exact match일 때만 다음 상태를 허용합니다.
5. Semantic Review는 verified SHA만 소비하므로 구현, 검증, 검토가 같은 결과를 가리킵니다.
6. `MERGE_READY`는 권고 상태일 뿐이며 `RECORD_HUMAN_MERGE`는 Human이 외부에서 완료한 Merge 사실만 기록합니다.

상태의 상세 전환은 [상태 머신](state-machine.md), 실행 권한 경계는 [Trust Model](trust-model.md)을 참고하세요.

## GRAPH와 LOOP의 목표 구조

GRAPH는 개발 과정의 구조를 표현하고 LOOP는 그 구조를 다시 실행하는 조건을 표현합니다.

```text
REQUIREMENT → PLAN → IMPLEMENT → SEAL → PUBLISH → VERIFY exact published SHA → REVIEW
REVIEW ── LOCAL_FIX <= 2 ──► FIX → SEAL → PUBLISH → VERIFY exact published SHA → REVIEW
REVIEW ── PASS ──► MERGE_READY → Human Merge (Human-only)
reviewed result / provenance ── 별도 후속 흐름 ──► LEARN → IMPROVE → next bounded LOOP
```

이 그림은 목표 모델이며 현재 GRAPH Engine이나 LOOP Engine의 실제 구현을 의미하지 않습니다. 현재 `LOCAL_FIX <= 2` 전환은 향후 LOOP가 준수해야 할 bounded repetition의 도메인 선례입니다. `LEARN`은 reviewed result와 provenance를 소비하는 별도 후속 흐름이며, `PASS → MERGE_READY` 상태 전환이나 Human-only Merge 경계를 대체하지 않습니다. `STRUCTURAL_CHANGE`와 `LOCAL_FIX` 한도 소진만 REVIEW decision에서 `STOPPED`로 전환합니다. 검증 실패는 상태 전환을 거부하고 Human 경계에서 처리하며, REVIEW를 거치지 않고 `STOPPED`로 전환하지 않습니다.

## 현재 구현 구성 요소

- `src/self-improvement/authorization.ts`: `SI-승인`, trusted approver, policy version을 검사하고 authorization provenance를 생성합니다.
- `src/self-improvement/state.ts`: 허용된 전환, exact SHA와 `FIX` 횟수 제한을 적용합니다.
- `src/self-improvement/review-decision.ts`: `PASS`, `LOCAL_FIX`, `STRUCTURAL_CHANGE`만 review decision으로 허용합니다.
- `policy/trusted-approvers.yml`: live collaborator permission 조회를 대신하는 versioned policy입니다.

디렉터리 이름 `self-improvement`는 현재 실험 트랙을 나타냅니다. 이번 문서 재정의는 repository rename이나 대규모 코드 리팩터링을 요구하지 않습니다.

## 비목표

현재 문서 정렬은 GitHub Actions나 기존 코드 동작을 변경하지 않습니다. repository rename, Codex 실행 방식 변경, 실제 GRAPH / LOOP Engine, branch/PR 자동 생성, write token 제공, 실제 artifact `SEAL` / `PUBLISH`, Self-Improvement 자동화 확장과 Auto Merge는 범위 밖입니다.

전체 단계의 증명 목표는 [Roadmap](roadmap.md)에 정의합니다.
