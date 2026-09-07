# AI Development Framework MVP 아키텍처

## 목적과 범위

AI Development Framework는 요구사항에서 학습과 개선까지의 개발 생명주기를 신뢰 가능한 하나의 반복 흐름으로 연결합니다. 현재 MVP는 완성된 플랫폼이 아니라, 이후 모든 실행이 따라야 할 **Core Trust Layer**의 상태, 권한, 증거와 경계를 먼저 고정하고 그 수직 단면을 GitHub Actions로 단계적으로 구현합니다.

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

Issue #1의 상태 머신과 Trust Boundary는 별도의 Self-Improvement 전용 구조가 아니라 **Core Trust Layer**의 첫 구현입니다. Issue #3의 `SI-승인 → AUTHORIZE`는 그 위에서 동작하는 **Human Authorization** 인가 경계의 첫 구현입니다. Issue #10 / PR #11은 그 다음에 Codex Cloud를 write credential 없는 untrusted Worker로 배치해 candidate artifact만 만들도록 구현했습니다.

```text
Human SI-승인                     Human Approval
     ↓
Trusted AUTHORIZE                authorization provenance
     ↓
Untrusted IMPLEMENT              candidate patch, no write credential
     ↓
┌──────────────────────── Trusted Rail ────────────────────────┐
│ Trusted SEAL              trusted artifact boundary, read-only│
│      ↓                                                       │
│ Trusted PUBLISH           published_head_sha, write boundary  │
│      ↓                                                       │
│ Exact SHA VERIFY          verification provenance, read-only  │
│      ↓                                                       │
│ Semantic Review           verified SHA only                   │
└───────────────────────────────────────────────────────────────┘
     ├─ PASS ───────────────────→ MERGE_READY → Human Merge (Human-only)
     ├─ STRUCTURAL_CHANGE ──────────→ STOPPED
     └─ LOCAL FIX (fixCount < 2) ─────────→ FIXING → untrusted FIX Worker
                                                   ↓ candidate artifact
                                             Trusted Rail 재진입
```

`LOCAL FIX` 분기는 terminal decision으로 직행하지 않습니다. `FIXING --SEAL--> SEALED`로 복귀해 `PUBLISH → VERIFY exact published SHA → REVIEW`를 반드시 재실행하며, `MERGE_READY`, `STOPPED`, 또는 다음 `FIX`는 이 재검토의 decision에서만 결정됩니다.

`state.ts`는 위 흐름에서 이미 발생한 사건을 검증해 기록할 뿐 GitHub 또는 Codex를 호출하지 않습니다. 실제 Trusted PUBLISH가 반환한 immutable `published_head_sha`를 상태에 연결하는 사건이 `RECORD_PUBLISHED`입니다. `PASS` 역시 `MERGE_READY`까지만 이동하며 merge를 실행하지 않습니다.

### Trusted Rail 실행 구조

GitHub Actions에서는 `workflow_run`을 이용한 workflow 연쇄 길이에 제한이 있습니다. 따라서 논리적 단계 `SEAL → PUBLISH → VERIFY → REVIEW`를 각각 별도 chained workflow로 구현하지 않습니다.

```text
Untrusted IMPLEMENT workflow
        │ candidate artifact
        ▼
.github/workflows/trusted-rail.yml   ← trusted 영역 단일 진입점
        │
        ├─ seal job      read-only
        ├─ publish job   필요한 publish 권한만 별도 부여
        ├─ verify job    read-only / exact published SHA
        └─ review job    verified SHA만 소비하는 최소 권한
```

중요한 것은 **같은 workflow 파일에 있다는 사실이 권한 공유를 의미하지 않는다는 점**입니다. workflow-level 기본 권한은 비우고 각 job에 필요한 최소 권한을 별도로 부여합니다. 이렇게 하면 Worker와 Trusted Rail 사이의 경계는 하나로 유지하면서도 `SEAL`, `PUBLISH`, `VERIFY`, `REVIEW`의 논리적 책임과 credential boundary를 계속 분리할 수 있습니다.

