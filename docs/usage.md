# AI Development Framework v0.2 사용 가이드

이 문서는 **업무 요구사항을 AI Development Framework v0.2에 넣어 실제 개발 사이클을 시작하고, Human Merge 이후 LEARN / IMPROVE까지 연결하는 방법**을 설명합니다.

## 1. 사람이 처음 작성하는 것은 구현 지시가 아니라 Requirement

사용자는 파일명이나 함수 구현 방법을 세세하게 지정할 필요가 없습니다. 무엇이 필요한지와 완료 조건을 명확히 적습니다.

예:

```markdown
## 목표
예외 주문의 주요 원인을 한눈에 파악하고 싶다.

## 완료 조건
- 예외 사유별 건수를 확인할 수 있다.
- 가장 많이 발생한 사유를 확인할 수 있다.
- 기존 주문 판정 결과는 바뀌지 않는다.
- 자동 테스트가 통과한다.

## 금지사항
- 무관한 기능 변경 금지
- main 직접 push 금지
```

## 2. OpenAI API 비용 경계 준비

Framework와 실제 App의 API 비용을 구분하기 위해 OpenAI Project와 API Key를 분리한다.

권장 배치는 다음과 같다.

```text
Framework repo: self-improvement-mvp
OpenAI Project: framework-dev
GitHub Secret: FRAMEWORK_CODEX_API_KEY

App repo: sales-order-exception-analyzer
OpenAI Project: sales-order-app
GitHub Secret: APP_CODEX_API_KEY
```

운영 절차:

1. OpenAI API Platform에서 Framework용 Project를 만든다.
2. 해당 Project 전용 API Key를 만든다.
3. `self-improvement-mvp` repository secret에 `FRAMEWORK_CODEX_API_KEY`로 등록한다.
4. App별로 별도 OpenAI Project와 별도 API Key를 만든다.
5. 각 App repository에는 `APP_CODEX_API_KEY`로 등록한다.
6. Usage Dashboard에서 Project별 사용량을 별도로 확인한다.
7. 기존 공용 `CODEX_API_KEY`는 각 repo의 cutover PR이 merge되고 새 secret 동작이 검증된 뒤 폐기한다.

주의:

- secret 값은 repository나 문서에 기록하지 않는다.
- 두 repo에서 같은 API Key를 재사용하지 않는다.
- OpenAI Project의 spend limit은 알림/모니터링 경계로 취급하고, 실행을 강제로 막는 hard cap으로 가정하지 않는다.
- Framework의 중복 AI call 방지, bounded retry, token ledger는 별도 runtime guardrail로 유지한다.

## 3. v0.2 기본 흐름

```text
User Requirement
→ read-only AI PLAN
→ Human PLAN-승인
→ Trusted PLAN_AUTHORIZE
→ Trusted ImplementContract + exact-SHA Context Pack
→ bounded untrusted IMPLEMENT Worker
→ deterministic CI
→ canonical PLAN Bridge
→ Trusted Rail
   → SEAL → PUBLISH → VERIFY → Semantic REVIEW
   → 필요 시 bounded FIX
→ MERGE_READY
→ Human Merge
→ Completed Cycle Record
→ bounded LEARN Input Pack
→ read-only AI LEARN
→ proposal-only Improvement Candidate
→ Human 판단
```

중요한 Human Boundary는 세 곳입니다.

1. **PLAN 승인** — AI가 제안한 exact PLAN을 사람이 승인
2. **최종 Merge** — 검증·리뷰된 exact 결과를 사람이 Merge
3. **개선 후보 선택** — LEARN이 만든 후보 중 다음 cycle로 보낼 항목을 사람이 선택

## 4. read-only AI PLAN

Requirement가 준비되면 Planner가 repository의 bounded Context를 읽고 PLAN을 만듭니다.

Planner는 다음을 제안합니다.

- 구현 접근
- 변경할 exact path 후보
- `requiredChanges`
- `forbiddenChanges`
- 검증 명령
- 구현 준비 여부 `implementationScope.ready`

Planner는 repository를 수정하지 않으며 PLAN 자체도 authority가 아닙니다.

`ready=false`이거나 blocking question이 남아 있으면 IMPLEMENT로 넘어가지 않습니다.

## 5. Human `PLAN-승인`

PLAN을 확인한 뒤 승인하려면 Requirement Issue에 정확히 다음 댓글을 남깁니다.

```text
PLAN-승인
```

Trusted `PLAN_AUTHORIZE`는 댓글 문자열만 믿지 않고 다음 identity를 다시 검증합니다.

- Requirement Issue / digest
- PLAN run / attempt
- PLAN artifact / provenance
- frozen target SHA
- approval comment ID
- approver immutable GitHub user ID

Requirement나 target SHA가 PLAN 이후 바뀌었다면 silent substitution하지 않고 fail-closed합니다. 이 경우 새 PLAN이 필요합니다.

## 6. Trusted Handoff와 bounded IMPLEMENT

승인된 PLAN의 structured scope는 Trusted control-plane에서 그대로 `ImplementContract`로 변환됩니다. 자연어를 다시 자의적으로 해석하지 않습니다.

exact base SHA에서 `allowedPaths`에 필요한 최소 Context만 `Context Pack`으로 고정합니다.

