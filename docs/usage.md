# AI Development Framework v0.2 사용 가이드

이 문서는 **업무 요구사항을 AI Development Framework v0.2에 넣어 실제 개발 사이클을 시작하고, Human Merge 이후 LEARN / IMPROVE까지 연결하는 방법**을 설명합니다.

## 1. 사람이 처음 작성하는 것은 구현 지시가 아니라 Requirement

사용자는 파일명이나 함수 구현 방법을 세세하게 지정할 필요가 없습니다. 무엇이 필요한지와 완료 조건을 명확히 적습니다.

사람이 직접 작성한 `[업무 요구]` Issue는 그 자체로 유효한 Requirement입니다. 저장소 구성원이 만들면 Read-only AI PLAN이 자동으로 시작되며, LEARN이나 Improvement Candidate를 먼저 거칠 필요가 없습니다. Product Evaluation이 만든 `[Self-Improvement]` Issue도 같은 PLAN으로 들어갑니다. Issue의 출처는 PLAN provenance에 `source`로 기록될 뿐, 이후 승인·구현·검증·Merge 절차는 출처와 무관하게 동일합니다 (`docs/architecture.md` 3-1).

예:

```markdown
## 목표
예외 주문의 주요 원인을 한눈에 파악하고 싶다.

## 완료 조건
- 예외 사유별 건수를 확인할 수 있다.
- 가장 많이 발생한 사유를 확인할 수 있다.
- 기존 주문 판정 결과는 바뀌지 않는다.
- 자동 테스트가 통과한다.

## 금지사항
- 무관한 기능 변경 금지
- main 직접 push 금지
```

## 1-1. 요구 본문 점검 (조언)

`[업무 요구]` Issue를 저장소 구성원(OWNER/MEMBER/COLLABORATOR)이 열거나 고치면 `Requirement Lint` workflow가 본문을 점검하고 Issue에 **조언 댓글 한 개**를 남기거나 갱신합니다. 결정적 규칙만 쓰고 AI를 호출하지 않으며, PLAN 시작·검증·승인에는 영향이 없습니다. workflow가 실패해도 PLAN은 그대로 진행됩니다.

| 규칙 | 수준 | 점검 | 이유 |
| --- | --- | --- | --- |
| R1 | 오류 / 경고 | LEARN 증거 크기가 8,192바이트를 넘으면 오류, 90% 이상이면 경고 | Human Merge 뒤 LEARN이 `maxItemBytes`로 실패합니다 |
| R2 | 정보 | 이 본문으로 PLAN이 쓸 모델(sonnet/opus) | 복잡한 요구 체크 한 줄이 모델을 정합니다 |
| R3 | 경고 | ‘예상 변경 범위’ 목록이 8개를 넘음, 또는 `package.json`이 있고 `package-lock.json`이 없는데 이미 8개 | PLAN 허용 파일은 최대 8개이고 lock은 자동으로 더해집니다 |
| R4 | 경고 | 본문의 경로 모양 문자열이 ‘예상 변경 범위’에 없음, 여러 허용 경로의 끝부분과 맞는 모호한 이름, 주소(URL) | PLAN이 이를 되풀이하면 범위 밖이거나 어느 파일인지 정할 수 없어 거부될 수 있습니다 |

- **R1의 크기는 본문 길이가 아닙니다.** LEARN은 `{"title", "body", "digest"}`를 JSON으로 만든 값의 UTF-8 바이트를 잽니다. 제목, 키 이름, digest, 줄바꿈과 따옴표의 이스케이프가 더해지고 한글은 글자당 3바이트이므로, 본문이 8,192바이트보다 짧아도 넘을 수 있습니다.
- R3·R4는 휴리스틱입니다. ‘예상 변경 범위’ 절은 제목에 "변경 범위"가 들어간 절이고, 파일 개수는 그 절의 목록 항목(`-`, `*`, `1.`)에 백틱으로 적은 파일 표기를 모두 셉니다. 문장 속에 나열한 파일은 세지 않고, 코드 블록 안의 줄은 제목으로 보지 않습니다. 절이 없거나 읽을 수 있는 파일 목록이 없으면 정보로만 표시합니다. PLAN 경로 검증은 본문이 아니라 PLAN(AI)이 쓴 문장에 걸리므로, R4는 거부를 없애지 못하고 가능성을 줄일 뿐입니다.
- 댓글에는 본문 문장을 되풀이하지 않고 규칙 ID, 숫자, 경로(코드 표기)만 씁니다.
- 본문을 고치면 댓글이 갱신되고, 본문이나 제목이 바뀌었으면 PLAN도 새 본문으로 다시 시작됩니다(5절 "본문을 고치면 PLAN이 다시 시작"). executor가 `EXECUTION_FAILED`를 알린 실패는 본문을 고치지 않아도 PLAN이 스스로 한 번 다시 시작합니다(5절 "PLAN 실패 뒤 자동 재시도").
- 이미 닫힌 Issue도 Actions → Requirement Lint를 Issue 번호로 직접 실행해 점검할 수 있습니다. `post_comment`를 끄면 Issue에 댓글을 남기지 않고 Actions 요약에만 결과를 보여 줍니다.

## 2. AI 실행 경계 준비 (팀별 Claude 구독 executor)

AI 호출 비용은 그 App을 개발하는 팀의 Claude 구독이 낸다. 팀마다 Private executor repository(`subscription-ai-executor` 복제)와 self-hosted runner를 두고, runner에는 팀 전용 Claude 계정으로 로그인한다. App repository는 자기 executor로만 요청을 보낸다.

