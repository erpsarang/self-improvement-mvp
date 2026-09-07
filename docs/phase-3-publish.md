# Phase 3: Trusted PUBLISH

## 목적

Trusted `SEAL`이 봉인한 exact bytes만 GitHub write boundary를 통과시켜 공개하고, 공개된 commit의 immutable SHA를 `published_head_sha`로 기록한다.

```text
sealed.patch + seal.json
        │
        ▼
Trusted PUBLISH job
  - sealed artifact 재검증
  - exact baseSha worktree 생성
  - sealed.patch 적용
  - ai-publish/issue-<N> branch에만 push
        │
        ▼
publish.json
  - source SEAL provenance
  - published branch
  - exact published_head_sha
```

## Trust Boundary

- `SEAL` job은 계속 `contents: read`, `actions: read`만 사용한다.
- `PUBLISH` job만 `contents: write`를 가진다.
- PUBLISH는 Worker workspace를 읽거나 실행하지 않는다.
- 입력은 현재 Trusted Rail run이 만든 `sealed.patch + seal.json` artifact뿐이다.
- trusted control-plane 코드는 `github.sha`에서 실행하고, sealed patch 적용은 별도 temporary worktree에서 수행한다.
- candidate code는 PUBLISH 중 실행하지 않는다.

## Publish target

PUBLISH는 `main`에 직접 쓰지 않는다. Issue별 deterministic branch만 사용한다.

```text
ai-publish/issue-<issueNumber>
```

첫 PUBLISH는 exact `baseSha`에서 새 commit을 만든다. 동일 실행이 재시도되어 이미 같은 tree가 공개돼 있으면 기존 exact head SHA를 재사용한다. 기존 branch가 다른 SHA를 가리키면 non-fast-forward overwrite를 거부한다. 이후 FIX가 기존 published head를 새 base로 사용하면 동일 branch에 fast-forward할 수 있도록 경계를 유지한다.

Force push와 Auto Merge는 금지한다.

## Provenance

`publish.json`은 최소 다음 정보를 결합한다.

- repository / issue number / base SHA
- source sealed artifact name
- source `seal.json` provenance
- PUBLISH workflow run ID / attempt / trusted code SHA
- published branch
- immutable `publishedHeadSha`

PUBLISH 직후 remote branch SHA를 다시 조회해 실제 remote SHA와 로컬 또는 재사용한 published SHA가 exact match일 때만 `publish.json`을 생성한다.

## 이번 단계에서 하지 않는 것

- Pull Request 자동 생성
- exact SHA VERIFY
- Semantic Review
- FIX 구현
- MERGE_READY
- Auto Merge / Human Merge 실행

후속 VERIFY는 `publish.json.publishedHeadSha`와 실제 검증 checkout SHA가 exact match인 경우에만 성공해야 한다.
