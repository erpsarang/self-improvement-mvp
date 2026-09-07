# Phase 5 — exact verified SHA Semantic REVIEW

## 목적

Trusted VERIFY가 `PASS`로 확정한 exact `verifiedHeadSha`를 승인 당시 요구사항과 비교해 의미적 적합성을 판정합니다. REVIEW는 기계 검증을 반복하지 않습니다. 이미 VERIFY된 동일 commit을 대상으로 **요구사항을 제대로 구현했는가**를 독립 AI Reviewer가 판단하고, trusted code가 그 결과를 provenance로 봉인합니다.

```text
verify.json
   │ exact verifiedHeadSha
   │ authorization binding
   ▼
Trusted REVIEW Prepare
   │ 원본 AUTHORIZE artifact 재검증
   │ approved requirements snapshot
   ▼
Isolated AI Reviewer
   │ exact verified SHA, read-only
   │ raw reviewer.json (untrusted)
   ▼
Fresh Trusted REVIEW Finalize
   │ VERIFY/AUTHORIZE identity 재검증
   │ reviewer schema/decision consistency 검증
   ▼
review.json
   ├─ PASS
   ├─ LOCAL_FIX
   └─ STRUCTURAL_CHANGE
```

## 왜 원본 AUTHORIZE artifact를 다시 읽는가

`IMPLEMENT → SEAL → PUBLISH → VERIFY` provenance chain은 승인 요구사항 전체 본문을 계속 복제하지 않고 `requirementsDigest`만 전달합니다. Semantic Review에는 실제 승인 당시 `title/body`가 필요하므로, REVIEW는 VERIFY chain에 봉인된 `runId`, `runAttempt`, `approvalCommentId`, `requirementsDigest`, `authorizedBaseSha`를 이용해 **원본 AUTHORIZE artifact**를 다시 가져옵니다.

Trusted prepare/finalize는 원본 `authorize.json`의 requirements digest를 재계산하고 compact authorization binding과 exact match일 때만 사용합니다. 따라서 현재 Issue의 mutable 본문이나 최신 branch 내용을 요구사항으로 대체하지 않습니다.

## Reviewer decision 계약

허용 decision은 상태 모델과 동일한 세 가지입니다.

| Decision | 의미 | BLOCKER 규칙 |
| --- | --- | --- |
| `PASS` | 승인 요구사항을 만족하고 merge를 막을 semantic blocker가 없음 | BLOCKER 0개 |
| `LOCAL_FIX` | 현재 구조를 유지한 국소 수정으로 해결 가능 | 1개 이상의 `LOCAL` BLOCKER, 모든 BLOCKER가 LOCAL |
| `STRUCTURAL_CHANGE` | 요구사항/아키텍처/Trust Boundary 수준 변경 필요 | 1개 이상의 `STRUCTURAL` BLOCKER |

스타일, 리팩터링, P2 이하 개선은 `FOLLOW_UP` finding으로 남길 수 있지만 `PASS`를 막지 않습니다. `FOLLOW_UP`의 scope는 `NONE`입니다.

## Trust Boundary

### 1. Trusted REVIEW Prepare

- `contents: read`, `actions: read`
- current 또는 가장 최근 prior `verify.json` artifact를 ambiguity 시 fail-closed 방식으로 선택
- VERIFY provenance 및 exact source PUBLISH identity 재검증
- 원본 AUTHORIZE artifact를 exact source run에서 재다운로드
- 승인 당시 requirements snapshot과 digest 재검증
- trusted review prompt / JSON schema / review input 생성

### 2. Isolated AI Reviewer

- 별도 GitHub-hosted runner
- exact `verifiedHeadSha`만 `persist-credentials: false`로 checkout
- `GITHUB_TOKEN`, `GH_TOKEN`, `NODE_AUTH_TOKEN`, `NPM_TOKEN` 환경값 비움
- `openai/codex-action@v1`은 `permission-profile: :read-only`로 실행
- candidate의 `AGENTS.md`, `.codex`, README, 주석 등은 **검토 데이터**이며 reviewer 지시문으로 신뢰하지 않음
- `project_doc_max_bytes=0`으로 candidate repository의 자동 project instruction 주입을 끔
- test/build/package manager 등 candidate executable은 실행하지 않음
- 결과는 구조화된 `reviewer.json`으로만 생성하고 **untrusted artifact**로 저장

### 3. Fresh Trusted REVIEW Finalize

- 새 runner에서 실행
- candidate checkout이나 reviewer workspace를 공유하지 않음
- VERIFY artifact를 다시 선택하고 prepare와 exact identity 비교
- AUTHORIZE artifact를 다시 가져와 requirements binding 재검증
- reviewer artifact를 current/latest prior attempt에서 fail-closed 선택
- raw reviewer JSON schema와 decision/finding consistency를 trusted code로 검사
- exact raw reviewer bytes의 SHA-256을 provenance에 기록
- 통과한 경우에만 `review.json` 생성

## Exact identity invariant

```text
review.json.reviewedHeadSha
        == verify.json.verifiedHeadSha
        == publish.json.publishedHeadSha
        == remote ai-publish/issue-N HEAD (VERIFY 시점)

review.json.requirementsDigest
        == authorize.json.requirements.digest
        == VERIFY chain sourceAuthorization.requirementsDigest
```

REVIEW는 branch 이름이나 최신 Issue 본문을 재해석해 identity를 바꾸지 않습니다.

## Provider-neutral core

현재 GitHub 실행 adapter에서는 AI Reviewer로 `openai/codex-action@v1`을 사용합니다. 그러나 core의 `SemanticReviewerOutput`과 `ReviewProvenance`는 특정 모델 이름에 종속되지 않습니다.

```text
Semantic Reviewer Provider
  ├─ OpenAI / Codex   ← 현재 adapter
  ├─ Azure OpenAI
  ├─ Anthropic
  └─ Local Model
          │
          ▼
SemanticReviewerOutput
          │ trusted validation
          ▼
ReviewProvenance
```

이는 최종 제품에서 외부 ChatGPT가 control plane이 되는 구조가 아니라 **Framework 내부 AI Orchestrator가 provider를 선택해 Reviewer 역할을 실행**하도록 발전시키기 위한 경계입니다.

## Out of scope

이번 Phase에서는 다음을 구현하지 않습니다.

- `FIX` Worker
- review decision의 실제 상태 persistence / GRAPH orchestration
- `MERGE_READY` 자동 전환
- PR 자동 생성
- Auto Merge
- Human Merge 자동화
- 전체 Embedded AI Orchestrator

최종 Merge는 계속 Human-only입니다.