```text
App repo (Public)                        executor repo (Private, 팀 소유)
  variable AI_EXECUTOR_REPOSITORY   →      variable EXECUTOR_ALLOWED_REPOSITORIES = <App repo>
  secret   EXECUTOR_DISPATCH_TOKEN         secret   FRAMEWORK_BRIDGE_TOKEN
                                           self-hosted runner + claude 로그인(팀 전용 계정)
```

운영 절차:

1. executor repository를 팀 계정에 private으로 복제한다.
2. executor repository variable `EXECUTOR_ALLOWED_REPOSITORIES`에 처리할 App repository(`owner/repo`, 쉼표 구분)를 적는다. 없으면 모든 poller가 Claude 호출 전에 멈춘다.
3. executor repository secret `FRAMEWORK_BRIDGE_TOKEN`에 App repository의 Issues(Read and write), Actions(Read) fine-grained token을 등록한다. 결과 댓글은 이 token의 계정으로 남는다.
4. executor repository에 self-hosted runner를 등록하고, runner에서 팀 전용 Claude 계정으로 `claude`에 로그인한다. 개인 계정으로 로그인하면 그 사람의 사용 한도를 함께 쓴다.
5. App repository variable `AI_EXECUTOR_REPOSITORY`에 executor repository(`owner/repo`)를 적는다. 없거나 형식이 틀리면 AI 단계가 dispatch 전에 멈춘다.
6. App repository secret `EXECUTOR_DISPATCH_TOKEN`에 executor repository의 Actions(Read and write) fine-grained token을 등록한다.

주의:

- 결과 댓글과 실패 댓글은 App repository 소유자 계정이 남긴 것만 받는다(`author_association` OWNER, login = repository owner). 그래서 지금은 `FRAMEWORK_BRIDGE_TOKEN` 계정이 App repository를 소유한 개인 계정이어야 하고, Organization 소유 App repository는 아직 지원하지 않는다.
- secret 값은 repository나 문서에 기록하지 않는다.
- self-hosted runner는 AI 단계가 돌 수 있는 동안 켜져 있어야 한다. App run은 executor 결과를 약 15분(PLAN은 약 10분)만 기다리고, 그 뒤에 runner가 job을 집으면 executor는 끝난 run의 요청을 stale로 거부한다. IMPLEMENT·REVIEW·FIX·LEARN·Product Discovery가 이렇게 timeout되면 요청 Issue에 `HumanStatus: STOPPED` 댓글이 남고, PLAN은 `HumanStatus: PLAN_FAILED` 댓글이 남는다. 이 댓글은 필요하면 요구 본문을 고치라고 안내한다. PLAN은 Issue를 새로 만들거나 다시 열 때, 제목·본문을 고칠 때(5절, Issue당 서로 다른 본문 4개까지), 수동 실행, 그리고 프레임워크의 bounded 자동 재시도(5절)에 시작한다. 변경할 파일이 PLAN 한도(8개)를 넘어 실패한 경우에는 사유 원문 아래에 쉬운 설명을 한 줄 덧붙이고, PLAN이 고른 변경 파일 수와 자동으로 더해지는 기존 테스트 수, 한도를 함께 보여 준다. 사유 원문은 이 개수를 목록보다 앞에 둔다(댓글이 사유를 300자로 자르기 때문이다). executor repository의 Actions에 poller run이 queued로 남아 있으면 runner가 offline인 것이다. runner를 되살린 뒤 그 단계를 다시 시작한다.
- executor가 요청을 찾은 뒤 실패하면(request 검증 실패, Claude 호출이나 결과 형식 검증 실패, 결과 댓글 게시 실패) IMPLEMENT·REVIEW·FIX·LEARN·Product Discovery poller는 요청 Issue에 `{KIND}_FAILED` marker 댓글을 남긴다. App run은 이 댓글을 보면 timeout까지 기다리지 않고 바로 멈추고, 실제 사유와 함께 `HumanStatus: STOPPED` 댓글을 남긴다. 이 marker는 실패 신호일 뿐 결과가 아니어서 다음 단계를 시작하지 않는다. PLAN도 executor의 PLAN poller가 `PLAN_FAILED` marker를 남기면 같은 방식으로 바로 멈춘다. 이때는 `HumanStatus: PLAN_FAILED` 댓글이 executor가 알린 사유(`REQUEST_REJECTED`·`EXECUTION_FAILED`·`RESULT_POST_FAILED`)를 쉬운 말로 풀어 주고, 원인은 executor 저장소 Actions의 poller run 로그에서 찾으라고 안내한다. PLAN poller가 이 marker를 남기도록 갱신되지 않은 executor이거나 poller가 marker를 남기기 전에 멈춘 경우(runner offline 등)에는 marker가 없으므로 기존처럼 timeout까지 기다린다.

## 2-1. Merge-Ready PR 생성 identity (Framework 전용 GitHub App)

GitHub는 `github-actions[bot]`이 만든 PR의 workflow를 write 권한 사용자가 승인해야만 실행한다(2026-06 정책). 그대로 두면 Trusted Rail이 이미 exact SHA에서 검증한 후보의 MERGE_READY PR에서 사람이 "CI 실행 승인" 버튼을 한 번 더 눌러야 하는데, 이는 새로운 판단이 없는 Human Click이다. Framework는 이를 없애기 위해 MERGE_READY PR **생성만** 전담하는 최소 권한 GitHub App identity를 쓴다.

```text
Human PLAN-승인
→ IMPLEMENT / SEAL / PUBLISH / VERIFY / REVIEW (Trusted Rail, 변경 없음)
→ Human Merge PR 생성: Framework Merge-Ready App (`<app-slug>[bot]`)
→ PR CI 자동 실행 (사람 Approve 없음)
→ Human 최종 Merge
```