PR #13은 이 구조에서 read-only `seal` job을 구현했고, PR #18은 별도 최소 write 권한의 `publish` job을 추가합니다. `VERIFY`, `REVIEW`는 후속 단계에서 같은 Trusted Rail에 독립 job으로 추가합니다.

### 상태와 Provenance의 결합

1. `AUTHORIZE`는 재조회한 원본 approval, approver, policy snapshot, 승인 시각과 trusted workflow run identity를 Actions artifact provenance로 남깁니다.
2. untrusted `IMPLEMENT` / `FIX`는 GitHub write credential 없이 candidate 변경만 생성합니다.
3. clean trusted job이 untrusted workspace를 직접 신뢰하지 않고 exact authorized base 기준 `candidate.patch`와 `implement.json` provenance로 기록합니다.
4. Worker가 끝나면 `.github/workflows/trusted-rail.yml`로 한 번만 trusted 영역에 진입합니다.
5. Trusted `SEAL` job은 candidate를 실행하거나 적용하지 않고 source IMPLEMENT identity, base SHA, provenance 구조와 SHA-256을 검사해 exact bytes를 `sealed.patch`로 보존하고 `seal.json`으로 provenance chain을 연장합니다.
6. Trusted Rail의 별도 `PUBLISH` job은 sealed artifact만 재검증하고 exact `baseSha`에 적용해 `ai-publish/issue-<N>` branch에 force 없이 공개한 뒤, 실제 remote SHA를 immutable `published_head_sha`로 `publish.json`에 기록합니다.
7. `VERIFY` job은 실제 대상 SHA가 `published_head_sha`와 exact match일 때만 다음 상태를 허용합니다.
8. Semantic Review는 verified SHA만 소비하므로 구현, 검증, 검토가 같은 결과를 가리킵니다.
9. `MERGE_READY`는 권고 상태일 뿐이며 `RECORD_HUMAN_MERGE`는 Human이 외부에서 완료한 Merge 사실만 기록합니다.

상태의 상세 전환은 [상태 머신](state-machine.md), 실행 권한 경계는 [Trust Model](trust-model.md)을 참고하세요.

## GRAPH와 LOOP의 목표 구조

GRAPH는 개발 과정의 구조를 표현하고 LOOP는 그 구조를 다시 실행하는 조건을 표현합니다.

```text
REQUIREMENT → PLAN → IMPLEMENT → SEAL → PUBLISH → VERIFY exact published SHA → REVIEW
REVIEW ── LOCAL_FIX <= 2 ──► FIX → SEAL → PUBLISH → VERIFY exact published SHA → REVIEW
REVIEW ── PASS ──► MERGE_READY → Human Merge (Human-only)
reviewed result / provenance ── 별도 후속 흐름 ──► LEARN → IMPROVE → next bounded LOOP
```

이 그림은 **논리적 개발 GRAPH**입니다. GitHub Actions에서 각 node가 반드시 별도 workflow 파일이어야 한다는 뜻은 아닙니다. 현재 GitHub 실행 어댑터에서는 untrusted Worker workflow와 Trusted Rail workflow를 크게 분리하고, Trusted Rail 내부의 job dependency로 `SEAL → PUBLISH → VERIFY → REVIEW`를 표현합니다.

현재 `LOCAL_FIX <= 2` 전환은 향후 LOOP가 준수해야 할 bounded repetition의 도메인 선례입니다. `LEARN`은 reviewed result와 provenance를 소비하는 별도 후속 흐름이며, `PASS → MERGE_READY` 상태 전환이나 Human-only Merge 경계를 대체하지 않습니다. `STRUCTURAL_CHANGE`와 `LOCAL_FIX` 한도 소진만 REVIEW decision에서 `STOPPED`로 전환합니다. 검증 실패는 상태 전환을 거부하고 Human 경계에서 처리하며, REVIEW를 거치지 않고 `STOPPED`로 전환하지 않습니다.