IMPLEMENT Worker는 다음 제한을 가집니다.

- untrusted
- repository write credential 없음
- bounded Context만 사용
- 허용 path와 byte/file budget 안에서 candidate 생성
- 결과는 candidate artifact일 뿐

Worker가 만든 candidate는 clean exact-base checkout에서 deterministic validation을 통과해야 canonical PLAN Bridge가 됩니다.

## 7. Trusted Rail

canonical PLAN Bridge가 만들어지면 Trusted Rail이 시작됩니다.

```text
SEAL
→ PUBLISH
→ VERIFY exact published SHA
→ Semantic REVIEW
```

### SEAL

candidate bytes와 provenance를 검증하고 봉인합니다.

### PUBLISH

봉인된 candidate만 publish branch에 게시합니다. Worker가 직접 push하지 않습니다.

### VERIFY

branch 이름이 아니라 exact `publishedHeadSha`를 checkout하여 기계 검증합니다.

### Semantic REVIEW

승인된 Requirement와 exact verified SHA를 함께 검토합니다.

| Decision | 의미 | 다음 행동 |
| --- | --- | --- |
| `PASS` | 요구사항 충족 | `MERGE_READY` → Human Merge PR |
| `LOCAL_FIX` | 제한된 수정으로 해결 가능 | bounded FIX loop |
| `STRUCTURAL_CHANGE` | 범위를 넘는 재설계 필요 | `STOPPED` / Human 판단 |

## 8. LOCAL_FIX

`LOCAL_FIX`라고 해서 사람이 Codex에 자유형 수정 명령을 다시 주는 것이 아닙니다.

```text
REVIEW = LOCAL_FIX
→ Trusted FIX Request
→ bounded Untrusted FIX Worker
→ candidate
→ SEAL → PUBLISH → VERIFY → REVIEW
```

FIX Worker 역시 write credential을 받지 않고 candidate만 만듭니다. 수정 후 전체 Trusted Rail을 다시 통과해야 합니다.

반복 횟수와 실행 예산은 Framework가 제한하며 한도를 넘으면 사람이 판단하도록 중단합니다.

## 9. PASS와 Human Merge

`PASS`에서만 Framework가 `MERGE_READY` Human Merge PR을 만듭니다.

사람은 최소 다음을 확인합니다.

- PR HEAD가 reviewed exact SHA와 일치하는가
- 변경 파일이 승인된 범위 안인가
- CI / provenance가 정상인가
- 예상하지 못한 운영·보안 영향이 없는가

그 뒤 사람이 직접 Merge합니다.

**Auto Merge는 사용하지 않습니다.**

## 10. Human Merge 이후 LEARN

LEARN은 open PR이나 MERGE_READY를 완료된 사실로 취급하지 않습니다. 실제 Human Merge가 끝난 cycle만 학습 대상으로 사용합니다.

Trusted LEARN Source가 다음을 exact provenance로 고정합니다.

- Requirement identity
- reviewed exact SHA
- merge commit / merged_at
- Trusted Rail run / orchestration artifact
- final REVIEW
- deterministic test execution evidence가 있으면 그 exact chain

그 결과를 bounded `LEARN Input Pack`으로 만든 뒤 read-only AI Learner가 읽습니다.

Learner는 GitHub 최신 상태나 repository 전체를 다시 탐색하지 않습니다.

## 11. Improvement Candidate와 Human-selected LOOP

LEARN report의 improvement hypothesis는 deterministic하게 `Improvement Candidate Pack`으로 구조화됩니다.

각 candidate는:

- `proposal-only`
- `pending-human`
- evidence-grounded
- 자동 ranking 없음
- 자동 IMPLEMENT 없음

사람이 의미 있는 candidate를 선택한 경우에만 **새 Requirement**로 만들어 다음 PLAN cycle을 시작합니다.

즉 Self-Improvement도 자기 승인 구조가 아닙니다.

## 12. v0.2에서 실제 증명한 dogfood

`erpsarang/sales-order-exception-analyzer` Issue #8을 실제 업무 요구로 사용했습니다.

```text
Issue #8
→ PLAN
→ PLAN-승인
→ bounded IMPLEMENT
→ deterministic CI
→ Trusted Rail
→ REVIEW PASS
→ Human Merge PR #24
→ Human Merge
→ LEARN
→ Improvement Candidate
→ Human-selected candidate
→ Framework 개선 Requirement #171
→ 구현 / Human Merge
→ dogfood 재동기화
→ historical exact LEARN replay
```

최신 replay에서는 별도 `test-execution` evidence로 `npm test / PASS / exitCode 0 / signal null`을 검증했습니다.

## 13. 현재 한계

v0.2는 GitHub + Node 기반 실제 프로젝트에서 신뢰 가능한 수직 루프를 검증한 MVP입니다.

아직 일반화할 영역:

- SAP RAP/ABAP 등 다른 검증 체계용 verifier adapter
- 범용 GRAPH DSL / 독립 runtime
- GitHub 외 repository adapter
- durable append-only provenance 저장소
- 운영 UI / observability

이 제한 때문에 검증할 수 없는 프로젝트에서는 자동 범위를 넓히지 말고 Human 경계에서 멈춰야 합니다.