App 권한과 설치:

- Repository permissions: **Pull requests: Read and write**, **Contents: Read-only**, Metadata: Read-only(자동). 나머지는 No access. merge(contents write)와 push는 구조적으로 불가능하다.
- Webhook 비활성. 설치 대상은 Framework를 쓰는 저장소만 선택한다.
- 각 저장소 secret: `MERGE_READY_APP_ID`(App 설정 화면의 App ID), `MERGE_READY_APP_PRIVATE_KEY`(App private key PEM 전체).

동작:

- `orchestrator.yml`의 PR boundary job이 `actions/create-github-app-token`으로 **현재 repository로만 scope된 1시간짜리 설치 토큰**을 발급받아 `pulls.create`에만 쓰고, job 종료 시 revoke 한다. 발급 시 `pull requests: write`, `contents: read`로 다시 축소한다.
- Trusted Rail은 이 두 secret만 Orchestrator에 명시적으로 넘긴다(`secrets: inherit` 없음). `EXECUTOR_DISPATCH_TOKEN`과 `TRUSTED_PUBLISH_TOKEN`은 Orchestrator에 보이지 않으며 그 역할도 바뀌지 않는다.
- secret이 없으면 GITHUB_TOKEN(`github-actions[bot]`)으로 fallback 하여 이전과 같이 동작한다. secret이 있는데 무효하면 토큰 발급 step이 실패하고 Trusted Rail run이 멈춘다. 조용히 넘어가지 않는다.
- PR 작성자가 App bot도 `github-actions[bot]`도 아니면(사람이 직접 만든 PR 등) MERGE_READY로 승격하지 않고 fail-closed 한다.

Provenance:

- PR 본문에 `PR 생성 identity` 줄이 들어가고, Orchestration provenance의 `mergeBoundary.createdBy`에 `{ identity: GITHUB_APP | GITHUB_TOKEN, login, appSlug }`가 기록된다. identity는 사용한 토큰이 아니라 GitHub가 기록한 실제 작성자 login으로 결정한다.
- AI가 만든 PR은 항상 bot identity로 남고, 사람의 행위는 `PLAN-승인` 댓글과 최종 Merge에만 나타난다.

지켜지는 경계:

- `pull_request` 트리거로 PR이 열릴 때 실행되는 workflow는 secret을 참조하지 않는다(테스트로 고정). 그래서 후보 코드가 자동으로 CI에서 실행되어도 Trusted Rail VERIFY가 이미 감수하는 범위를 넘지 않는다.
- Auto Merge는 없고 최종 Merge는 Human-only다.

## 2-2. App이 지켜야 할 것

