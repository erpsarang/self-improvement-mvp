# Trust Boundary

## Untrusted execution

`IMPLEMENT`와 `FIX`는 untrusted 영역이다. 이 영역에는 GitHub write credential을 제공하지 않으며, 산출한 candidate patch를 직접 PUBLISH할 수 없다.

Semantic `REVIEW`의 AI Reviewer도 **untrusted reasoning worker**로 취급한다. Reviewer는 trusted provenance를 직접 만들 수 없고, 구조화된 raw `reviewer.json`만 candidate output으로 남긴다. 현재 GitHub adapter는 `openai/codex-action`을 사용하지만 core의 Reviewer output 계약은 provider-neutral하다.

## Trusted execution

`AUTHORIZE`, `SEAL`, `PUBLISH`, `VERIFY`, REVIEW의 trusted prepare/finalize, 그리고 `Embedded Orchestrator`의 route/record는 trusted control-plane execution이다.

`AUTHORIZE`는 repository에서 version 관리되는 trusted approver policy를 사용하며 live collaborator permission에 의존하지 않는다. Policy는 재사용 가능한 login 대신 immutable GitHub numeric user ID를 권한 identity로 사용하고 login은 설명 메타데이터로만 보존한다. 승인 provenance에는 재조회한 approval, approver ID와 현재 login, exact policy digest, 승인 시각, repository와 trusted workflow run/creation-attempt identity를 보존하고, 신뢰 원본은 Issue comment가 아니라 Actions artifact이다.

Actions artifact는 현재 운영 단계의 trust anchor이며 영구 ledger가 아니다. retention 만료 후 장기 provenance 감사까지 보장하지 않으며, durable/append-only provenance는 후속 Framework 설계 과제이다(TODO).

candidate patch는 trusted `SEAL`을 거쳐야만 PUBLISH 대상으로 간주된다. `SEAL`은 candidate code를 실행하거나 적용하지 않고 source identity, base SHA, provenance 구조와 exact bytes digest를 검증해 `sealed.patch + seal.json`을 만든다.

`PUBLISH`는 같은 Trusted Rail 내부의 별도 job이며 오직 sealed artifact만 입력으로 받는다. workflow 전체나 `SEAL` job에는 write 권한을 주지 않고 `PUBLISH` job에만 `contents: write`를 부여한다. PUBLISH는 exact `baseSha`의 별도 worktree에 sealed patch를 적용하고 `ai-publish/issue-<N>` branch에만 force 없이 publish한다. `main`에는 직접 push하지 않으며 실제 remote branch SHA를 다시 조회해 exact match한 값을 `publish.json.publishedHeadSha`로 기록한다.

PUBLISH 재실행은 동일 base와 동일 tree의 기존 published commit만 idempotent하게 재사용할 수 있다. 기존 publish branch가 예상하지 않은 SHA를 가리키면 non-fast-forward overwrite를 시도하지 않고 fail-closed 한다.

## 검증과 검토

### VERIFY

VERIFY는 논리적으로 하나의 단계지만 **세 개의 독립 job/runner**로 분리한다.

1. `verify_prepare`: trusted control-plane에서 `publish.json`과 remote HEAD를 재검증하고 exact `publishedHeadSha`를 결정한다.
2. `verify_candidate`: 별도 runner에서 그 exact SHA만 checkout해 `npm ci`, test, build, diff check를 실행한다. 이 runner에는 trusted handler/provenance runtime을 두지 않으며 write credential이나 secrets를 제공하지 않는다.
3. `verify_finalize`: 다시 새 trusted runner에서 source PUBLISH artifact와 remote HEAD를 재검증하고 candidate job이 성공했을 때만 `verify.json`을 생성한다.

이 분리는 디렉터리 분리보다 강한 filesystem trust boundary다. candidate의 `postinstall`, test, build script가 자신의 runner 파일시스템을 수정하더라도 trusted prepare/finalize runner에는 접근할 수 없다. Candidate가 만든 파일이나 output은 `verify.json` provenance의 신뢰 입력으로 사용하지 않는다.

