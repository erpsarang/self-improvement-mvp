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
10. **Framework와 App, 그리고 App과 App은 AI 실행 자격과 사용 한도를 공유하지 않는다.** 분리의 메커니즘(현재는 팀 소유 Private subscription executor)은 바뀔 수 있지만 분리 자체는 원칙이다.

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

Product Discovery(Trusted Product Evaluation)는 사람이 실행하거나, 사람이 저장소 변수로 켠 저장소에서 결정적 상한 조건(Human Merge 3건, 열린 후보 없음, 24시간)이 맞을 때만 배포된 App을 제품 관점으로 읽고 개선 후보 Issue를 실행당 하나까지 열 수 있다. 이는 위 경계를 넓히지 않는다. Issue는 proposal일 뿐이고, 평가 대상에서 Framework distribution이 제외되며, 개선 범위가 Framework 소유 경로면 fail-closed로 거부한다. 무엇을 구현할지 정하는 authority는 계속 사람에게 있다.

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

기본 배치는 다음과 같다. 모든 AI 호출은 Public repository에서 직접 하지 않고, 그 App을 개발하는 팀이 소유한 Private subscription executor(`subscription-ai-executor` 복제본)로 보낸다. executor는 self-hosted runner에서 팀 전용 Claude 구독 계정으로 실행한다.

```text
self-improvement-mvp (Framework)
  → variable AI_EXECUTOR_REPOSITORY = Framework 팀의 executor
  → secret   EXECUTOR_DISPATCH_TOKEN

dogfood / 실제 App repo
  → variable AI_EXECUTOR_REPOSITORY = 그 App 팀의 executor
  → secret   EXECUTOR_DISPATCH_TOKEN

executor repo (Private, 팀 소유)
  → variable EXECUTOR_ALLOWED_REPOSITORIES = 처리할 repository 목록
  → secret   FRAMEWORK_BRIDGE_TOKEN
  → runner에 팀 전용 Claude 계정 로그인
```

원칙:

- Framework와 App, App과 App이 같은 executor나 같은 구독 계정을 공유하지 않는다.
- executor는 allowlist에 없는 repository의 요청을 Claude 호출 전에 거부한다.
- 동일 Requirement/Handoff/Context/Prompt/실행정책의 성공 AI call은 artifact 재사용을 우선한다.
- retry/repair는 단계별 bounded budget을 가진다. AI 호출은 1 turn이며 도구를 쓰지 않는 것이 기본이다. 예외는 IMPLEMENT Worker와 PLAN 둘뿐이고, 각각 아래 "IMPLEMENT Worker의 격리된 읽기 도구"와 "PLAN의 격리된 읽기 도구" 조건을 모두 만족할 때만 허용한다. IMPLEMENT 예외는 executor에 구현되어 있고(`erpsarang/subscription-ai-executor#27`), executor 저장소 변수 `EXECUTOR_IMPLEMENT_READ_TOOLS=on`일 때만 켜진다. 변수가 비어 있으면 IMPLEMENT도 1 turn·도구 없음으로 실행한다(#368). PLAN 예외는 executor(`erpsarang/subscription-ai-executor#29`)와 Framework에 구현되어 있다. executor 저장소 변수 `EXECUTOR_PLAN_READ_TOOLS=on`이고 PLAN request prompt 첫 줄에 Framework의 지원 표시가 있을 때만 켜진다. 그렇지 않으면 PLAN은 1 turn·도구 없음이다(#375).
- 구독 사용 한도는 관측/알림 수단이며 hard execution cap으로 간주하지 않는다.
- Framework 내부 Cost Gate가 호출 횟수·중복 호출을 별도로 통제한다. 요청 모델·effort·실제 모델 ID·토큰은 executor job log와 runner journal에 남는다.
- 비용 경계 위반 또는 정해진 budget 초과는 fail-open하지 않고 STOP/ON_HOLD 후보가 된다.

### IMPLEMENT Worker의 격리된 읽기 도구

도구 없이 1 turn으로 고정된 Context Pack만 보는 IMPLEMENT Worker는 App이 커지면 입력 한도에 걸리고(App #289, 106,198B > 96,000B) 파일을 다시 볼 수 없어 edit anchor를 틀린다. 그래서 IMPLEMENT Worker에 한해 다음 조건을 **모두** 만족할 때 읽기 도구를 허용한다. 하나라도 확인할 수 없으면 executor는 AI 호출 전에 멈춘다(fail-closed).

1. **읽기 도구만 쓴다.** 허용하는 도구는 `Read`, `Glob`, `Grep`뿐이다. 쓰기·실행·네트워크 도구(`Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch` 등)는 계속 막는다.
2. **도구가 닿는 범위는 exact base SHA checkout 하나다.** 격리는 두 겹으로 걸고, 한 겹이 뚫려도 다른 한 겹이 막아야 한다.
   - 실행 환경 격리: 컨테이너나 bubblewrap 같은 OS 수준 격리로 checkout만 보이게 한다. runner의 home 디렉터리, 다른 저장소, 자격 증명 파일은 보이지 않는다. 네트워크는 AI provider 접속만 허용한다.
   - agent 설정 격리: Claude Code의 권한·sandbox 설정으로도 같은 범위만 허용한다.
3. **AI provider 자격 증명은 agent 프로세스의 인증에만 쓰이고, 도구로는 읽을 수 없어야 한다.** Worker 결과는 Public 댓글로 게시되므로, 도구로 읽을 수 있는 것은 모두 공개될 수 있다고 가정한다. 격리 밖 경로와 자격 증명 위치를 읽으려는 시도가 실패한다는 테스트가 구현의 완료 조건이다.
4. **turn 수와 실행 시간에 상한을 둔다.** 상한은 executor가 고정한다. 실제 turn 수·토큰·모델 ID는 executor job log에 남는다. 상한을 넘으면 결과 없이 실패하고, 기존 repair budget 밖의 재시도는 하지 않는다.
5. **AI 호출 수는 늘리지 않는다.** 같은 호출 안에서 turn만 는다.
6. **출력 계약과 Public 검증은 바꾸지 않는다.** Worker는 지금과 같은 edit JSON(`changes[]`)을 낸다. allowedPaths·base digest·anchor 검증, exact-base deterministic CI, Trusted Rail, Human Merge는 그대로다.
7. **REVIEW·FIX·LEARN·Product Discovery는 이 예외에 들어가지 않는다.** 이들은 계속 1 turn·도구 없음이다. PLAN은 아래 "PLAN의 격리된 읽기 도구"의 조건으로 따로 허용한다.

Framework는 이 예외를 이렇게 쓴다.
- Context Pack 원문은 384KB까지 보관한다. Worker prompt에는 96KB까지만 싣고, 넘치는 큰 파일은 `/work` 참조로 바꾼다.
- 이런 request의 prompt 첫 줄에는 표시가 붙는다. executor는 읽기 도구가 꺼져 있으면 이 request를 Claude 호출 전에 거부한다.
- 표시는 권한을 주지 않는다. 출력 검증은 보관한 원문으로 한다.

쓰기·실행 도구(sandbox 안에서 수정하고 테스트를 돌리는 Worker)는 이 조항의 범위가 아니다. 허용하려면 이 문서를 다시 바꾸는 별도 결정이 필요하다.

### PLAN의 격리된 읽기 도구

도구 없이 1 turn으로 trusted 단계가 고른 Context Pack(12개 파일, 80KB)만 보는 PLAN은, 필요한 파일이 Pack에 없으면 `ready=false`가 되거나 범위를 잘못 잡는다. 그러면 사람이 Issue에 경로를 적고 PLAN을 다시 돌려야 한다(App #310 run 37265738573, App #300). Context 선택 규칙을 고쳐 왔지만(#244, #251, #259, #303, #311) "무엇이 필요한지 미리 맞혀야 한다"는 구조는 그대로다. 그래서 PLAN에 다음 조건을 **모두** 만족할 때 읽기 도구를 허용한다. 하나라도 확인할 수 없으면 executor는 AI 호출 전에 멈추고, trusted 검증은 PLAN artifact를 만들지 않는다(fail-closed).

1. **격리 조건은 IMPLEMENT와 같다.** 위 소절의 1~5항(읽기 도구만, 두 겹 격리, 자격 증명을 도구로 읽을 수 없음, turn·시간 상한, AI 호출 수 유지)을 그대로 적용한다. 도구가 닿는 범위는 PLAN target exact SHA checkout 하나다. PLAN 결과도 Public 댓글로 게시되므로, 도구로 읽을 수 있는 것은 모두 공개될 수 있다고 가정한다.
2. **Context Pack은 그대로 준다.** Pack은 "어디부터 보라"는 시작점이고, Pack 안 파일의 근거는 지금처럼 Pack이 발급한 evidence ID로만 댄다.
3. **Pack 밖 근거는 확장 evidence로만, 최대 8개까지 댄다.** PLAN은 도구로 읽고 근거로 삼은 Pack 밖 파일을 저장소 상대 경로로 최대 8개까지 밝힌다. trusted 단계는 그 파일들을 PLAN target exact SHA에서 다시 읽는다. Context Pack 후보와 같은 경로 규칙(`.git` 밖 저장소 안의 일반 UTF-8 파일이고, 경로가 안전한 문자로만 되어 있음)을 지키는지 확인하고, 경로와 digest를 확장 evidence로 고정해 PLAN artifact와 사람에게 보이는 Decision Packet에 남긴다. 하나라도 읽을 수 없거나 규칙에 어긋나거나 8개를 넘으면 PLAN artifact를 만들지 않는다.
4. **근거 검증의 범위는 Pack과 확장 evidence의 합이다.** `analysis`의 근거와 `allowedPaths` 중 이미 있는 파일은 둘 중 하나에 있어야 한다. 근거는 파일 단위다. PLAN이 finding에 path나 원문 quote를 직접 적어 근거로 삼는 방식은 쓰지 않는다.
5. **나머지 PLAN 계약과 승인 경로는 바꾸지 않는다.** `allowedPaths` 상한 8개, `questions`와 `ready`의 규칙, Human `PLAN-승인`, PLAN_AUTHORIZE의 exact artifact 재검증은 그대로다. 확장 evidence는 authority가 아니다. 무엇을 바꿀지 승인하는 것은 계속 사람이다.
6. **켜는 스위치는 IMPLEMENT와 따로 둔다.** executor 저장소 변수로 PLAN 읽기 도구만 따로 켠다. 꺼져 있으면 PLAN은 지금처럼 1 turn·도구 없음이다. 읽기 도구 없이 실행한 PLAN이 확장 evidence를 밝히면 그 결과는 거부한다.

Framework는 이 예외를 이렇게 쓴다.
- PLAN prompt 첫 줄에 지원 표시를 붙이고, PLAN schema에 `additionalEvidence`(X1~X8)를 둔다. 표시는 권한을 주지 않는다.
- executor는 격리 경로로 실행한 결과의 PLAN_RESULT marker에만 `tools=read`를 붙인다. trusted 검증은 이 표시가 있을 때만 Pack 밖 근거를 받는다.
- 확장 evidence는 PLAN artifact의 `plan.additionalEvidence`(경로·byte 수·digest)에 남는다. PLAN artifact wrapper와 PLAN_AUTHORIZE·Handoff 검증은 바뀌지 않는다.

쓰기·실행 도구는 PLAN에도 허용하지 않는다. Pack 밖 근거 파일 수의 상한을 바꾸거나 다른 근거 방식(path·quote 인용 뒤 재검증)으로 바꾸려면 이 문서를 다시 바꾸는 별도 결정이 필요하다.

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

이 문서는 프로젝트의 **상위 설계 authority**다. 목적·가치의 우선순위·과제 선정 기준·고도화의 경계는 [`CHARTER.md`](../CHARTER.md)가 정하며, 헌장은 이 문서의 Trust Boundary를 느슨하게 하는 근거가 되지 않는다.

- 세부 workflow나 구현이 이 문서와 충돌하면 이 문서를 우선한다.
- 이 문서의 Trust Boundary를 바꾸려면 명시적인 Human 결정과 별도 PR이 필요하다.
- 새로운 capability는 먼저 이 한 장 안에서 자신의 위치를 설명할 수 있어야 한다.
- 설명할 수 없다면 구현하지 않는다.

기존 v0.2 상세 구현 설명은 [architecture-detail-v0.2.md](architecture-detail-v0.2.md)에 보존한다.
