# 자기 개선 개발 프레임워크 소개

> 이 문서는 2026-10-17 시점의 소개 자료다. 설계 authority는 [`architecture.md`](architecture.md), 실제 사용 흐름은 [`usage.md`](usage.md)이며, 이 문서와 어긋나면 그 문서와 코드를 따른다.

자기 개선 개발 프레임워크(저장소 `erpsarang/self-improvement-mvp`, 정식 이름 AI Development Framework)는 사람이 통제권을 지킨 채 AI의 개발 노동을 안전하게 쓰는 GitHub Actions 기반 프레임워크다. 이 문서는 기본 브랜치 `6f4bfe1`(PR #400, v0.2 라인) 기준이다.

## 1부. 배경, 목표, 의의

### 배경: 세 가지 질문

사람은 2026년 9월 6일부터 약 한 달 동안 이 프레임워크를 만들며 같은 질문으로 계속 돌아왔다.

- AI가 만든 변경을 **어떻게 믿을 것인가**
- 사람의 개입을 **어디까지 줄일 수 있는가**
- 프레임워크를 다듬는 일이 **언제 목적을 잊은 집착이 되는가**

AI 코딩 도구는 코드를 빨리 만들지만, 그 결과가 무엇을 근거로 했고 어디까지 권한이 있었는지는 보여 주지 않는다. 이 프레임워크는 "AI가 만들었다 ≠ trusted"를 출발점으로 삼는다. AI 결과는 항상 **candidate**이고, 정해진 검증 레일을 지나야만 실제 변경이 된다.

### 목표

1. **신뢰성 있는 품질을 유지하면서 사람의 개입을 최소화한** 앱 개발 프레임워크를 만든다.
2. 최종 지향점은 이름 그대로 Self-Improvement다. 프레임워크가 개발 중인 App의 **사용자 관점에서 다음 과제를 스스로 찾고**, 검증된 개발 사이클로 실현하고, 그 결과에서 다시 배운다.
3. **개입은 줄이고 authority는 유지한다.** 개입 지점 하나를 없애려면 그 자리의 판단을 대신할 증거와 검증이 먼저 있어야 한다.

가치가 충돌할 때의 순서는 헌장 제2장이 정한다. 위의 것을 아래의 것과 맞바꾸지 않는다.

| 순위 | 가치 | 뜻 |
| --- | --- | --- |
| 1 | 증명 가능한 안전 | exact SHA, provenance, fail-closed, bounded 반복, Human-only Merge |
| 2 | App 사용자의 실질적 가치 | 변경은 App을 쓰는 사람에게 주는 것으로 정당화한다 |
| 3 | 사람 개입의 최소화 | 새 판단이 없는 클릭은 없앤다 |
| 4 | 지속 가능성(비용·시간) | 같은 입력의 성공 AI 호출을 다시 부르지 않고, 모든 반복에 budget을 둔다 |
| 5 | 내부 정합성과 우아함 | 가장 낮다. 실용성 밖의 정합성에 매몰되지 않는다 |

### 의의

- **완전 자율이 아니라 증명 가능한 자동화다.** 목표는 "AI가 더 많이 자동화한다"가 아니라, AI가 더 많은 일을 해도 근거와 권한 범위를 증명할 수 있는 개발 시스템이다.
- **사람의 일이 판단만 남는다.** 사람은 요구를 쓰고, PLAN을 승인하고, 최종 Merge하고, 개선 후보를 채택하거나 기각한다. 구현, 검증, 리뷰, 수정, PR 생성은 프레임워크가 한다.
- **STOP이 정상 상태다.** 반복이 소진되거나 identity가 불명확하면 자동화가 멈추고 사람에게 넘긴다. 언제 멈출지 아는 것이 품질의 일부다.
- **비개발자도 요구를 넣을 수 있다.** 요구는 "무엇이 불편하고 어떻게 바뀌면 좋은가"로 쓴다. 파일명이나 구현 방법은 몰라도 된다.
- **실제 App에서 증명했다.** Dogfood App `sales-order-exception-analyzer`, 두 번째 App `meeting-action-items`, Python App `transportation_guide`(Issue #2, #7, #11 Merge)에서 요구 → PLAN → 승인 → 구현 → 검증 → Human Merge → LEARN이 끝까지 돌았다. 헌장 채택 시점(10-02)까지 Framework 878커밋·204 PR, App 650커밋·179 PR이 쌓였다.

**만들지 않는 것:** 완전자율 개발 AI, AI의 자기 승인, 무제한 FIX 루프, Auto Merge, 무한 Self-Improvement, blocker가 blocker를 부르는 재귀.

## 한눈에 보기

```text
[사람] 요구 Issue 작성 ([업무 요구])
       │
       ▼
[AI] Read-only AI PLAN
       │
       ▼
[사람] PLAN-승인                ← Trust Boundary #1
       │
       ▼
[Trusted] Handoff (ImplementContract + Context Pack)
       │
       ▼
[AI] bounded IMPLEMENT Worker → deterministic CI
       │
       ▼
[Trusted Rail] SEAL → PUBLISH → VERIFY → REVIEW
       │        ▲                          │ LOCAL_FIX
       │        └──── bounded FIX ◄────────┘ (최대 2회, 수정본은 SEAL부터 다시)
       │
       ├── STRUCTURAL_CHANGE / FIX 2회 소진 → STOP → 사람 판단
       │
       ▼ PASS
[Trusted] MERGE_READY PR (PR 생성 권한만)
       │
       ▼
[사람] Human Merge              ← Trust Boundary #2
       │
       ▼
[AI] LEARN · Product Discovery → 개선 후보 (proposal-only)
       │
       └──── 사람이 고른 후보만 새 요구 Issue로 → 맨 위로
```

사람은 요구를 쓰고, PLAN을 승인하고, Merge한다. 그 사이의 구현·검증·리뷰·수정은 자동으로 돌고, 수정 한도를 넘거나 재설계가 필요하면 STOP으로 사람에게 돌아온다.

## 2부. 작동 방식 A–Z

한 사이클은 GitHub Issue 하나에서 시작해 Human Merge와 LEARN으로 끝난다. 그 사이 모든 전환은 Issue·run·artifact·digest·SHA로 묶이고, 하나라도 어긋나면 멈춘다(fail-closed).

### 2-1. 저장소 세 개의 역할

| 저장소 | 공개 범위 | 담긴 것 | 예 |
| --- | --- | --- | --- |
| Framework | Public | workflow 21개(배포 대상 19개), `src/self-improvement/` trusted handler, 헌장·설계 문서, 배포 소유 목록 | `erpsarang/self-improvement-mvp` |
| App | Public | App 코드와 테스트 + Framework 배포본 사본(바이트 동일) | `erpsarang/transportation_guide` |
| executor | Private, 팀 소유 | AI 단계별 poller workflow와 bridge script, self-hosted runner의 팀 전용 Claude 구독 | `subscription-ai-executor` 복제본 |

App의 workflow는 AI를 직접 부르지 않는다. 요청을 Issue 댓글(marker)로 남기고 executor에 dispatch하면, executor가 Claude를 한 번 호출해 결과를 다시 댓글로 게시한다. App의 trusted 단계가 그 결과를 검증한다.

### 2-2. 누가 무엇을 하는가

| 주체 | 하는 일 | 하지 않는 일 |
| --- | --- | --- |
| 사람 | 요구 작성, `PLAN-승인`, 최종 Merge, 개선 후보 채택·기각(사유 기록), STOP 뒤 판단, 헌장·architecture 개정 | 새 판단 없는 클릭 반복 |
| read-only AI (Planner, Learner, Product Evaluator) | bounded Context를 읽고 제안 | 저장소 수정, 자기 제안 승인 |
| untrusted Worker (IMPLEMENT, FIX) | 승인된 scope 안에서 candidate 생성 | write credential 보유, scope 밖 변경, 직접 publish |
| Semantic AI Reviewer | exact SHA를 읽고 판단 제안 | 판단 확정(trusted finalize가 함), push, merge |
| Trusted control-plane | 결정적 검증, provenance 기록, routing | AI 판단, 사람 authority 대체 |

### 2-3. 한 사이클을 단계별로

**A. 요구 접수 (Requirement Ingress)**

- 사람이 제목 `[업무 요구]`로 Issue를 열면 `plan.yml`(Read-only AI PLAN)이 `issues.opened`로 시작한다. 저장소 구성원(OWNER/MEMBER/COLLABORATOR)이 연 Issue만 자동 시작하므로 외부인의 Issue에 AI 비용이 나가지 않는다.
- Product Discovery가 만든 `[Self-Improvement]` Issue는 trusted `workflow_dispatch`로 같은 PLAN job에 들어간다. 출처는 provenance의 `source`(HUMAN, PRODUCT\_EVALUATION)로만 남고, 이후 lifecycle은 출처와 무관하게 같다.
- 동시에 `requirement-lint.yml`이 AI 없이 본문을 점검해 조언 댓글 하나를 남긴다. R1 LEARN 증거 크기(8,192바이트), R2 PLAN 모델, R3 예상 변경 파일 8개 한도, R4 경로 표기를 본다. PLAN을 막지는 않는다.

**B. Read-only AI PLAN**

- trusted 단계가 Issue 본문의 requirement digest와 기본 브랜치 target SHA를 얼린다. 그 SHA에서 Context Pack(최대 12개 파일, 80KB)을 고른다. `package.json`·`tsconfig.json`은 항상, 본문에 backtick으로 적은 경로는 우선, `src/` 아래 비테스트 파일을 먼저 고른다.
- executor가 Claude를 1회 호출한다. 모델은 기본 sonnet이고, 사람이 `- [x] 복잡한 요구입니다`를 체크한 요구만 opus다. executor 변수 `EXECUTOR_PLAN_READ_TOOLS=on`이면 격리된 checkout에서 `Read`·`Glob`·`Grep`으로 Pack 밖 파일을 최대 8개까지 더 읽고 `additionalEvidence`로 밝힌다.
- PLAN 출력은 구현 접근, `allowedPaths`(최대 8개), `requiredChanges`, `forbiddenChanges`, 검증 명령(`npm test`, `npm run build`만 허용), `ready` 여부다.
- trusted 검증이 근거 ID, 경로 범위, 문장 속 경로 표기를 대조한다. 변경 대상 소스를 import하는 기존 테스트와 `package-lock.json`은 `allowedPaths`에 결정적으로 더해 "trusted 보강 테스트"로 표시한다.
- 통과하면 PLAN.md와 Decision Packet이 Issue 댓글로 달린다. `ready=false`이거나 blocking question이 남으면 구현으로 넘어가지 않는다.

**C. PLAN의 재시작·재시도·복구 (모두 bounded)**

- 본문 편집: 제목이나 본문을 고치면 `edited_gate`가 PLAN을 다시 시작한다. 마지막으로 PLAN한 본문과 digest가 같으면 시작하지 않고, 서로 다른 본문은 Issue당 4개까지다.
- 자동 재시도: PLAN 실패는 닫힌 코드 9종으로 분류한다. 자동으로 다시 도는 것은 `EXECUTOR_EXECUTION_FAILED`뿐이고, (Issue, digest)당 2회, 같은 코드 연속 2회면 멈춘다. `AUTO_REPLAN=off`로 끌 수 있다.
- 복구: 승인 뒤 기본 브랜치가 움직여 target SHA가 stale이 되면 `plan-recovery.yml`이 승인당 최대 2회 PLAN을 새로 돌린다. 새 PLAN에는 새 `PLAN-승인`이 필요하다.

**D. Human `PLAN-승인` → Trusted PLAN\_AUTHORIZE** (Trust Boundary #1)

- 사람이 PLAN을 읽고 Issue에 정확히 `PLAN-승인`이라고 댓글을 남긴다.
- `plan-authorize.yml`이 Requirement digest, PLAN run/attempt, PLAN artifact, frozen target SHA, 승인 댓글 ID를 다시 검증하고 승인자 계정 유형이 `User`인지 확인한다. 결과는 `plan-authorize.json` Actions artifact로 남는다.
- 본문이나 target SHA가 PLAN 뒤에 바뀌었으면 승인을 거부한다.

**E. Trusted Handoff**

- `plan-implement-handoff.yml`이 승인된 structured scope를 자연어 재해석 없이 `ImplementContract`로 바꾼다.
- exact base SHA에서 수정 대상·참고 파일 원문을 Context Pack으로 고정한다. 원문은 384KB까지 보관하고 Worker prompt에는 96KB까지 싣는다. 넘치는 큰 파일은 `/work` 참조로 바꾼다.

**F. Bounded untrusted IMPLEMENT Worker**

- `plan-implement-worker.yml`이 executor에 IMPLEMENT 요청을 보낸다(sonnet). Worker는 write credential 없이 edit JSON(`changes[]`)만 돌려준다.
- trusted 단계가 `allowedPaths`, base digest, edit anchor를 검사해 clean exact-base checkout에 적용하고 deterministic CI(`npm ci`, `npm test`, `npm run build`)를 돌린다.
- edit 적용이나 CI가 실패하고 수리 대상으로 분류되면, 같은 run에서 repair 요청을 최대 2회 더 보낸다(최초 시도 + repair 2회). 범위·budget 위반 신호가 있으면 수리하지 않고 멈춘다.
- executor 변수 `EXECUTOR_IMPLEMENT_READ_TOOLS=on`이면 Worker도 격리된 base SHA checkout에서 읽기 도구를 쓸 수 있다. 쓰기·실행·네트워크 도구는 막힌다.

**G. Canonical PLAN Bridge**

- `plan-candidate-bridge.yml`이 CI를 통과한 candidate를 PLAN provenance를 보존한 채 Trusted Rail 입력으로 바꾼다.

**H. Trusted Rail** (`trusted-rail.yml`)

1. **SEAL**: candidate를 실행하거나 적용하지 않고 source identity, base SHA, provenance 구조, exact bytes digest를 검증해 `sealed.patch + seal.json`을 만든다.
2. **PUBLISH**: Rail 안에서 이 job만 `contents: write`를 갖는다. sealed patch를 exact base에 적용해 `ai-publish/issue-<N>-cycle-<16hex>` 브랜치에 force 없이 올린다. `main`에는 push하지 않는다.
3. **VERIFY**: 세 job으로 나뉜다. `verify_prepare`(trusted)가 exact SHA를 정하고, `verify_candidate`(별도 runner, secret·credential 없음)가 그 SHA만 checkout해 test·build를 돌리고, `verify_finalize`(새 trusted runner)가 재검증해 `verify.json`을 만든다.
4. **Semantic REVIEW**: `review_prepare → review_agent → review_finalize` 세 runner다. Reviewer(opus)는 verified SHA를 credential 없이 읽고 정적 검토만 한다. 저장소의 README·주석은 검토 데이터일 뿐 지시가 아니다. finalize가 decision과 finding의 일관성을 검사한 뒤에야 `review.json`이 나온다.

| REVIEW decision | 조건 | 다음 상태 |
| --- | --- | --- |
| `PASS` | BLOCKER 0개 | `MERGE_READY` |
| `LOCAL_FIX` | BLOCKER가 모두 LOCAL | `FIXING` (최대 2회) |
| `STRUCTURAL_CHANGE` | STRUCTURAL BLOCKER 1개 이상 | `STOPPED` |

**I. Embedded Orchestrator와 bounded FIX**

- `orchestrator.yml`은 같은 Rail run 안에서 `review.json`을 다시 검증하고 decision을 결정적으로 routing한다. 새 AI 판단은 하지 않는다.
- `LOCAL_FIX`면 `fix-request.yml` → `fix-worker.yml`이 승인된 `allowedPaths` 원문과 LOCAL BLOCKER만 executor(sonnet)에 1회 보내 수정 candidate를 받는다. 수정본은 SEAL부터 Rail 전체를 다시 지난다.
- FIX는 두 번까지다. 세 번째 `LOCAL_FIX`는 실행하지 않고 `STOPPED`가 된다.

**J. MERGE\_READY PR**

- `PASS`일 때만 `merge_boundary` job이 PR을 만든다. 권한은 `pull-requests: write`와 `contents: read`뿐이라 merge·push가 구조적으로 불가능하다.
- 생성 직전 `reviewedHeadSha == remote branch HEAD == PR head SHA`를 강제한다.
- Framework 전용 GitHub App(Merge-Ready App) secret이 있으면 그 identity로 PR을 만들어 PR CI가 사람 승인 없이 돈다. 없으면 `github-actions[bot]`으로 fallback하고 사람이 CI 실행을 한 번 승인해야 한다.

**K. Human Merge** (Trust Boundary #2)

- 사람이 PR HEAD가 reviewed SHA와 같은지, 변경 파일이 승인 범위 안인지, CI·provenance가 정상인지 확인하고 직접 Merge한다. Auto Merge는 없다.

**L. Merge 이후: LEARN과 Improvement Candidate**

1. `post-merge-learn.yml`이 `ai-publish/` PR의 실제 Merge를 감지한다. open PR이나 MERGE\_READY는 완료로 보지 않는다.
2. `learn-source.yml`이 Requirement identity, reviewed SHA, merge commit, Rail run, final REVIEW, test 실행 증거를 Completed Cycle Record로 고정하고 bounded LEARN Input Pack을 만든다.
3. `learn.yml`의 read-only Learner(sonnet)가 그 Pack만 읽는다. 결과는 evidence ID에 근거해야 하고 trusted finalize를 통과해야 한다.
4. `improvement-candidate.yml`이 가설을 `proposal-only / pending-human` 후보로 투영한다. 자동 ranking·Issue 생성·구현은 없고, 사람이 고른 후보만 새 Requirement가 된다.

**M. Product Discovery (제품 관점 평가)**

- `product-evaluation.yml`은 사람이 실행하거나, `AUTO_PRODUCT_DISCOVERY=on`인 저장소에서 네 조건(마지막 Discovery 뒤 Human Merge 3건, 열린 후보 없음, 24시간 경과, 실행 중 run 없음)이 모두 맞을 때 돈다.
- 기본 브랜치의 제품 source 전체와 README, 최근 이력(완료 요구 16개, 기각 후보와 사유, 최근 변경 경로)을 131,072B Snapshot으로 만든다. Framework 파일은 빠진다.
- Evaluator(opus, 1회, 재시도 없음)가 서로 다른 영역의 후보 3개를 비교해 1위 또는 NONE을 낸다. 중복이 아니면 `[Self-Improvement]` Issue 1개가 생기고 PLAN이 정확히 한 번 자동 제안된다.
- 사람이 사유를 남기고 `not_planned`로 닫은 후보는 다음 평가의 금지 목록이 된다.

### 2-4. 상태 머신

정의된 전환만 허용되고 나머지는 모두 오류다. candidate는 SEAL을, REVIEW는 exact SHA VERIFY를 건너뛸 수 없고, 자동 merge 이벤트는 없다.

```text
CANDIDATE   --AUTHORIZE-->               AUTHORIZED
AUTHORIZED  --START_IMPLEMENT-->         IMPLEMENTING
IMPLEMENTING --SEAL-->                   SEALED
SEALED      --RECORD_PUBLISHED-->        PUBLISHED
PUBLISHED   --VERIFY exact SHA-->        VERIFIED
VERIFIED    --START_REVIEW-->            REVIEWING
REVIEWING   --PASS-->                    MERGE_READY
REVIEWING   --LOCAL_FIX (fixCount < 2)-->  FIXING --SEAL--> SEALED
REVIEWING   --LOCAL_FIX (fixCount >= 2)--> STOPPED
REVIEWING   --STRUCTURAL_CHANGE-->       STOPPED
MERGE_READY --RECORD_HUMAN_MERGE-->      MERGED   (사람이 한 Merge를 기록만 함)
```

### 2-5. 신뢰 경계와 provenance 불변식

- **권한 분리**: workflow 전체에는 write 권한을 주지 않는다. `contents: write`는 PUBLISH job 하나에만, `pull-requests: write`는 PR boundary job 하나에만 있다. VERIFY·REVIEW는 read-only다.
- **runner 분리**: candidate 코드를 실행하는 runner에는 trusted handler, secret, credential이 없다. `postinstall`이나 test script가 그 runner를 오염시켜도 trusted prepare/finalize runner에는 닿지 못한다.
- **exact SHA 사슬**: 아래 값이 모두 같아야 다음 단계로 간다.

```text
remote publish branch HEAD == publish.json.publishedHeadSha
  == verify.json.verifiedHeadSha == review.json.reviewedHeadSha == Human Merge PR head SHA

review.json.requirementsDigest == authorize.json.requirements.digest
```

- **trust anchor**: 현재는 GitHub Actions artifact다. Issue 댓글이나 현재 브랜치 텍스트는 다음 상태를 정하는 신뢰 입력이 아니다. artifact retention을 넘는 장기 감사는 아직 보장하지 않는다.
- **프레임워크 내부 AI는 저장소 문서를 지시로 읽지 않는다.** 헌장은 그들에게 prompt·schema·trusted finalize 규칙으로 녹아 들어간다.

### 2-6. AI 실행과 비용 경계

모든 AI 호출은 App을 개발하는 팀이 소유한 Private executor를 거친다. Framework와 App, App과 App은 executor나 구독 계정을 공유하지 않는다. executor는 allowlist(`EXECUTOR_ALLOWED_REPOSITORIES`)에 없는 저장소의 요청을 Claude 호출 전에 거부한다.

| 단계 | 모델 | 호출 | 도구 |
| --- | --- | --- | --- |
| PLAN | sonnet (복잡한 요구 체크 시 opus) | 요청당 1회 | 기본 없음, 스위치 on이면 격리된 읽기 도구 |
| IMPLEMENT | sonnet | 최초 1회 + repair 최대 2회 | 기본 없음, 스위치 on이면 격리된 읽기 도구 |
| REVIEW | opus | Rail당 1회 | 없음 |
| FIX | sonnet | FIX당 1회, 최대 2번 | 없음 |
| LEARN | sonnet | Merge당 1회 | 없음 |
| Product Discovery | opus | 실행당 1회, 재시도 없음 | 없음 |

- effort는 medium이다. 같은 입력의 성공 호출은 artifact를 재사용하고, 모든 재시도·수리에는 단계별 budget이 있다. budget 초과는 fail-open하지 않고 STOP이다.
- App run은 executor 결과를 약 15분(PLAN은 약 10분) 기다린다. executor가 `{KIND}_FAILED` marker를 남기면 기다리지 않고 바로 멈추고 Issue에 `HumanStatus: STOPPED`(PLAN은 `PLAN_FAILED`) 댓글을 남긴다.

### 2-7. 프레임워크와 App의 경계

- **소유 경로는 한 곳에서 선언한다.** `policy/framework-distribution-ownership.v1.json`에 85개 entry(workflow 19개, `src/self-improvement/` handler, `.framework-runtime/` 의존성 등)가 있고, 배포본은 바이트 단위로 대조한다.
- App 저장소의 `FRAMEWORK.md`가 배포본의 source SHA를 적는다. App에서는 이 경로를 직접 고치지 않는다.
- App 도메인 지식은 프레임워크에 들어가지 않는다. Framework는 실행 시점에 App의 README와 source를 읽는다.
- App에서 드러난 Framework 결함은 Framework 저장소에서 고치고, 그 SHA로 App에 동기화한다. App에만 남은 Framework 수정은 경계 위반이다. 예: `transportation_guide`는 "Framework를 2c9e04c로 동기화한다" 커밋으로 #396의 수정을 받았다.

### 2-8. 사람 개입 지점과 STOP

| 종류 | 지점 |
| --- | --- |
| 판단이 있는 개입 | `PLAN-승인`(Trust Boundary #1), 최종 Merge(#2), 개선 후보 채택·기각, STOP·STRUCTURAL\_CHANGE 뒤 판단 |
| 시작 trigger | 요구 Issue 작성, Product Discovery 실행(opt-in 자동 시작 가능) |
| 운영 수작업 (줄일 대상) | Merge-Ready App 미설정 시 bot PR CI 승인, 멈춘 Worker 복구 dispatch, Framework → App 동기화 commit, AI 사용량 수집 |

다음 중 하나라도 만나면 자동화는 멈추고 사람에게 넘긴다. bounded repair 소진, Framework·control-plane 결함 발견, blocker가 또 blocker를 요구, exact identity·provenance 불명확, 비용·시간 budget 초과.

### 2-9. 거버넌스: 언제 어느 경로를 쓰는가

- **사람이 무엇을 바꿀지 이미 정했다면 Human-directed maintenance**다. 문서 현행화, 작은 유지보수, App에서 관측된 Framework blocker 복구는 AI 세션과 직접 branch·PR을 만든다. 범위 확인, CI, Human-only Merge는 유지한다.
- **App이 무엇을 개선할지 스스로 발견했다면 Self-Improvement**다. LEARN·Product Discovery 후보 → 사람 선택 → PLAN 사이클이다.
- 프레임워크 변경은 "관측된 실패", "목적을 향한 전진", "경계 유지" 중 하나로 한 문장 안에 설명돼야 한다. 완료 조건은 테스트 통과가 아니라 실제 App에서 한 사이클이 그 변경을 지나 끝까지 도는 것이다.
- Trust Boundary 변경은 `docs/architecture.md`가 authority다. 명시적인 사람의 결정과 별도 PR이 필요하다. 헌장은 이것을 느슨하게 하는 근거가 되지 않는다.

### 2-10. 알려진 한계

- GitHub + Node 실행 환경 전제다. 다른 언어는 `npm test`·`npm run build`가 그 언어를 부르는 방식으로만 쓸 수 있다(예: Python 표준 라이브러리만 쓰는 `transportation_guide`).
- 승인자는 계정 유형 `User`만 확인한다. 저장소 구성원 여부·policy 대조는 없으므로, 공개 저장소에서는 외부인의 `PLAN-승인`도 MERGE\_READY PR까지 일으킬 수 있다. 최종 Merge는 여전히 사람만 한다.
- App 저장소는 개인 계정 소유여야 한다. Organization 소유 App은 아직 지원하지 않는다.
- 범용 GRAPH 엔진, GitHub 외 adapter, Node 외 verifier adapter, 장기 provenance 저장소, 운영 UI는 v0.3 이후 후보다.

## 3부. 새 App 개발 절차 가이드

새 App은 빈 저장소에 Framework 배포본을 붙이고, 팀 전용 executor를 연결한 뒤, `[업무 요구]` Issue 하나로 첫 사이클을 돌리면 시작된다. 이 절차는 `meeting-action-items`(Framework 수정 0건으로 bootstrap)와 `transportation_guide`(Python App)가 실제로 지나간 길이다.

### 0단계. 이 App에 맞는지 확인

코드가 강제하는 조건:

- 루트 `package.json`에 `test`와 `build` script가 있다. 승인된 PLAN의 검증 명령은 `npm test`와 `npm run build`뿐이다.
- 루트 `package.json`과 `tsconfig.json`은 PLAN Context가 항상 읽는다.
- 런타임 코드는 `src/`, 테스트는 `test/` 또는 `*.test.*`·`*.spec.*`에 둔다.
- App 저장소는 **개인 계정**이 소유한다(Organization 소유는 아직 미지원).

검증된 환경(강제는 아님): Node 22 + TypeScript, 외부 API 호출과 App 자체 secret 없음. 다른 언어는 `npm test`·`npm run build`가 그 언어를 부르게 하되, VERIFY runner에 패키지 설치 단계가 없으므로 표준 라이브러리만 쓴다.

### 1단계. App 저장소와 골격 만들기

1. 개인 계정에 Public 저장소를 만든다.
2. **README를 제품 설명서로 쓴다.** PLAN과 Product Discovery는 README에서 App의 목적을 읽는다. 사용자, 입력, 결과, 단계별 범위, 기술 제약(예: "외부 패키지 금지", "외부 서비스는 한 모듈에 가둬 테스트에서 가짜로 바꾼다"), 폴더 구성, 검증 명령을 적는다.
3. `src/`와 `test/`에 최소 코드와 테스트 하나를 넣고, 루트 `package.json`의 `test`·`build`가 로컬에서 통과하는지 확인한다.

### 2단계. Framework 배포본 붙이기

1. Framework 기본 브랜치의 최신 commit SHA를 정한다.
2. 그 SHA의 `policy/framework-distribution-ownership.v1.json`에 적힌 모든 entry를 `sourcePath → targetPath`로 복사한다(현재 85개). Framework의 `package.json`·`package-lock.json`은 App 루트가 아니라 `.framework-runtime/`으로 간다.
3. 복사본을 원본과 **바이트 단위로 대조**해 어긋남이 없는지 확인한다.
4. 배포 목록 밖이라 따로 만들어야 하는 세 파일을 추가한다.
   - `.github/ISSUE_TEMPLATE/user-requirement.md`: Framework의 템플릿을 가져온다. opus 승격에 쓰는 "복잡한 요구" 체크박스가 여기에만 있다.
   - `.github/workflows/ci.yml`: App 소유. `pull_request`에서 `npm ci`, `npm test`, `npm run build`, `git diff --check`를 돌린다. secret을 참조하지 않는다.
   - `FRAMEWORK.md`: 배포본 표식. Framework 소유 경로(`.github/`, `src/self-improvement/`, `policy/`, `.framework-runtime/`)를 직접 고치지 않는다는 문장과 source repository, line(`v0.2`), source SHA를 적는다. Framework 저장소에 원본이 없으므로 다른 App의 사본을 참고한다.
5. 루트 `package.json`의 `devDependencies`에 Framework handler 실행용 `@types/node`, `tsx`, `typescript`를 두고 `package-lock.json`을 커밋한다(`transportation_guide` 구성). App 코드와는 무관하다고 README에 적어 둔다.
6. 이 bootstrap은 Human-directed maintenance다. branch·PR로 올리고 CI를 확인한 뒤 사람이 Merge한다.

### 3단계. 팀 전용 executor 준비

1. `subscription-ai-executor`를 팀 계정에 **Private**으로 복제한다. 다른 App이나 Framework의 executor를 공유하지 않는다.
2. executor variable `EXECUTOR_ALLOWED_REPOSITORIES`에 App 저장소(`owner/repo`)를 적는다. 없으면 모든 poller가 Claude 호출 전에 멈춘다.
3. executor secret `FRAMEWORK_BRIDGE_TOKEN`: App 저장소에 대한 Issues(Read and write)·Actions(Read) fine-grained token. 결과 댓글은 이 계정으로 남고, App은 **저장소 소유자 계정의 댓글만** 받는다. 그래서 App 소유 개인 계정의 token이어야 한다.
4. executor에 self-hosted runner를 등록하고, runner에서 **팀 전용 Claude 계정**으로 `claude`에 로그인한다. 개인 계정으로 로그인하면 그 사람의 사용 한도를 함께 쓴다.
5. (선택) `EXECUTOR_PLAN_READ_TOOLS=on`, `EXECUTOR_IMPLEMENT_READ_TOOLS=on`으로 격리된 읽기 도구를 켠다. App이 커져 Context Pack에 필요한 파일이 다 들어가지 않을 때 효과가 크다.

### 4단계. App 저장소 설정

| 종류 | 이름 | 필수 | 값과 용도 |
| --- | --- | --- | --- |
| variable | `AI_EXECUTOR_REPOSITORY` | 필수 | executor 저장소 `owner/repo`. 없으면 AI 단계가 dispatch 전에 멈춘다 |
| secret | `EXECUTOR_DISPATCH_TOKEN` | 필수 | executor 저장소 Actions(Read and write) fine-grained token |
| secret | `MERGE_READY_APP_ID`, `MERGE_READY_APP_PRIVATE_KEY` | 권장 | Merge-Ready GitHub App(Pull requests RW, Contents R, Webhook 끔). 없으면 bot PR의 CI를 사람이 한 번 승인해야 한다 |
| secret | `TRUSTED_PUBLISH_TOKEN` | 조건부 | candidate가 workflow 파일을 바꿀 때만 PUBLISH가 쓴다 |
| variable | `AUTO_PRODUCT_DISCOVERY` | 선택 | `on`이면 상한 조건이 맞을 때 Product Discovery 자동 시작 |
| variable | `AUTO_REPLAN` | 선택 | `off`면 PLAN 자동 재시도를 끈다(기본 켜짐) |

secret 값은 저장소나 문서에 적지 않는다.

### 5단계. 첫 요구 쓰기

Issue 템플릿 "업무 요구 → AI PLAN"으로 Issue를 연다. 제목은 ` [업무 요구]  `로 시작한다.

```markdown
## 어떤 업무가 불편한가요?
처음 가는 곳을 찾아갈 때 어떤 수단이 가장 빠른지 매번 따로 찾아야 한다.

## 어떻게 바뀌면 좋겠나요?
목적지 주소를 넣으면 도보·자전거·자동차 결과가 빠른 순서로 나온다.

## 잘 되었다고 판단할 수 있는 예 (선택)
- 가장 빠른 수단이 맨 위에 온다.
- 자동 테스트가 통과한다.

## 지켜야 할 사항 (선택)
- 외부 서비스를 테스트에서 실제로 호출하지 않는다.

## 복잡한 요구인가요? (선택)
- [ ] 복잡한 요구입니다
```

잘 쓰는 요령:

- **사용자 관점으로 쓴다.** "어떤 사용자가 어떤 상황에서 무엇이 나아지는가"로 시작한다. 구현 방법은 적지 않아도 된다.
- **한 Issue는 한 변경.** PLAN이 바꿀 수 있는 파일은 최대 8개이고, 자동으로 더해지는 기존 테스트와 lock 파일도 이 안에 든다. 크면 나눈다.
- 고칠 파일을 안다면 `` `src/web-main.ts` ``처럼 backtick 경로로 적는다. Context에 우선 들어간다.
- 손대지 않을 파일은 "`` `src/old.ts` `` 정리는 이 Issue 밖입니다"처럼 범위 밖이라고 적는다.
- 본문은 짧게 쓴다. 한글은 글자당 3바이트이고, 제목·본문·digest를 합한 JSON이 8,192바이트를 넘으면 Merge 뒤 LEARN이 실패한다.
- "복잡한 요구"는 구조 변경이나 여러 부분에 걸친 설계 판단이 필요할 때만 체크한다(opus PLAN).

### 6단계. Lint 댓글과 PLAN 읽기

1. Issue를 열면 Requirement Lint 조언 댓글이 달린다. R1 오류나 R3·R4 경고가 있으면 본문을 고친다. 고치면 PLAN이 새 본문로 자동 재시작된다(본문 4개까지).
2. PLAN 댓글(PLAN.md, Decision Packet)이 달린다. App run은 executor 결과를 약 10분까지 기다린다. 다음을 확인한다.
   - 구현 접근이 요구와 맞는가
   - `allowedPaths`와 "trusted 보강 테스트"가 필요한 범위인가, 없어야 할 파일이 없는가
   - `requiredChanges`·`forbiddenChanges`가 완료 조건·금지사항을 담았는가
   - `ready=true`인가, blocking question이 남아 있지 않은가
3. 마음에 들지 않으면 승인하지 않고 본문을 고친다. 진행하지 않을 요구는 사유를 남기고 닫는다.

### 7단계. `PLAN-승인`

Issue에 다른 문자 없이 `PLAN-승인`만 댓글로 남긴다. 이 댓글이 구현 authority의 유일한 입구다. 승인 뒤 본문을 고치면 그 승인은 무효가 되고 새 PLAN에 다시 승인해야 한다.

### 8단계. 자동 진행 지켜보기

Handoff → IMPLEMENT → CI → Bridge → SEAL → PUBLISH → VERIFY → REVIEW → (FIX) → MERGE\_READY PR까지 사람 손 없이 돈다. 상태는 Issue의 `HumanStatus` 댓글과 App 저장소 Actions에서 본다. executor runner는 이 동안 켜져 있어야 한다.

| 보이는 것 | 뜻 | 할 일 |
| --- | --- | --- |
| `HumanStatus: PLAN_FAILED` (경로·범위 사유) | PLAN이 trusted 검증에서 거부됨 | 사유를 읽고 본문을 고친다. 범위가 크면 Issue를 나눈다 |
| `PLAN 자동 재시도 (n/2)` | executor 실행 실패를 프레임워크가 다시 시도 중 | 기다린다 |
| `HumanStatus: STOPPED` (timeout) | executor runner가 job을 제때 집지 못함 | executor Actions에 queued poller가 있는지 보고 runner를 살린 뒤 그 단계를 다시 시작한다 |
| `HumanStatus: STOPPED` (`{KIND}_FAILED`) | executor가 요청 검증·호출·게시에 실패 | executor poller run 로그에서 원인을 찾는다 |
| REVIEW `STRUCTURAL_CHANGE` 또는 FIX 2회 소진 | 범위를 넘는 재설계가 필요하거나 수리 한도 소진 | 요구를 다시 설계하거나 나눠 새 Issue로 연다 |
| `PLAN 자동 시작 상한` | 서로 다른 본문 4개를 넘김 | Actions → Read-only AI PLAN을 Issue 번호로 직접 실행한다 |

### 9단계. MERGE\_READY PR 확인과 Merge

- [ ] PR HEAD가 PR 본문의 reviewed exact SHA와 같다
- [ ] 변경 파일이 승인한 `allowedPaths` 안에 있다
- [ ] PR CI와 provenance가 정상이다
- [ ] 예상하지 못한 운영·보안 영향이 없다
- [ ] 사람이 직접 Merge한다 (Auto Merge 금지)

### 10단계. Merge 뒤 LEARN 확인

Merge하면 Completed Cycle Record → LEARN → Improvement Candidate가 자동으로 돈다. 결과는 닫힌 요구 Issue의 댓글과 artifact에 남는다. 후보는 제안일 뿐이다. 가치 있는 후보는 사람이 새 `[업무 요구]` Issue로 옮긴다.

### 11단계. Product Discovery로 다음 과제 찾기

1. Merge가 몇 건 쌓이면 Actions → `Trusted Product Evaluation`을 실행한다. 사람 손을 더 줄이려면 `AUTO_PRODUCT_DISCOVERY=on`을 켠다.
2. 결과는 `[Product Discovery] 실행 기록` Issue에 쌓인다. 1위가 있으면 `[Self-Improvement]` Issue가 생기고 PLAN이 한 번 자동 제안된다.
3. 진행할 후보는 `PLAN-승인`, 진행하지 않을 후보는 **사유 댓글을 남기고 `not_planned`로 닫는다.** 그 사유가 다음 평가의 제품 방침이 된다. 열린 후보가 있는 동안에는 새 후보가 쌓이지 않는다.

### 12단계. Framework 업데이트 동기화

- App에서 Framework 결함을 만나면 App에서 고치지 않는다. Framework 저장소에 Issue를 열고 관측된 run·SHA를 적는다.
- Framework가 고쳐지면 그 SHA의 배포본을 다시 복사·바이트 대조하고 `FRAMEWORK.md`의 source SHA를 갱신하는 동기화 PR을 만든다. 커밋 메시지에 달라진 파일과 원인 Issue를 적는다.
- 동기화 뒤에는 실패했던 요구를 다시 돌려, 그 변경이 App에서 한 사이클을 끝까지 통과하는지 확인한다.

### 첫 사이클 체크리스트

- [ ] 개인 계정 소유 App 저장소, README, `src/`·`test/`, `npm test`·`npm run build` 통과
- [ ] 배포본 복사·바이트 대조, Issue 템플릿·`ci.yml`·`FRAMEWORK.md` 추가
- [ ] Private executor, allowlist, `FRAMEWORK_BRIDGE_TOKEN`, runner + 팀 전용 Claude 로그인
- [ ] App의 `AI_EXECUTOR_REPOSITORY`, `EXECUTOR_DISPATCH_TOKEN` (+ Merge-Ready App secret)
- [ ] 첫 `[업무 요구]` Issue → Lint → PLAN → `PLAN-승인`
- [ ] MERGE\_READY PR 확인 후 Human Merge → LEARN 댓글 확인

## 출처

모두 `erpsarang/self-improvement-mvp` 기본 브랜치 `6f4bfe1` 시점에 확인했다.

- [CHARTER.md](../CHARTER.md) — 목적, 가치 우선순위, 사람 개입 지점
- [README.md](../README.md) — v0.2 검증 상태와 dogfood 증거
- [docs/architecture.md](architecture.md) — Trust Boundary 설계 authority
- [docs/trust-model.md](trust-model.md) — trusted/untrusted 실행 경계, VERIFY·REVIEW·Orchestrator
- [docs/state-machine.md](state-machine.md) — 상태와 허용 전환
- [docs/usage.md](usage.md) — 사용 흐름, executor 준비, App 요건
- [docs/roadmap.md](roadmap.md) — 증명한 능력과 v0.3 후보
- [policy/framework-distribution-ownership.v1.json](../policy/framework-distribution-ownership.v1.json) — 배포 소유 목록(85 entry)
- [erpsarang/transportation\_guide](https://github.com/erpsarang/transportation_guide) — 최근 bootstrap 사례(`FRAMEWORK.md`, `ci.yml`, 동기화 커밋)