VERIFY의 trusted job은 `contents: read`, `actions: read`만 사용한다. candidate job은 `contents: read`만 사용하고 exact checkout은 `persist-credentials: false`로 수행한다. `GITHUB_TOKEN`, `GH_TOKEN`, `NODE_AUTH_TOKEN`, `NPM_TOKEN` 환경변수도 비운다.

VERIFY 성공 invariant:

```text
remote publish branch HEAD
== publish.json.publishedHeadSha
== isolated candidate checkout HEAD
== verify.json.verifiedHeadSha
```

### Semantic REVIEW

Semantic REVIEW는 VERIFY 성공 뒤 **같은 Trusted Rail run**에서 reusable workflow로 동기 호출한다. REVIEW도 `review_prepare → review_agent → review_finalize`의 세 runner로 나눈다.

1. `review_prepare`는 `verify.json`을 재검증하고 VERIFY chain에 봉인된 compact authorization identity를 이용해 원본 AUTHORIZE run의 `authorize.json`을 다시 가져온다. 승인 당시 `title/body`의 digest를 재계산해 `requirementsDigest`와 exact match할 때만 trusted review input을 만든다.
2. `review_agent`는 별도 runner에서 exact `verifiedHeadSha`만 credential-free checkout하고 AI semantic review를 수행한다. Reviewer에는 GitHub write credential을 제공하지 않으며 repository의 `AGENTS.md`, `.codex`, README, 주석 등은 검토 데이터일 뿐 trusted instruction이 아니다. VERIFY가 이미 candidate code를 실행했으므로 Reviewer는 project test/build/package script를 실행하지 않고 정적 검토만 한다.
3. `review_finalize`는 fresh trusted runner에서 VERIFY artifact와 원본 AUTHORIZE artifact를 다시 선택·검증하고 raw reviewer artifact의 schema와 decision/finding consistency를 trusted code로 검사한다. 이 검증을 통과한 경우에만 `review.json` provenance를 생성한다.

Reviewer raw output 자체는 trusted 사실이 아니다. `PASS`, `LOCAL_FIX`, `STRUCTURAL_CHANGE` 외 decision은 거부하며 다음 consistency를 강제한다.

- `PASS`: BLOCKER 0개
- `LOCAL_FIX`: 하나 이상의 `LOCAL` BLOCKER가 있고 모든 BLOCKER가 LOCAL
- `STRUCTURAL_CHANGE`: 하나 이상의 `STRUCTURAL` BLOCKER
- `FOLLOW_UP`: decision을 막지 않으며 scope는 `NONE`

REVIEW identity invariant:

```text
review.json.reviewedHeadSha
== verify.json.verifiedHeadSha
== publish.json.publishedHeadSha

review.json.requirementsDigest
== authorize.json.requirements.digest
== VERIFY chain sourceAuthorization.requirementsDigest
```

REVIEW prepare/finalize는 `contents: read`, `actions: read`, reviewer는 `contents: read`만 사용한다. REVIEW는 push, PR 생성, Merge, Auto Merge를 수행하지 않는다.

## Embedded Orchestrator

Orchestrator는 Semantic REVIEW 성공 뒤 **같은 Trusted Rail run**에서 reusable workflow로 호출된다. 별도 `workflow_run` trigger를 사용하지 않으므로 REVIEW 이후 실행은 GitHub workflow chain depth에 의존하지 않는다.

Orchestrator는 trusted `review.json`을 같은 Trusted Rail run에서 다시 가져와 exact artifact/run/attempt identity와 provenance chain을 재검증한다. mutable Issue 본문이나 현재 branch text는 next-state 판단의 신뢰 입력이 아니다.

Orchestrator는 새 AI 판단을 하지 않고 이미 trusted finalize가 확정한 REVIEW decision만 결정론적으로 routing한다.

