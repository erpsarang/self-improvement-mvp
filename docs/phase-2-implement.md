# Phase 2 — Untrusted IMPLEMENT

Phase 2의 첫 vertical slice는 Trusted `AUTHORIZE` 성공 이후 AI Implementer가 candidate 변경을 만들되 repository 공개 권한과 분리되는 것을 증명한다.

```text
Human SI-승인
→ Trusted AUTHORIZE
→ authorize.json
→ workflow_run
→ Untrusted IMPLEMENT
→ workspace snapshot
→ clean Git worktree에서 candidate.patch 생성
→ clean provenance record
→ candidate.patch + implement.json
```

## Trust Boundary

- `IMPLEMENT` workflow의 GitHub 권한은 `contents: read`, `actions: read`, `issues: read`뿐이다.
- checkout은 승인 run의 exact `head_sha`를 사용하고 `persist-credentials: false`를 적용한다.
- Codex는 `permission-profile: ":workspace"`에서 실행하며 commit, push, PR 생성, merge를 지시하지 않는다.
- `SI-승인` 시점의 Issue title/body를 AUTHORIZE provenance에 snapshot하고 SHA-256 digest로 고정한다.
- IMPLEMENT prompt는 현재 mutable Issue 내용이 아니라 승인된 requirements snapshot만 사용한다.
- Codex가 끝난 workspace에서는 `git add`, `git diff`, finalizer를 실행하지 않는다. `node_modules/`, `.git/`, runtime prompt를 제외한 workspace snapshot만 artifact로 넘긴다.
- 별도 clean job이 승인된 exact SHA를 다시 checkout하고 clean Git metadata로 임시 worktree를 만든 뒤 workspace snapshot을 데이터로만 반영한다.
- candidate patch 생성 시 repository-local untrusted Git config를 사용하지 않으며 system/global config, hooks, external diff, textconv를 비활성화한다.
- tracked 변경/삭제는 exact authorized base SHA 대비 diff로, 새 untracked 파일은 `git ls-files --others` + `git diff --no-index`로 별도 포함한다.
- clean job이 생성한 `candidate.patch`는 적용하거나 실행하지 않고 clean `implement-handler.ts`가 digest/provenance만 기록한다.
- 결과는 repository에 push하지 않고 Actions artifact의 `candidate.patch`와 `implement.json`으로만 남긴다.
- candidate artifact는 untrusted output이며 후속 Trusted `SEAL`을 통과하기 전에는 PUBLISH 대상으로 인정하지 않는다.

## 입력 검증

`IMPLEMENT`는 `Trusted AUTHORIZE` workflow의 successful `workflow_run`만 수신한다. source run에서 생성된 AUTHORIZE artifact를 선택하고, `authorize.json`의 repository, workflow path, run ID, run attempt, exact SHA, approval command, policy snapshot, requirements digest를 검증한다. 승인 대상 Issue도 GitHub API로 다시 조회해 일반 Issue인지 확인한다.

동일 AUTHORIZE run의 rerun이 이전 attempt artifact를 재사용한 경우에는 새로운 IMPLEMENT를 시작하지 않고 정상 no-op 처리한다. 현재 attempt용 artifact가 없고 이전 artifact도 정확히 하나로 식별되지 않으면 fail-closed 한다.

검증이 하나라도 실패하면 Codex를 실행하지 않는다.

## Candidate provenance

`implement.json`은 최소한 다음을 결합한다.

- source AUTHORIZE run ID / run attempt
- approval comment ID / policy snapshot
- 승인 requirements digest
- exact base SHA
- IMPLEMENT workflow run ID / run attempt
- candidate patch SHA-256 digest
- Codex Action 실행 식별자

이번 Phase에서는 `SEAL`, `PUBLISH`, branch/PR 자동 생성, `VERIFY`, `REVIEW`, `FIX`, `MERGE_READY`를 수행하지 않는다. 최종 Merge는 계속 Human-only이다.
