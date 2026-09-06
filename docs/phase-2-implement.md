# Phase 2 — Untrusted IMPLEMENT

Phase 2의 첫 vertical slice는 Trusted `AUTHORIZE` 성공 이후 AI Implementer가 candidate 변경을 만들되 repository 공개 권한과 분리되는 것을 증명한다.

```text
Human SI-승인
→ Trusted AUTHORIZE
→ authorize.json
→ workflow_run
→ Untrusted IMPLEMENT
→ candidate.patch + implement.json
```

## Trust Boundary

- `IMPLEMENT` workflow의 GitHub 권한은 `contents: read`, `actions: read`, `issues: read`뿐이다.
- checkout은 승인 run의 exact `head_sha`를 사용하고 `persist-credentials: false`를 적용한다.
- Codex는 `permission-profile: ":workspace"`에서 실행하며 commit, push, PR 생성, merge를 지시하지 않는다.
- 결과는 repository에 push하지 않고 Actions artifact의 `candidate.patch`와 `implement.json`으로만 남긴다.
- candidate artifact는 untrusted output이며 후속 Trusted `SEAL`을 통과하기 전에는 PUBLISH 대상으로 인정하지 않는다.

## 입력 검증

`IMPLEMENT`는 `Trusted AUTHORIZE` workflow의 successful `workflow_run`만 수신한다. source run에서 생성된 AUTHORIZE artifact가 정확히 하나인지 확인하고, `authorize.json`의 repository, workflow path, run ID, run attempt, exact SHA, approval command와 policy snapshot 형식을 검증한다. 승인 대상 Issue도 GitHub API로 다시 조회해 일반 Issue인지 확인한다.

검증이 하나라도 실패하면 Codex를 실행하지 않고 fail-closed 한다.

## Candidate provenance

`implement.json`은 최소한 다음을 결합한다.

- source AUTHORIZE run ID / run attempt
- approval comment ID / policy snapshot
- exact base SHA
- IMPLEMENT workflow run ID / run attempt
- candidate patch SHA-256 digest
- Codex Action 실행 식별자

이번 Phase에서는 `SEAL`, `PUBLISH`, branch/PR 자동 생성, `VERIFY`, `REVIEW`, `FIX`, `MERGE_READY`를 수행하지 않는다. 최종 Merge는 계속 Human-only이다.