Framework는 아래 모양의 App에서 검증됐다. 두 번째 App(`meeting-action-items`, Framework `5f24516`)이 빈 저장소에서 bootstrap한 뒤 첫 요구를 Merge와 LEARN까지 통과시켰다(self-improvement-mvp#223).

코드가 요구하는 것:

- 루트 `package.json`에 `test`와 `build` script가 있다. 승인된 PLAN의 검증 명령으로는 `npm test`와 `npm run build`만 허용된다(`planner.ts`, `plan-implement-handoff.ts`의 `TRUSTED_VALIDATION_COMMANDS`).
- 루트 `package.json`과 `tsconfig.json`은 PLAN Context가 항상 읽는 bootstrap 파일이다(`PROJECT_BOOTSTRAP_PATHS`).
- 런타임 코드는 `src/`, 테스트는 `test/` 또는 `*.test.*`·`*.spec.*`에 둔다. PLAN Context는 `src/` 아래 비테스트 파일을 가장 먼저 고른다(`fileRolePriority`).
- App repository를 개인 계정이 소유한다(위 2장 주의).

검증한 것이지 코드가 강제하지는 않는 것:

- Node + TypeScript, Node 22 (`ci.yml`의 `node-version`).
- 외부 API 호출과 App 자체 secret이 없다.

배포 목록(`policy/framework-distribution-ownership.v1.json`) 밖이라 bootstrap할 때 직접 가져와야 하는 것:

- `.github/ISSUE_TEMPLATE/user-requirement.md`: PLAN의 opus 승격에 쓰는 "복잡한 요구" 체크박스가 여기에만 있다.
- `.github/workflows/ci.yml`: App 소유 파일이다. 위 경계를 지키는 검증(`npm ci`, `npm test`, `npm run build`)이 들어 있다.
- `FRAMEWORK.md`: Framework repository에 원본이 없다. 다른 App의 사본을 가져와 source SHA를 확인한다.

## 3. v0.2 기본 흐름

```text
User Requirement
→ read-only AI PLAN
→ Human PLAN-승인
→ Trusted PLAN_AUTHORIZE
→ Trusted ImplementContract + exact-SHA Context Pack
→ bounded untrusted IMPLEMENT Worker
→ deterministic CI
→ canonical PLAN Bridge
→ Trusted Rail
   → SEAL → PUBLISH → VERIFY → Semantic REVIEW
   → 필요 시 bounded FIX
→ MERGE_READY
→ Human Merge
→ Completed Cycle Record
→ bounded LEARN Input Pack
→ read-only AI LEARN
→ proposal-only Improvement Candidate
→ Human 판단
```

같은 Human Merge 경계에서 배포된 App을 제품 관점으로도 한 번 평가합니다.

```text
Human Merge
→ bounded Product Snapshot
→ read-only AI Product Evaluation
→ 사이클당 최대 1개의 Improvement Candidate Issue
→ Human 판단
```

중요한 Human Boundary는 세 곳입니다.

1. **PLAN 승인** — AI가 제안한 exact PLAN을 사람이 승인
2. **최종 Merge** — 검증·리뷰된 exact 결과를 사람이 Merge
3. **개선 후보 선택** — LEARN과 Product Evaluation이 만든 후보 중 다음 cycle로 보낼 항목을 사람이 선택

## 4. read-only AI PLAN

Requirement가 준비되면 Planner가 repository의 bounded Context를 읽고 PLAN을 만듭니다.

Planner는 다음을 제안합니다.

- 구현 접근
- 변경할 exact path 후보
- `requiredChanges`
- `forbiddenChanges`
- 검증 명령
- 구현 준비 여부 `implementationScope.ready`

Planner는 repository를 수정하지 않으며 PLAN 자체도 authority가 아닙니다.

PLAN은 Private subscription executor가 1회 실행하며 모델은 기본 sonnet(effort medium)입니다. 사람이 Issue 템플릿의 `- [x] 복잡한 요구입니다`를 체크한 요구만 opus로 실행합니다. 체크 여부는 본문에 있으므로 requirement digest와 PLAN_REQUEST marker의 `model=`에 그대로 남습니다. Product Discovery 후보처럼 사람이 쓰지 않은 본문은 체크박스가 있어도 opus로 올리지 않습니다. 체크를 바꾸면 본문이 바뀐 것이므로 PLAN이 다시 시작됩니다(아래).

`ready=false`이거나 blocking question이 남아 있으면 IMPLEMENT로 넘어가지 않습니다.

### 본문을 고치면 PLAN이 다시 시작

`[업무 요구]` Issue의 제목이나 본문을 저장소 구성원이 고치면 `plan.yml`이 `issues.edited`로 시작하고, `edited_gate` job이 읽기 권한만으로 다음을 판정합니다(`src/self-improvement/plan-edited.ts`). 사람이 Actions에서 다시 실행할 필요가 없습니다.

- 현재 본문의 requirement digest가 **마지막으로 PLAN한 본문**(trusted bot의 `PLAN_REQUEST` marker)과 같으면 시작하지 않습니다. 되돌린 편집이고 기존 PLAN이 그대로 유효합니다.
- 한 Issue에서 자동으로 PLAN하는 **서로 다른 본문은 4개까지**입니다. 넘으면 `PLAN 자동 시작 상한` 댓글이 한 번 달리고, 그 뒤에는 Actions → Read-only AI PLAN을 직접 실행합니다. 이미 PLAN했던 본문으로 돌아가는 것은 상한을 소모하지 않습니다.
- 같은 Issue의 PLAN run은 concurrency group으로 하나씩 돕니다. 진행 중인 run은 취소하지 않고(executor에 보낸 호출을 버리지 않기 위해), 대기 중인 run은 최신 편집 하나만 남으므로 연속 편집은 마지막 본문으로 한 번만 더 PLAN됩니다.
- 승인 경로는 바뀌지 않습니다. 본문이 바뀌면 이전 PLAN의 `PLAN-승인`은 requirement digest 불일치로 거부되고, 새 PLAN에 새 `PLAN-승인`이 필요합니다.

### PLAN 실패 뒤 자동 재시도

PLAN이 게시되지 못하면 `HumanStatus: PLAN_FAILED` 댓글 뒤에 같은 run의 `auto_retry` job이 실패 사유를 닫힌 코드로 분류합니다(`src/self-improvement/plan-retry.ts`). 코드는 `EXECUTOR_EXECUTION_FAILED`, `EXECUTOR_REQUEST_REJECTED`, `EXECUTOR_RESULT_POST_FAILED`, `PLAN_PATH_NOTATION_REJECTED`, `PLAN_SCOPE_TOO_LARGE`, `PLAN_VALIDATION_REJECTED`, `PLAN_RESULT_TIMEOUT`, `PLAN_REQUEST_FAILED`, `UNKNOWN`이고, 사유 원문은 코드로만 남기며 어떤 AI prompt에도 넣지 않습니다.

- 자동으로 다시 시작하는 것은 `EXECUTOR_EXECUTION_FAILED`뿐입니다. 관측상 사람이 본문을 바꾸지 않고 같은 요구로 다시 실행해 성공한 실패가 이것뿐이기 때문입니다(App transportation_guide #2 run 38981512927, #7 run 38992157914). 나머지 코드는 멈추고 사람의 판단을 기다립니다. 특히 PLAN 문장 속 경로 표기 거부는 같은 입력으로 다시 실행해도 같은 모양으로 실패했고 trusted 검증을 고친 뒤에야 통과했으므로(#395, #396) 재시도하지 않습니다.
- 상한은 (Issue, requirement digest)당 2회이고, 같은 사유 코드로 두 번 실패하면 예산이 남아도 멈춥니다. 본문을 고치면 digest가 바뀌어 예산을 새로 셉니다. 횟수는 `github-actions[bot]`이 남긴 `AUTO_PLAN_RETRY` marker 댓글에서만 읽습니다.
- 재시도는 `plan.yml`을 Issue 번호 하나만 입력으로 dispatch합니다. 새 run이 본문과 target SHA를 다시 얼리므로 이전 PLAN·승인·provenance는 아무것도 재사용하지 않고, 새 PLAN에는 Human `PLAN-승인`이 다시 필요합니다.
- 재시도마다 Issue에 `PLAN 자동 재시도 (n/2)` 댓글(사유 코드, 원 run)이, 멈출 때는 `PLAN 자동 재시도 중지` 댓글이 남습니다. 저장소 변수 `AUTO_REPLAN`을 정확히 `off`로 두면 분류만 하고 dispatch하지 않습니다. 변수가 없으면 켜져 있습니다.

### PLAN 문장 속 경로 표기

PLAN이 `approach`·`changeCandidates`·`testStrategy`·`requiredChanges` 문장에 쓴 파일 경로는 trusted 검증이 `allowedPaths`와 `contextPaths`에 대조합니다(`planner.ts`의 `validateReadyPlanPathConsistency`). 경로 모양 문자열 하나라도 범위 안으로 읽히지 않으면 PLAN 전체가 `PLAN_FAILED`로 거부됩니다.

- 글자가 같은 경로는 범위 안입니다.
- 폴더 앞부분을 뗀 끝부분도, **폴더 경계 기준으로 정확히 하나의 허용·참고 경로의 끝부분**이면 그 경로를 가리킨 것으로 보고 받아 줍니다. 허용 경로가 `src/app/static/index.html`이면 `static/index.html`과 `index.html`은 범위 안입니다(`planPathSuffixMatches`).
- 두 파일을 슬래시로 이어 쓴 줄임 표기(`test_a.py/test_b.py`)는 폴더가 아니라 별개 파일로 풀어 각각 위 기준으로 대조합니다. 경로 전체가 먼저 범위 안인지 보므로 점이 있는 실제 폴더(`src/api.v2/spec.json`)는 영향이 없고, 하나라도 범위 밖이면 거부합니다(`checkPlanPathBounds`).
- 끝부분이 둘 이상의 경로와 맞으면 어느 파일인지 정할 수 없어 거부합니다. 어느 경로의 끝부분도 아니거나(`other/index.html`) 폴더 경계가 아닌 부분 문자열(`tatic/app.js`)이면 범위 밖으로 거부합니다.
- 이것은 문장을 거부할지 정하는 기준일 뿐입니다. 쓰기 범위는 계속 `allowedPaths`에 글자 그대로 적힌 경로뿐이며, 짧은 이름이 범위를 넓히지 않습니다.
- 요구 본문에서 경로 표기를 점검하는 R4(1-1장)도 같은 기준을 씁니다.

### PLAN이 보는 Context

Planner는 trusted 단계가 고른 Context Pack(최대 12개 파일, 80KB)에서 시작합니다. 기본은 도구 없이 이 Pack만 봅니다.

executor 저장소 변수 `EXECUTOR_PLAN_READ_TOOLS=on`이면 Planner는 격리된 PLAN target SHA checkout 안에서 읽기 도구(`Read`, `Glob`, `Grep`)로 Pack 밖 파일도 찾아 읽습니다(`docs/architecture.md` 4장 "PLAN의 격리된 읽기 도구").
- Pack 밖에서 근거로 삼은 파일은 최대 8개까지 `additionalEvidence`(X1~X8)로 밝힙니다.
- trusted 검증이 그 파일을 target SHA에서 다시 읽어 경로와 digest를 고정합니다. 이 파일은 `analysis` 근거와 기존 파일 `allowedPaths`에 쓸 수 있습니다.
- 고정된 파일은 PLAN.md와 Decision Packet에 "AI가 Context Pack 밖에서 근거로 삼은 파일"로 표시됩니다.
- 파일이 없거나, 일반 UTF-8 파일이 아니거나, 8개를 넘으면 PLAN 검증이 실패합니다.
- executor가 결과에 `tools=read` 표시를 붙이지 않은 PLAN(도구 없이 실행된 PLAN)이 Pack 밖 근거를 밝혀도 검증이 실패합니다.

변수가 켜져 있어도 Issue 본문을 이렇게 쓰면 Planner가 필요한 파일을 더 빨리 찾습니다. 변수가 꺼져 있으면 필요한 파일이 Context에 들어갈 가능성이 높아집니다.

- 고칠 파일이나 근거 파일은 `` `src/web-main.ts` ``처럼 backtick 경로로 적습니다. 이 경로가 우선 들어갑니다.
- 손대지 않을 파일은 "`` `src/old.ts` `` 정리는 이 Issue 밖입니다"처럼 범위 밖이라고 적습니다. "이 Issue 밖", "범위 밖", "별도 Issue로 다룬다", "out of scope"가 있는 문장이나 그런 제목 아래 목록에만 나오는 경로는 우선 경로가 되지 않고 단어 점수도 올리지 않습니다. "바꾸지 않는다" 같은 금지 문장은 범위 밖 표시가 아닙니다.

Context의 App source에는 그 source를 import하는 직접 테스트가 함께 들어갑니다. 둘을 같이 넣을 자리가 없으면 그 source를 뺍니다. 그 뒤 남은 예산으로 source와 테스트를 함께 다시 넣습니다. 이때 둘을 줄여서 넣을 수 있지만, 줄인 파일이 4,000B보다 작아지면 넣지 않습니다.

### 변경 대상 소스를 import하는 기존 테스트

Planner가 Context Pack에서 기존 테스트를 봤더라도 "수정이 필요할 때만 포함" 판단을 틀리면, Worker는 scope 밖 테스트를 고칠 수 없어 deterministic CI가 fail-closed 됩니다. 그래서 trusted validation 단계가 변경 대상 App 소스를 import하는 Context Pack 안의 기존 테스트를 `allowedPaths`에 결정적으로 추가합니다. `package-lock.json` companion과 같은 원칙입니다.

보강된 테스트는 PLAN.md의 "trusted 보강 테스트" 줄에 표시되므로 사람은 최종 scope를 보고 승인합니다. 8개 bounded slot이 모자라면 조용히 넘기지 않고 PLAN 검증이 실패합니다.

## 5. Human `PLAN-승인`

PLAN을 확인한 뒤 승인하려면 Requirement Issue에 정확히 다음 댓글을 남깁니다.

```text
PLAN-승인
```

Trusted `PLAN_AUTHORIZE`는 댓글 문자열만 믿지 않고 다음 identity를 다시 검증합니다.

- Requirement Issue / digest
- PLAN run / attempt
- PLAN artifact / provenance
- frozen target SHA
- approval comment ID

승인자에 대해서는 계정 유형이 `User`인지만 확인하고, approver의 immutable GitHub user ID를 provenance에 **기록**합니다. 저장소 policy나 `author_association`과 대조하지는 않습니다(`docs/trust-model.md` "Trusted execution"). 공개 저장소에서는 저장소 구성원이 아닌 계정의 `PLAN-승인`도 IMPLEMENT·REVIEW 호출과 MERGE_READY PR 생성까지 일으킬 수 있습니다. 최종 Merge는 여전히 사람만 할 수 있습니다.

Requirement나 target SHA가 PLAN 이후 바뀌었다면 silent substitution하지 않고 fail-closed합니다. 이 경우 새 PLAN이 필요합니다.

## 6. Trusted Handoff와 bounded IMPLEMENT

승인된 PLAN의 structured scope는 Trusted control-plane에서 그대로 `ImplementContract`로 변환됩니다. 자연어를 다시 자의적으로 해석하지 않습니다.

exact base SHA에서 `allowedPaths`에 필요한 최소 Context만 `Context Pack`으로 고정합니다.

Context Pack은 수정 대상과 참고 파일의 원문을 384KB까지 보관합니다. 결과 검증은 이 원문으로 합니다. Worker prompt에는 원문을 96KB까지만 싣고, 넘치면 큰 파일부터 경로·크기·digest만 남긴 `/work` 참조로 바꿉니다. 이런 request는 prompt 첫 줄에 `IMPLEMENT_READ_TOOLS required` 표시가 붙습니다. executor의 격리 읽기 도구(`docs/architecture.md` 4장)가 꺼져 있으면 executor가 Claude 호출 전에 거부하고, Issue에는 STOPPED가 남습니다.

IMPLEMENT Worker는 다음 제한을 가집니다.

- untrusted
- repository write credential 없음
- bounded Context만 사용
- 허용 path와 byte/file budget 안에서 candidate 생성
- 결과는 candidate artifact일 뿐

Worker가 만든 candidate는 clean exact-base checkout에서 deterministic validation을 통과해야 canonical PLAN Bridge가 됩니다.

## 7. Trusted Rail

canonical PLAN Bridge가 만들어지면 Trusted Rail이 시작됩니다.

```text
SEAL
→ PUBLISH
→ VERIFY exact published SHA
→ Semantic REVIEW
```

### SEAL

candidate bytes와 provenance를 검증하고 봉인합니다.

### PUBLISH

봉인된 candidate만 publish branch에 게시합니다. Worker가 직접 push하지 않습니다.

### VERIFY

branch 이름이 아니라 exact `publishedHeadSha`를 checkout하여 기계 검증합니다.

### Semantic REVIEW

승인된 Requirement와 exact verified SHA를 함께 검토합니다.

| Decision | 의미 | 다음 행동 |
| --- | --- | --- |
| `PASS` | 요구사항 충족 | `MERGE_READY` → Human Merge PR |
| `LOCAL_FIX` | 제한된 수정으로 해결 가능 | bounded FIX loop |
| `STRUCTURAL_CHANGE` | 범위를 넘는 재설계 필요 | `STOPPED` / Human 판단 |

## 8. LOCAL_FIX

`LOCAL_FIX`라고 해서 사람이 AI에게 자유형 수정 명령을 다시 주는 것이 아닙니다.

```text
REVIEW = LOCAL_FIX
→ Trusted FIX Request
→ bounded Untrusted FIX Worker
→ candidate
→ SEAL → PUBLISH → VERIFY → REVIEW
```

FIX Worker 역시 write credential을 받지 않고 candidate만 만듭니다. 수정 후 전체 Trusted Rail을 다시 통과해야 합니다.

FIX Worker는 승인된 PLAN의 `allowedPaths` 원문(exact reviewed SHA)과 LOCAL BLOCKER만 Private subscription executor(Claude Max, sonnet)에 1회 보내고, 돌아온 edit JSON을 trusted 단계가 검증·적용합니다. 승인된 PLAN scope가 없는 legacy 계보 REVIEW는 AI 호출 전에 멈춥니다.

반복 횟수와 실행 예산은 Framework가 제한하며 한도를 넘으면 사람이 판단하도록 중단합니다.

## 9. PASS와 Human Merge

`PASS`에서만 Framework가 `MERGE_READY` Human Merge PR을 만듭니다.

사람은 최소 다음을 확인합니다.

- PR HEAD가 reviewed exact SHA와 일치하는가
- 변경 파일이 승인된 범위 안인가
- CI / provenance가 정상인가
- 예상하지 못한 운영·보안 영향이 없는가

그 뒤 사람이 직접 Merge합니다.

**Auto Merge는 사용하지 않습니다.**

## 10. Human Merge 이후 LEARN

LEARN은 open PR이나 MERGE_READY를 완료된 사실로 취급하지 않습니다. 실제 Human Merge가 끝난 cycle만 학습 대상으로 사용합니다.

Trusted LEARN Source가 다음을 exact provenance로 고정합니다.

- Requirement identity
- reviewed exact SHA
- merge commit / merged_at
- Trusted Rail run / orchestration artifact
- final REVIEW
- deterministic test execution evidence가 있으면 그 exact chain

그 결과를 bounded `LEARN Input Pack`으로 만든 뒤 read-only AI Learner가 읽습니다.

Learner는 GitHub 최신 상태나 repository 전체를 다시 탐색하지 않습니다.

Learner는 Input Pack 전체를 담은 LEARN_REQUEST 1회로 Private subscription executor(Claude Max, sonnet)가 실행합니다. 요청·결과 댓글은 이미 닫힌 요구사항 Issue에 남고, 결과는 trusted finalize가 evidence grounding을 다시 검증합니다.

## 11. Improvement Candidate와 Human-selected LOOP

LEARN report의 improvement hypothesis는 deterministic하게 `Improvement Candidate Pack`으로 구조화됩니다.

각 candidate는:

- `proposal-only`
- `pending-human`
- evidence-grounded
- 자동 ranking 없음
- 자동 IMPLEMENT 없음

사람이 의미 있는 candidate를 선택한 경우에만 **새 Requirement**로 만들어 다음 PLAN cycle을 시작합니다.

즉 Self-Improvement도 자기 승인 구조가 아닙니다.

이 경로는 AI가 evidence에서 후보를 발견했을 때를 위한 것이지, 사람이 이미 발견한 요구를 위한 관문이 아닙니다. 사람이 업무 요구를 직접 알고 있다면 `[업무 요구]` Issue로 바로 PLAN을 시작하는 것이 올바른 경로이며, 그것을 LEARN을 거치지 않았다는 이유로 막지 않습니다.

## 11-1. Product Discovery와 Improvement Candidate Issue

LEARN은 "개발 cycle이 어떻게 흘렀는가"를 봅니다. Product Discovery는 "배포된 App이 사용자에게 충분한가"를 봅니다.

`Trusted Product Evaluation`은 Merge마다 자동으로 시작하지 않습니다. 사람이 Actions에서 workflow_dispatch로 실행하거나, 저장소 변수 `AUTO_PRODUCT_DISCOVERY=on`을 켠 저장소에서 아래 "자동 시작" 조건이 맞을 때만 돌며, 입력은 없습니다. 실행 시점의 기본 브랜치 SHA를 평가합니다.

Evaluator는 snapshot 전체를 담은 PRODUCT_EVALUATION_REQUEST 1회로 Private subscription executor(Claude Max, opus, effort medium)가 실행합니다. 재시도하지 않습니다. 요청·결과 댓글과 사람이 읽을 판단 요약은 Discovery 전용 Issue `[Product Discovery] 실행 기록` 하나에 계속 남습니다. 이 Issue는 첫 실행 때 Framework가 만들고, 사람이 닫으면 다음 실행에서 새로 만듭니다. App repository는 자기 executor의 `EXECUTOR_ALLOWED_REPOSITORIES`에 있어야 합니다.

```text
사람이 Trusted Product Evaluation 실행 (또는 opt-in 저장소에서 자동 시작)
→ 실행 시점 기본 브랜치 SHA 확인
→ Product Snapshot 생성 (제품 source 전체 + 최근 이력)
→ isolated read-only AI Product Discovery (후보 3개 비교, 1위 또는 NONE)
→ trusted finalize + 결정적 중복 판단
→ 필요할 때만 [Self-Improvement] Issue 1개 + Discovery Issue에 결과 기록
```

### Product Snapshot에 담기는 것

실행 시점 기본 브랜치의 제품 source 전체(테스트 제외)와 README를 담습니다. 파일별 한도와 파일 수 한도는 없고, 전체 한도 131,072B만 있습니다. README, 화면, 제품 소스 순서로 담고 전체 한도를 넘는 파일은 `omittedPaths`로 남깁니다. 바뀐 파일을 앞에 두지 않습니다.

함께 담는 최근 이력:

- 완료한 요구: `completed`로 닫힌 Issue 최근 16개
- 기각된 후보와 사유: `not_planned`로 닫힌 `[Self-Improvement]` Issue와 사람의 마지막 코멘트
- 최근 변경 경로: 최근 머지된 PR 10개가 바꾼 제품 경로. 이 영역의 후보는 결함이 아니면 순위를 낮춥니다

snapshot에서 항상 제외되는 것:

- `.github/`, `src/self-improvement/`, `policy/`, `.framework-runtime/`, `FRAMEWORK.md` 등 Framework distribution
- 테스트 파일과 lockfile 같은 생성 파일
- symlink, UTF-8이 아닌 파일

따라서 Evaluator는 Framework를 읽을 수 없고, Framework 개선을 제안할 근거 자체를 갖지 못합니다.

### 지켜지는 가드레일

| 가드레일 | 강제 지점 |
| --- | --- |
| 후보 3개를 서로 다른 영역에서 비교하고 고르지 않은 이유를 남김 | 출력 schema와 trusted finalize (영역 중복, 이유 누락, 선택과 제안 불일치는 거부) |
| 한 실행당 Improvement Candidate 최대 1개 | 출력 schema의 `candidates.maxItems: 1`과 trusted finalize |
| 기존 Issue와 중복이면 생성 금지 | trusted control-plane의 결정적 판단 (AI가 판단하지 않음) |
| Framework 자체 개선 후보 금지 | snapshot 선택 제외 + `scopePaths`의 Framework 경로 fail-closed |
| App의 실제 사용자 가치만 | prompt와 snapshot 범위, 근거 경로 enum 제한 |
| 불필요한 AI 호출/재시도 금지 | 사람이 실행할 때만, 실행당 1회, `GITHUB_RUN_ATTEMPT > 1`이면 중단 |
| Auto Merge 금지 / 최종 Merge Human-only | 어떤 job도 merge·push 권한을 갖지 않음. PLAN은 자동 제안되지만 `PLAN-승인`과 Merge는 사람만 함 |
| 사람이 기각한 후보를 다시 제안하지 않음 | `not_planned`로 닫힌 `[Self-Improvement]` Issue와 닫기 코멘트를 snapshot에 담아 Evaluator에게 금지 목록으로 전달 |

중복 판단 규칙은 두 가지입니다. 열린 `[Self-Improvement]` Issue가 하나라도 있으면 사람이 처리할 때까지 새 후보를 쌓지 않습니다. 열림/닫힘과 무관하게 같은 제목이 이미 있으면 만들지 않습니다.

### 자동 시작 (opt-in)

저장소 변수 `AUTO_PRODUCT_DISCOVERY`를 `on`으로 두면(저장소 Settings → Secrets and variables → Actions → Variables), Human Merge 뒤 post-merge 흐름의 끝(`Trusted Improvement Candidate`)에서 Discovery를 자동으로 시작할지 판단합니다. 변수가 없거나 `on`이 아니면 이 판단 job 자체가 건너뛰어지고 아무 비용도 들지 않습니다.

판단은 AI 없이 결정적 함수(`decideAutoDiscovery`)가 하며, 아래를 **모두** 만족할 때만 `Trusted Product Evaluation`을 dispatch합니다.

| 조건 | 막는 것 |
| --- | --- |
| 마지막 Discovery 요청 이후 Human Merge(`ai-publish/` PR)가 3건 이상 | Merge마다 도는 폭주 |
| 열린 `[Self-Improvement]` Issue가 없음 | 사람이 처리하지 않은 후보 위에 쌓이는 것 |
| 마지막 Discovery 시작 후 24시간 경과 | 하루에 여러 번 |
| 대기 중이거나 실행 중인 Discovery run이 없음 | 겹치는 실행 |

상한은 opus 호출이 하루 1회를 넘지 않는 것입니다. 시간 기준(cron) 대신 Merge 뒤에 판단하는 이유는 executor runner가 사람이 작업 중일 때 켜져 있기 때문입니다(꺼져 있으면 요청은 timeout으로 멈춥니다). 판단 근거는 Framework가 만든 Discovery 기록 Issue의 봇 댓글과 `ai-publish/` 브랜치의 병합 PR뿐이며, 사람이 만든 같은 제목의 Issue는 믿지 않습니다. 이 job은 workflow 하나를 dispatch할 뿐이고 후보 Issue, `PLAN-승인`, Merge는 만들지 않습니다. 자동으로 올라온 후보도 사람이 `PLAN-승인`해야 구현이 시작됩니다.

`scopePaths`에는 파일 경로와 폴더 표기(끝에 `/` 하나, 예: `test/`)를 쓸 수 있습니다. 경로 탈출, 절대 경로, 빈 조각(`test//`)과 Framework 경로는 이 표기로도 계속 거부됩니다.

trusted 검증이나 결정 단계가 실패하면(예: Evaluator 출력이 계약을 지키지 못함) 어느 단계가 실패했는지와 로그 링크를 Discovery 전용 Issue에 댓글 하나로 남깁니다. 후보 Issue는 만들지 않고 AI를 다시 부르지 않으며, 다시 시도하려면 사람이 `Trusted Product Evaluation`을 다시 실행합니다.

후보를 거절할 때는 Issue를 `not_planned`로 닫고 사유를 코멘트로 남깁니다. 그 코멘트가 다음 평가의 제품 방침이 됩니다. 사람의 "아니오"가 루프에 기억되므로 같은 방향이 표현만 바뀌어 돌아오지 않습니다.

### 생성된 Issue를 다음 cycle로 보내는 방법

생성된 Issue는 proposal입니다. finalize job이 그 Issue 번호로 Read-only AI PLAN을 정확히 한 번 자동 dispatch하므로, 사람이 Actions에서 PLAN을 시작할 필요가 없습니다. PLAN은 read-only 제안이며 Issue 댓글로 달립니다.

사람의 일은 두 가지뿐입니다. PLAN을 읽고 진행하려면 `PLAN-승인` 댓글을 남기고, 진행하지 않으려면 사유를 남기고 `not_planned`로 닫습니다. 구현은 `PLAN-승인` 이후에만 시작되고 최종 Merge는 Human-only입니다.

비용은 후보 1개당 PLAN 호출 1회입니다. 기각될 후보에도 PLAN이 한 번 돌지만, 기각 후보 기억이 같은 방향의 재제안을 막으므로 기각률은 사이클이 돌수록 낮아집니다.

## 12. v0.2에서 실제 증명한 dogfood

`erpsarang/sales-order-exception-analyzer` Issue #8을 실제 업무 요구로 사용했습니다.

```text
Issue #8
→ PLAN
→ PLAN-승인
→ bounded IMPLEMENT
→ deterministic CI
→ Trusted Rail
→ REVIEW PASS
→ Human Merge PR #24
→ Human Merge
→ LEARN
→ Improvement Candidate
→ Human-selected candidate
→ Framework 개선 Requirement #171
→ 구현 / Human Merge
→ dogfood 재동기화
→ historical exact LEARN replay
```

최신 replay에서는 별도 `test-execution` evidence로 `npm test / PASS / exitCode 0 / signal null`을 검증했습니다.

## 13. 현재 한계

v0.2는 GitHub + Node 기반 실제 프로젝트에서 신뢰 가능한 수직 루프를 검증한 MVP입니다.

아직 일반화할 영역:

- SAP RAP/ABAP 등 다른 검증 체계용 verifier adapter
- 범용 GRAPH DSL / 독립 runtime
- GitHub 외 repository adapter
- durable append-only provenance 저장소
- 운영 UI / observability

이 제한 때문에 검증할 수 없는 프로젝트에서는 자동 범위를 넓히지 말고 Human 경계에서 멈춰야 합니다.