## 현재 구현 구성 요소

- `src/self-improvement/authorization.ts`: `SI-승인`, trusted approver, policy version을 검사하고 authorization provenance를 생성합니다.
- `src/self-improvement/state.ts`: 허용된 전환, exact SHA와 `FIX` 횟수 제한을 적용합니다.
- `src/self-improvement/review-decision.ts`: `PASS`, `LOCAL_FIX`, `STRUCTURAL_CHANGE`만 review decision으로 허용합니다.
- `policy/trusted-approvers.yml`: live collaborator permission 조회를 대신하는 versioned policy입니다.
- `.github/workflows/authorize.yml`: 정확한 `SI-승인` Issue comment만 artifact 조회에 필요한 최소 권한으로 처리합니다.
- `src/self-improvement/authorize-handler.ts`: 원본 approval을 재검증하고 trusted workflow artifact로 idempotency를 보장하며 Issue에는 artifact pointer만 기록합니다.
- `.github/workflows/implement.yml`: trusted `AUTHORIZE` 뒤 Codex Cloud를 untrusted `IMPLEMENT` Worker로 실행하고, 별도 clean trusted job이 candidate artifact를 기록합니다.
- `src/self-improvement/implement.ts` / `implement-handler.ts`: 승인 snapshot과 source workflow identity를 검증하고 candidate patch digest를 `implement.json` provenance에 결합합니다.
- `.github/workflows/trusted-rail.yml`: `Untrusted IMPLEMENT` 완료 후 trusted 영역으로 한 번만 진입합니다. workflow-level 권한은 비어 있고 `seal` job은 `contents: read`, `actions: read`, `publish` job만 `contents: write`, `actions: read`를 사용합니다.
- `src/self-improvement/seal.ts` / `seal-handler.ts`: candidate를 실행하지 않고 IMPLEMENT provenance, exact base SHA와 patch digest를 검증해 exact bytes `sealed.patch`와 `seal.json`을 생성합니다. `seal.json`은 SEAL을 해당 Trusted Rail run / attempt에 귀속합니다.
- `src/self-improvement/publish.ts` / `publish-handler.ts`: sealed artifact의 source identity와 exact bytes digest를 재검증하고 deterministic publish branch와 immutable `published_head_sha`를 `publish.json` provenance로 기록합니다.

Actions artifact는 보존 기간 동안 사용하는 operational trust anchor입니다. retention 만료 뒤의 장기 감사 provenance는 보장하지 않으며, durable/append-only provenance store 또는 동등한 장기 검증 수단은 후속 Framework 설계 TODO입니다.

디렉터리 이름 `self-improvement`는 현재 실험 트랙을 나타냅니다. 이 구조는 repository 이름이나 특정 AI Worker에 신뢰를 부여하는 것이 아니라, 역할과 credential boundary를 명시적으로 분리하는 실험을 우선합니다.

## 비목표

현재 자동화 범위는 `Human SI-승인 → Trusted AUTHORIZE → untrusted IMPLEMENT → candidate artifact → Trusted SEAL → Trusted PUBLISH → immutable published_head_sha`까지입니다. 아직 Pull Request 자동 생성, exact SHA `VERIFY`, Semantic Review, `FIX`, 실제 GRAPH / LOOP Engine, `MERGE_READY`, Auto Merge를 구현하지 않습니다.

특히 `SEAL`은 candidate 기능을 승인하거나 검증하는 단계가 아니며 write 권한을 갖지 않습니다. `PUBLISH`의 write 권한도 publish branch 생성/fast-forward에만 사용하며 `main` 직접 push, force push, merge를 허용하지 않습니다. 최종 Merge는 계속 Human-only입니다.

전체 단계의 증명 목표는 [Roadmap](roadmap.md)에 정의합니다.