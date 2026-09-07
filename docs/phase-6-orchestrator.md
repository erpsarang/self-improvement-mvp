# Phase 6 — Embedded Orchestrator v0

## 목적

Semantic REVIEW 이후의 다음 동작을 외부 ChatGPT가 판단·실행하는 구조에서 벗어나, Framework 내부 Control Plane이 trusted `review.json`을 직접 소비해 **결정론적으로 상태를 전환**하도록 한다.

```text
trusted review.json
      ↓
Embedded Orchestrator v0
      ├─ PASS → MERGE_READY → Human Merge PR
      ├─ LOCAL_FIX → FIXING
      └─ STRUCTURAL_CHANGE → STOPPED
```

이 Phase에서 Orchestrator는 새로운 semantic 판단을 하지 않는다. AI Reviewer가 Trusted REVIEW 경계에서 확정한 decision을 State Model의 다음 상태로 routing하는 control-plane 역할만 수행한다.

## 입력 Trust Boundary

Orchestrator는 mutable Issue 본문이나 현재 branch 내용을 decision 입력으로 사용하지 않는다.

입력은 source Trusted Rail run의 `review-provenance-issue-<issue>-<run>-attempt-<attempt>` artifact 안의 `review.json` 하나뿐이다.

Trusted code는 다음을 다시 검증한다.

- REVIEW artifact issue/run/attempt identity
- source workflow가 정확히 `.github/workflows/trusted-rail.yml`인지
- source Trusted Rail conclusion이 `success`인지
- `reviewedHeadSha == sourceVerify.verifiedHeadSha`
- `reviewedBranch == sourceVerify.verifiedBranch`
- `requirementsDigest`가 REVIEW requirements snapshot 및 compact AUTHORIZE binding과 동일한지
- REVIEW decision/findings consistency
- reviewer output artifact identity와 digest 형식

## 결정론적 routing

| REVIEW decision | next state | PR 생성 |
| --- | --- | --- |
| `PASS` | `MERGE_READY` | 예 |
| `LOCAL_FIX` | `FIXING` | 아니오 |
| `STRUCTURAL_CHANGE` | `STOPPED` | 아니오 |

`LOCAL_FIX`에서 실제 FIX Worker를 실행하는 것은 후속 Phase다. v0는 `FIXING` 상태를 provenance로 기록하는 데까지만 책임진다.

## Human Merge PR boundary

`PASS → MERGE_READY`에서만 별도 job이 PR을 생성하거나 기존 exact PR을 재사용한다.

PR 생성 직전에 다음 invariant를 검증한다.

```text
remote ai-publish/issue-N HEAD
== review.json.reviewedHeadSha
== PR head SHA
```

PR job 권한은 다음뿐이다.

```yaml
permissions:
  contents: read
  pull-requests: write
```

`contents: write`는 없으며 branch를 수정하지 않는다. Merge와 Auto Merge도 실행하지 않는다. PR은 **Human이 최종 Merge 여부를 판단하는 경계 객체**다.

기존 PR 검색은 `head + base`로 수행하며:

- exact open PR 1개 → 재사용
- 0개 → 새 PR 생성
- 2개 이상 → ambiguity로 fail-closed
- 기존 PR이 closed/merged → 자동 재생성하지 않고 fail-closed
- 기존 PR head SHA가 reviewed SHA와 다름 → fail-closed

## Orchestration provenance

`orchestration.json`은 다음을 결합한다.

- source REVIEW artifact와 전체 `ReviewProvenance`
- Orchestrator workflow run/attempt/trusted code SHA
- `fromState = REVIEWING`
- trusted REVIEW decision
- `nextState`
- exact reviewed branch/SHA
- requirements digest
- `PASS`인 경우 Human Merge PR number/url/base/head/exact SHA

따라서 `MERGE_READY`는 단순 문자열이 아니라 **어떤 REVIEW 결과와 exact SHA를 근거로 어떤 Human Merge PR이 열렸는지** 추적할 수 있는 상태가 된다.

## GitHub Actions v0 배치

현재 GitHub adapter에서는 `.github/workflows/orchestrator.yml`이 `Trusted Rail` 완료를 `workflow_run`으로 받아 실행한다.

```text
AUTHORIZE
  ↓ workflow_run
IMPLEMENT
  ↓ workflow_run
Trusted Rail (SEAL → PUBLISH → VERIFY → REVIEW)
  ↓ workflow_run
Embedded Orchestrator v0
```

이것은 GitHub의 `workflow_run` 연쇄 제한에서 마지막 허용 깊이를 사용하는 **v0 실행 배치**다. 따라서 실제 FIX 재진입 LOOP를 구현하기 전에 Orchestrator/GRAPH 실행을 하나의 장기 실행 Control Plane 또는 chain depth에 의존하지 않는 adapter 구조로 재배치해야 한다.

이 제한은 Embedded Orchestrator 개념의 제약이 아니라 현재 GitHub Actions adapter의 임시 실행 구조다.

## Out of scope

- FIX Worker 실행
- FIX 후 Trusted Rail 재진입
- Auto Merge
- AI 자동 승인
- Risk-based autonomy
- 전체 GRAPH / LOOP Engine
- Human Merge 자동화
