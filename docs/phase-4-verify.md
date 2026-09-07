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
        machine verification
                ↓
verify.json
  verifiedHeadSha == publishedHeadSha
```

## 입력

VERIFY는 같은 Trusted Rail run의 `publish-provenance-issue-<N>-<run>-attempt-<attempt>` artifact만 입력으로 사용한다. 현재 attempt의 artifact가 없으면 같은 run에서 가장 최근의 이전 PUBLISH attempt를 선택할 수 있지만, 이름과 `publish.json` 내부 issue/run/attempt identity가 정확히 결합되어야 한다.

## Trust Boundary

- workflow-level `permissions: {}` 유지
- VERIFY job: `contents: read`, `actions: read`
- candidate checkout은 `persist-credentials: false`
- GitHub write credential과 secrets를 candidate 검증 프로세스에 전달하지 않음
- push / PR 생성 / merge / Auto Merge 없음

Trusted control-plane checkout과 candidate exact-SHA checkout은 별도 디렉터리로 분리한다. 따라서 candidate가 Trusted VERIFY handler를 덮어쓰지 못한다.

## Exact SHA invariant

VERIFY 성공의 핵심 invariant는 다음 하나다.

```text
remote publish branch HEAD
        == publish.json.publishedHeadSha
        == exact checkout HEAD
        == verify.json.verifiedHeadSha
```

검증 시작 전과 종료 후 remote branch HEAD를 각각 확인한다. 검증 중 branch가 이동하면 해당 VERIFY 실행은 실패한다.

## 기계 검증

현재 MVP는 exact published SHA checkout에서 다음을 수행한다.

1. `npm ci`
2. `npm test`
3. `npm run build`
4. `git show --check --format= HEAD`

이 명령은 Framework MVP repository의 현재 검증 계약이다. 향후 GRAPH/Adapter 단계에서는 project type에 따라 verification command set을 명시적으로 provenance와 결합할 수 있다.

## Provenance

성공한 VERIFY는 `verify.json`에 다음 핵심 정보를 기록한다.

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
