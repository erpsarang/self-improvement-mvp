# Phase 4: Trusted VERIFY

## 목적

Trusted PUBLISH가 기록한 immutable `publishedHeadSha`와 **실제로 검증한 commit SHA가 동일함**을 증명한다.

```text
publish.json
  publishedHeadSha
        │
        ├─ remote ai-publish/issue-<N> HEAD exact match
        │
        └─ exact SHA checkout
                ↓
        isolated candidate verification
                ↓
        trusted finalize
                ↓
verify.json
  verifiedHeadSha == publishedHeadSha
```

## 입력

VERIFY는 같은 Trusted Rail run의 `publish-provenance-issue-<N>-<run>-attempt-<attempt>` artifact만 입력으로 사용한다. 현재 attempt의 artifact가 없으면 같은 run에서 가장 최근의 이전 PUBLISH attempt를 선택할 수 있지만, 이름과 `publish.json` 내부 issue/run/attempt identity가 정확히 결합되어야 한다.

## Trust Boundary

VERIFY는 한 runner 안에서 trusted handler와 candidate code를 함께 실행하지 않는다. 세 개의 독립 job/runner로 분리한다.

```text
trusted VERIFY prepare
        ↓ exact published SHA
isolated candidate verification
        ↓ job success/failure만 전달
trusted VERIFY finalize
        ↓
verify.json
```

- workflow-level `permissions: {}` 유지
- `verify_prepare`: `contents: read`, `actions: read`
- `verify_candidate`: `contents: read`, `persist-credentials: false`
- `verify_finalize`: `contents: read`, `actions: read`
- candidate runner에는 `publish.json`, `verify-handler.ts`, trusted provenance runtime을 두지 않음
- candidate runner의 `GITHUB_TOKEN`, `GH_TOKEN`, `NODE_AUTH_TOKEN`, `NPM_TOKEN` 환경변수는 비움
- GitHub write credential과 secrets를 candidate 검증 프로세스에 전달하지 않음
- push / PR 생성 / merge / Auto Merge 없음

candidate 검증은 별도 GitHub-hosted runner의 파일시스템에서 끝난다. 따라서 악의적 `postinstall`, test, build script가 trusted prepare/finalize runner의 handler나 provenance 파일을 덮어쓸 수 없다. Trusted finalize는 candidate가 만든 파일을 신뢰 입력으로 받지 않고, candidate job의 성공 여부만 dependency result로 사용한다.

## Exact SHA invariant

VERIFY 성공의 핵심 invariant는 다음 하나다.

```text
remote publish branch HEAD
        == publish.json.publishedHeadSha
        == isolated exact checkout HEAD
        == verify.json.verifiedHeadSha
```

trusted prepare에서 candidate 실행 전에 remote branch HEAD를 확인하고, trusted finalize의 새 runner에서 PUBLISH provenance를 다시 선택·검증한 뒤 remote branch HEAD를 다시 확인한다. 두 시점 사이에 branch나 provenance identity가 바뀌면 fail-closed 한다.

## 기계 검증

isolated candidate runner의 exact published SHA checkout에서 다음을 수행한다.

1. exact checkout SHA 확인
2. `npm ci`
3. `npm test`
4. `npm run build`
5. `git show --check --format= HEAD`

이 명령은 Framework MVP repository의 현재 검증 계약이다. 향후 GRAPH/Adapter 단계에서는 project type에 따라 verification command set을 명시적으로 provenance와 결합할 수 있다.

## Provenance

성공한 VERIFY는 trusted finalize runner에서 `verify.json`을 생성한다. candidate runner는 `verify.json`을 만들지 않는다.

- source PUBLISH artifact 이름
- 전체 `sourcePublish` provenance
- VERIFY Trusted Rail run ID / attempt
- VERIFY trusted control-plane SHA
- verified branch
- exact `verifiedHeadSha`
- `result: PASS`

`verifiedHeadSha`가 `publishedHeadSha`와 다르면 provenance 자체를 생성하지 않고 fail-closed 한다.

## Out of scope

- Semantic Review
- FIX
- MERGE_READY
- PR 자동 생성
- Auto Merge
- Human Merge 자동화