```text
PASS              → MERGE_READY
LOCAL_FIX         → FIXING
STRUCTURAL_CHANGE → STOPPED
```

`PASS`가 아닌 경우 PR을 만들 수 없다. `LOCAL_FIX`에서 실제 FIX Worker를 실행하는 기능은 아직 없다.

### REVIEW artifact rerun binding

`Re-run failed jobs`에서는 Orchestrator job만 새 attempt로 실행되고 이미 성공한 REVIEW job은 재실행되지 않을 수 있다. 이때 current attempt 번호와 동일한 `review.json`이 없다는 이유만으로 실패해서는 안 된다.

따라서 Orchestrator는 같은 Trusted Rail `run_id`에서 다음 규칙으로 source REVIEW artifact를 선택한다.

- artifact attempt가 current `run_attempt`보다 크면 제외한다.
- 남은 artifact 중 가장 최신 attempt를 선택한다.
- 그 latest attempt에 artifact가 정확히 1개여야 한다.
- 선택한 artifact의 **실제 attempt**를 `SOURCE_REVIEW_RUN_ATTEMPT`로 검증한다.
- route와 fresh record 사이에 latest artifact identity가 달라지면 fail-closed 한다.

이렇게 source REVIEW attempt와 current Orchestrator attempt를 분리함으로써 failed-job rerun의 복구 가능성을 유지하면서 provenance identity를 느슨하게 만들지 않는다.

### Human Merge PR boundary

`PASS → MERGE_READY`일 때만 별도 `merge_boundary` job이 실행된다. 이 job은 candidate code를 checkout하거나 실행하지 않고 GitHub API만 사용한다.

권한은 다음으로 제한한다.

```yaml
permissions:
  contents: read
  pull-requests: write
```

`contents: write`가 없으므로 publish branch나 `main`을 수정할 수 없다. PR 생성 직전에 remote branch를 다시 조회하고 다음 invariant를 강제한다.

```text
review.json.reviewedHeadSha
== remote ai-publish/issue-N HEAD
== Human Merge PR head SHA
```

기존 PR은 exact `head + base` 조건으로 하나의 open PR만 존재할 때 재사용한다. 중복 PR, closed/merged PR, head SHA mismatch, 예상하지 않은 branch는 fail-closed 한다.

PR 생성은 Merge가 아니다. Orchestrator는 `pulls.create`까지만 수행하며 merge API, Auto Merge, branch push를 사용하지 않는다.

### Fresh record boundary

PR 생성 여부와 별개로 fresh trusted `record` runner가 source REVIEW artifact를 다시 선택·검증하고 route 단계와 exact identity가 동일한지 확인한다. failed-job rerun에서 prior REVIEW attempt를 재사용했다면 record도 동일한 actual source attempt를 다시 확인한다. 이후에만 `orchestration.json`을 생성한다.

`orchestration.json`은 source REVIEW provenance, source REVIEW의 실제 attempt, current Orchestrator run/attempt, REVIEW decision, `nextState`, exact reviewed SHA와 requirements digest, PASS인 경우 Human Merge PR identity를 기록한다.

## Merge

`MERGE_READY`는 merge 가능한 상태이지 merge 완료가 아니다. Framework가 자동 생성하는 Human Merge PR은 **검증된 candidate를 사람이 최종 판단할 수 있도록 노출하는 경계 객체**다.

Merge는 Human-only이며 Auto Merge 기능은 존재하지 않는다. Trusted PUBLISH의 GitHub write 권한은 publish branch 생성/fast-forward에만 사용하며 merge 권한으로 사용하지 않는다. `VERIFY`와 `REVIEW`는 read-only이며 merge를 수행할 수 없다. Orchestrator PR job은 `pull-requests: write`만 가지며 `contents: write`가 없다. `RECORD_HUMAN_MERGE`는 외부에서 Human merge가 완료됐다는 사실만 기록한다.
