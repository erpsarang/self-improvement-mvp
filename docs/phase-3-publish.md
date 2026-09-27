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
  - ai-publish/issue-<N>-cycle-<16hex> branch에만 push (FIX는 source REVIEW branch를 이어받음)
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

PUBLISH는 `main`에 직접 쓰지 않는다. Issue + cycle identity 기반 deterministic branch만 사용한다.

```text
ai-publish/issue-<issueNumber>-cycle-<cycleId>
cycleId = sha256("<baseSha>:<sealedPatchDigest>")의 앞 16자리 hex
```

cycle은 trusted SEAL의 `baseSha`와 `sealedPatchDigest`로 정해진다. 같은 cycle의 재시도는 같은 branch를 재사용하고, 같은 Issue의 다음 slice는 다른 branch를 사용한다. 그래서 이전 slice의 branch가 남아 있어도 다음 slice PUBLISH가 막히지 않는다.

첫 PUBLISH는 exact `baseSha`에서 새 commit을 만든다. 동일 실행이 재시도되어 이미 같은 tree가 공개돼 있으면 기존 exact head SHA를 재사용한다. 기존 branch가 다른 SHA를 가리키면 non-fast-forward overwrite를 거부한다.

FIX는 새 cycle branch를 만들지 않는다. source REVIEW의 branch를 그대로 이어받아 기존 published head 위에 fast-forward한다. 이어받는 branch는 같은 Issue의 cycle 형식 또는 이 변경 전 legacy 형식(`ai-publish/issue-<N>`)이어야 한다. legacy 형식은 이전 run이 남긴 historical provenance(FIX 입력, LEARN Source, Human Merge 후 workflow)를 읽을 때만 허용하며, 새 PUBLISH는 cycle 형식만 만든다.

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
