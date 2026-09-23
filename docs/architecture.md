# AI Development Framework — Canonical Architecture

> **설계 기준 문서**
>
> AI Development Framework는 **AI가 스스로 개발하는 시스템이 아니라, 사람이 통제권을 유지하면서 AI 개발 노동력을 안전하게 사용하는 Trust Framework**다.
>
> Self-Improvement는 Framework 자체가 아니라 **선택적 하위 capability**다.

## 1. 우리가 만드는 것

사용자의 요구사항을 AI가 계획하고 구현할 수 있게 하되, AI의 결과를 곧바로 신뢰하지 않고 **명시적인 Human Boundary와 Trusted Validation을 거쳐 software change로 승격**하는 개발 프레임워크를 만든다.

```text
Human Requirement
       │
       ▼
Read-only AI PLAN
       │
       ▼
Human PLAN Approval            ← Trust Boundary #1
       │
       ▼
Bounded Untrusted IMPLEMENT
       │
       │ candidate artifact
       ▼
┌───────────────────────────────┐
│          TRUSTED RAIL         │
│                               │
│ deterministic validation      │
│ → SEAL                        │
│ → PUBLISH                     │
│ → VERIFY exact SHA            │
│ → Semantic REVIEW             │
└───────────────┬───────────────┘
                │
        ┌───────┴────────┐
        │                │
      PASS             FAIL
        │                │
        │          bounded FIX
        │                │
        │         반복 실패 / 결함
        │                ▼
        │              STOP
        │          Human Review
        ▼
   MERGE_READY
        │
        ▼
   Human Merge                   ← Trust Boundary #2
```

## 2. Framework의 핵심 원칙

1. **AI Worker는 Untrusted다.**
2. **AI 결과는 항상 Candidate다.**
3. **Human PLAN Approval 전에는 구현 authority가 없다.**
4. **Trusted Rail만 Candidate를 검증된 변경으로 승격할 수 있다.**
5. **exact SHA / provenance / fail-closed를 유지한다.**
6. **최종 Merge는 항상 Human-only다.**
7. **모든 반복은 bounded이며, 반복 실패 시 STOP한다.**
8. **Framework 결함을 Framework가 재귀적으로 무한 수정하지 않는다.**
9. **AI 비용도 Trust Boundary의 일부다. 동일 입력의 성공 AI 작업을 불필요하게 재호출하지 않는다.**
10. **Framework와 App은 OpenAI Project/API Key를 분리해 사용량·비용 provenance를 구분한다.**

Auto Merge는 설계 목표가 아니다.

## 3. Self-Improvement의 정확한 위치

Self-Improvement는 개발 실행 경로의 주인이 아니다. 완료된 실행 evidence를 읽고 **다음 개선 후보를 제안하는 sidecar capability**다.

```text
Framework Execution
       │
       ▼
Execution Evidence
       │
       ▼
      LEARN
       │
       ▼
Improvement Proposal
       │
       ▼
Human 판단
       │
       └─ 승인된 경우에만
              ▼
         Requirement
              │
              └─ 기존 Framework로 다시 진입
```

Self-Improvement가 직접 할 수 없는 일:

- 자기 제안을 스스로 승인
- repository를 직접 수정
- Human PLAN Approval 우회
- Auto Merge
- Framework 결함을 발견했다는 이유로 연쇄 blocker를 자동 생성하며 자기 자신을 계속 수정

Product Evaluation은 배포된 App을 제품 관점으로 읽고 개선 후보 Issue를 사이클당 하나까지 열 수 있다. 이는 위 경계를 넓히지 않는다. Issue는 proposal일 뿐이고, 평가 대상에서 Framework distribution이 제외되며, 개선 범위가 Framework 소유 경로면 fail-closed로 거부한다. 무엇을 구현할지 정하는 authority는 계속 사람에게 있다.

즉 **Self-Improvement = autonomous self-modification이 아니라 evidence-grounded improvement proposal**이다.

## 3-1. Requirement Ingress: 출처는 provenance, lifecycle은 하나

Requirement Issue는 여러 경로에서 들어올 수 있다.

```text
Human ─────────────────────┐
Product Evaluation ────────┤→ Requirement Issue → Read-only AI PLAN → Human 판단 → PLAN_AUTHORIZE → IMPLEMENT → Trusted Rail → Human Merge
향후 다른 trusted 자동화 ──┘
```

Framework Core에서 중요한 것은 **누가 Issue를 만들었는가가 아니라 그것이 유효한 Requirement인가**다. 따라서 다음 둘을 분리한다.

| 구분 | 역할 | 어디에 남는가 |
| --- | --- | --- |
| `source` / provenance | `HUMAN`, `PRODUCT_EVALUATION`, `OTHER_TRUSTED_SOURCE`와 ingress(`issues` 이벤트 또는 trusted `workflow_dispatch`), 검증 근거 | PLAN identity, PLAN provenance artifact, PLAN 안내 댓글 |
| development lifecycle | PLAN → `PLAN-승인` → PLAN_AUTHORIZE → IMPLEMENT → VERIFY → REVIEW → MERGE_READY → Human Merge | 모든 source에 동일한 workflow와 handler |

원칙:

