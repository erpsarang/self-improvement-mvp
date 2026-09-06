# Phase 2 — Untrusted IMPLEMENT

Phase 2의 첫 vertical slice는 Trusted `AUTHORIZE` 성공 이후 AI Implementer가 candidate 변경을 만들되 repository 공개 권한과 분리되는 것을 증명한다.

```text
Human SI-승인
→ Trusted AUTHORIZE
→ authorize.json
→ workflow_run
→ Untrusted IMPLEMENT
→ candidate.patch
→ clean provenance record
→ candidate.patch + implement.json
```

## Trust Boundary

- `IMPLEMENT` workflow의 GitHub 권한은 `contents: read`, `actions: read`, `issues: read`뿐이다.
- checkout은 승인 run의 exact `head_sha`를 사용하고 `persist-credentials: false`를 적용한다.
- Codex는 `permission-profile: ":workspace"`에서 실행하며 commit, push, PR 생성, merge를 지시하지 않는다.
- `SI-승인` 시점의 Issue title/body를 AUTHORIZE provenance에 snapshot하고 SHA-256 digest로 고정한다.
- IMPLEMENT prompt는 현재 mutable Issue 내용이 아니라 승인된 requirements snapshot만 사용한다.
- candidate patch는 index 상태가 아니라 exact authorized base SHA 대비 `git diff --binary --full-index`로 생성한다.
- Codex가 수정한 workspace에서는 `implement.json`을 만들지 않는다. 별도 clean exact-SHA job이 untrusted patch를 적용하거나 실행하지 않고 digest/provenance만 기록한다.
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
