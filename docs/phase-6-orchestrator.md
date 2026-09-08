# Phase 6 — Embedded Orchestrator

## 목적

Semantic REVIEW 이후의 다음 동작을 외부 ChatGPT가 판단·실행하는 구조에서 벗어나, Framework 내부 Control Plane이 trusted `review.json`을 직접 소비해 **결정론적으로 상태를 전환**하도록 한다.

```text
trusted review.json
      ↓
Embedded Orchestrator
      ├─ PASS → MERGE_READY → Human Merge PR
      ├─ LOCAL_FIX → FIXING
      └─ STRUCTURAL_CHANGE → STOPPED
```

이 Phase에서 Orchestrator는 새로운 semantic 판단을 하지 않는다. AI Reviewer가 Trusted REVIEW 경계에서 확정한 decision을 State Model의 다음 상태로 routing하는 control-plane 역할만 수행한다.

## 입력 Trust Boundary

Orchestrator는 mutable Issue 본문이나 현재 branch 내용을 decision 입력으로 사용하지 않는다.

입력은 **같은 Trusted Rail run**이 생성한 `review-provenance-issue-<issue>-<run>-attempt-<attempt>` artifact 안의 `review.json` 하나뿐이다.

Trusted code는 다음을 다시 검증한다.

- REVIEW artifact issue/run/attempt identity
- source workflow가 정확히 `.github/workflows/trusted-rail.yml`인지
- source Trusted Rail conclusion이 `success`인지
- `reviewedHeadSha == sourceVerify.verifiedHeadSha`
- `reviewedBranch == sourceVerify.verifiedBranch`
- `requirementsDigest`가 REVIEW requirements snapshot 및 compact AUTHORIZE binding과 동일한지
- REVIEW decision/findings consistency
- reviewer output artifact identity와 digest 형식

`Re-run failed jobs`에서는 현재 Trusted Rail `run_attempt`에 새 REVIEW artifact가 생기지 않을 수 있다. 이 경우 Orchestrator는 **현재 attempt보다 크지 않은 최신 REVIEW artifact**를 선택하고, 그 artifact의 실제 attempt를 source REVIEW identity로 사용한다. 같은 최신 attempt에 artifact가 2개 이상이면 ambiguity로 fail-closed 한다.

## 결정론적 routing

| REVIEW decision | next state | PR 생성 |
| --- | --- | --- |
| `PASS` | `MERGE_READY` | 예 |
| `LOCAL_FIX` | `FIXING` | 아니오 |
| `STRUCTURAL_CHANGE` | `STOPPED` | 아니오 |

`LOCAL_FIX`에서 실제 FIX Worker를 실행하는 것은 후속 Phase다. 현재 Orchestrator는 `FIXING` 상태를 provenance로 기록하는 데까지만 책임진다.

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
- source REVIEW의 실제 run attempt
- Orchestrator 실행의 current run/attempt/trusted code SHA
- `fromState = REVIEWING`
- trusted REVIEW decision
- `nextState`
- exact reviewed branch/SHA
- requirements digest
- `PASS`인 경우 Human Merge PR number/url/base/head/exact SHA

따라서 `MERGE_READY`는 단순 문자열이 아니라 **어떤 REVIEW 결과와 exact SHA를 근거로 어떤 Human Merge PR이 열렸는지** 추적할 수 있는 상태가 된다.

## GitHub Actions 배치

`.github/workflows/orchestrator.yml`은 더 이상 별도 `workflow_run` trigger를 사용하지 않는다. Semantic REVIEW가 성공하면 `.github/workflows/trusted-rail.yml`이 reusable workflow로 Orchestrator를 직접 호출한다.

```text
AUTHORIZE
  ↓ workflow_run
IMPLEMENT
  ↓ workflow_run
Trusted Rail
  → SEAL
  → PUBLISH
  → VERIFY
  → Semantic REVIEW
  → Embedded Orchestrator (same run, reusable workflow)
       ├─ PASS → MERGE_READY → Human Merge PR
       ├─ LOCAL_FIX → FIXING
       └─ STRUCTURAL_CHANGE → STOPPED
```

따라서 Orchestrator 실행 여부는 더 이상 GitHub `workflow_run` chain depth에 의존하지 않는다. 이 구조는 이후 `LOCAL_FIX → FIX → SEAL → PUBLISH → VERIFY → REVIEW → Orchestrator` bounded loop를 설계할 수 있는 Control Plane 기반이다.

## Out of scope

- FIX Worker 실행
- FIX 후 Trusted Rail 재진입
- Auto Merge
- AI 자동 승인
- Risk-based autonomy
- 전체 GRAPH / LOOP Engine
- Human Merge 자동화