1. **Ingress에서만 신뢰를 검증한다.** 사람이 만든 Issue는 저장소 구성원(OWNER/MEMBER/COLLABORATOR)이 만든 경우에만 자동 PLAN을 시작한다. Framework가 만든 Issue는 trusted workflow의 dispatch 권한으로만 PLAN에 도달한다. 이 경계가 무제한 외부 Issue에 AI 비용을 쓰는 것을 막는다.
2. **경계를 통과한 뒤에는 출처로 lifecycle을 나누지 않는다.** PLAN 이후 어떤 trusted workflow도 Issue 제목 prefix나 source로 분기하지 않는다.
3. **사람이 직접 쓴 Requirement는 1급 입력이다.** 사람이 업무 요구를 발견해 Issue로 적었다면 그것을 다시 Business Feedback → LEARN → Improvement Candidate → Human Adoption 경로로 돌려 AI가 재제안하게 만들지 않는다. 그 우회는 사람의 판단을 AI 호출로 대체하고 비용만 늘린다.
4. **제목 prefix는 입력 종류 표기다.** `[업무 요구]`는 사람이 쓴 Requirement의 ingress 필터이고, `[Self-Improvement]`는 Product Evaluation 후보의 중복 판단과 기각 기억에 쓰인다. 둘 다 Framework Core의 다른 lifecycle을 뜻하지 않는다.

`issues` 이벤트와 `workflow_dispatch`라는 두 진입 mechanism이 존재하는 이유는 설계가 아니라 플랫폼 제약이다. `GITHUB_TOKEN`으로 만든 Issue는 `issues` 이벤트를 발화시키지 않으므로 Framework가 만든 Issue는 dispatch로만 PLAN을 시작할 수 있다. 두 mechanism은 같은 PLAN job으로 수렴한다.

이 구조는 기술에 종속되지 않는다. Ingress 검증과 PLAN 이후 lifecycle은 언어와 무관하며, 기술 종속은 PLAN Context 선택과 검증 명령에만 남는다.

## 4. AI 비용 경계

AI 호출 비용은 운영 부가 정보가 아니라 Framework가 통제해야 하는 실행 자원이다.

기본 배치는 다음과 같다.

```text
self-improvement-mvp
  → OpenAI Project: framework-dev
  → GitHub Secret: FRAMEWORK_CODEX_API_KEY

dogfood / 실제 App repo
  → App별 OpenAI Project
  → GitHub Secret: APP_CODEX_API_KEY
```

원칙:

- Framework와 App이 동일 API Key를 공유하지 않는다.
- 가능하면 Project-scoped API Key 또는 해당 Project의 service account key를 사용한다.
- 동일 Requirement/Handoff/Context/Prompt/실행정책의 성공 AI call은 artifact 재사용을 우선한다.
- retry/repair는 단계별 bounded budget을 가진다.
- Usage Dashboard의 Project budget은 관측/알림 수단이며 hard execution cap으로 간주하지 않는다.
- Framework 내부 Cost Gate가 호출 횟수·token ledger·중복 호출을 별도로 통제한다.
- 비용 경계 위반 또는 정해진 budget 초과는 fail-open하지 않고 STOP/ON_HOLD 후보가 된다.

## 5. STOP은 실패가 아니라 정상 상태다

다음 조건에서는 자동화를 더 진행하지 않는다.

```text
bounded repair 소진
OR Framework / control-plane 결함 발견
OR blocker가 또 다른 blocker를 요구
OR exact identity / provenance가 불명확
OR 정해진 비용·시간 budget 초과
        ↓
       STOP
        ↓
   Human Review
```

Framework의 품질은 모든 문제를 자동으로 해결하는 능력이 아니라, **언제 자동화를 멈춰야 하는지 정확히 아는 능력**도 포함한다.

## 6. 계층 구조

```text
AI Development Framework
│
├─ Core Runtime
│  ├─ Requirement
│  ├─ PLAN
│  ├─ Human Approval
│  ├─ IMPLEMENT
│  ├─ Trusted Rail
│  └─ Human Merge
│
├─ Trust Infrastructure
│  ├─ exact SHA
│  ├─ provenance
│  ├─ bounded Context / Contract
│  ├─ deterministic validation
│  └─ fail-closed
│
└─ Optional Capabilities
   ├─ bounded FIX
   └─ Self-Improvement
      └─ proposal → Human decision
```

GRAPH와 LOOP는 위 Trust Boundary를 우회하는 별도 authority가 아니다. 실행 순서와 bounded repetition을 표현하는 메커니즘일 뿐이다.

## 7. 우리가 만들지 않는 것

```text
✗ 완전자율 개발 AI
✗ AI의 자기 승인
✗ 무제한 FIX / repair loop
✗ Auto Merge
✗ 무한 Self-Improvement
✗ blocker → blocker → blocker 재귀
✗ 모든 예외를 Framework가 스스로 해결하는 시스템
```

## 8. 한 문장 정의

> **AI Development Framework는 사람이 통제권을 유지하면서, untrusted AI가 수행한 개발 작업을 trusted evidence와 검증 절차를 통해 안전한 software change로 바꾸는 프레임워크다.**

## 9. Canonical 변경 규칙

이 문서는 프로젝트의 **상위 설계 authority**다.

- 세부 workflow나 구현이 이 문서와 충돌하면 이 문서를 우선한다.
- 이 문서의 Trust Boundary를 바꾸려면 명시적인 Human 결정과 별도 PR이 필요하다.
- 새로운 capability는 먼저 이 한 장 안에서 자신의 위치를 설명할 수 있어야 한다.
- 설명할 수 없다면 구현하지 않는다.

기존 v0.2 상세 구현 설명은 [architecture-detail-v0.2.md](architecture-detail-v0.2.md)에 보존한다.
