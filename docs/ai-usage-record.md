# AI invocation 관측 레코드: 내부 계약 v2

이번 slice는 외부 서비스와 독립적인 입력 검증과 순수 집계 함수만 제공한다. 실제 실행 evidence의 취득·파싱·인증, cycle 자동 연결, 사용자 화면 및 workflow 연동은 포함하지 않는다. 이 레코드만으로 실제 cycle 사용량 수집이 완료되었다고 주장할 수 없다.

## 입력 계약

`src/ai-usage-record.ts`의 `aggregateAiUsageRecord(input)`은 다음 입력을 검증하고 새 레코드를 반환한다.

```ts
{
  cycleRef: string,
  observations: Array<{
    stage: AiUsageStage,
    sourceRef: string,
    model: string | null,
    tokenUsage: number | null
  }>
}
```

모든 필드는 필수이며 추가 필드는 거부한다. 객체는 일반 객체 또는 null prototype 객체여야 한다. 관측 목록이 누락되면 오류이고 명시적인 빈 배열은 허용한다. 잘못된 입력과 충돌 관측은 `TypeError`로 거부한다.

- `cycleRef`, `sourceRef`: 공백만으로 이루어지지 않은 문자열이다. 공백을 포함한 원본 문자열을 보존하며 참조 생성, URL 해석, 정규화 또는 존재 여부 확인을 하지 않는다.
- `stage`: `PLAN`, `IMPLEMENT`, `SEMANTIC_REVIEW`, `LEARN`, `PRODUCT_EVALUATION` 중 하나다.
- `model`: 해당 invocation의 시작 배너에서 관측한 모델 문자열 또는 미확인을 뜻하는 `null`이다. 문자열은 공백만으로 이루어질 수 없으며 원본을 보존한다. 모델 목록이나 설정 기본값으로 보완하지 않는다.
- `tokenUsage`: 같은 invocation 종료부의 `tokens used`에서 관측한 0 이상의 안전 정수 또는 `null`이다. 숫자 문자열, 소수, 음수, NaN, Infinity, 안전 정수 범위 초과를 거부한다. 0은 알려진 사용량이며 미확인이 아니다. 음의 0은 0으로 정규화한다.

모델과 토큰은 각각 독립적으로 `null`일 수 있다. invocation 경계나 두 값의 대응이 불명확하면 수집기가 확인할 수 없는 값을 `null`로 제공해야 한다. 집계기는 로그를 읽거나 대응 관계를 검증하지 않는다.

## 출력과 중복 처리

출력은 `schemaVersion: 2`, 원본 `cycleRef`, 위 고정 stage 순서의 `stages` 배열을 갖는다. v1의 stage 단위 `model`, `tokenUsage`를 제거하고 invocation 목록으로 옮겼다. 기존 입력에도 이제 `model`, `tokenUsage`를 명시해야 하며, 알 수 없으면 `null`을 사용한다.

| stage 필드 | 의미 |
| --- | --- |
| `stage` | 허용된 stage 식별자 |
| `sourceRefs` | 중복 제거하고 정렬한 원본 참조 목록 |
| `invocations` | 같은 순서의 `{ sourceRef, model, tokenUsage }` 목록 |
| `observedStageInvocationCount` | 서로 다른 참조로 식별된 관측 수. 관측이 없으면 `null` |
| `providerCallCount` | 모든 관측의 model과 tokenUsage가 알려졌을 때의 invocation 수. 하나라도 불완전하거나 관측이 없으면 `null` |
| `monetaryCost` | 항상 `null` |

서로 다른 모델이 사용된 invocation도 각 모델과 토큰을 그대로 보존한다. 대표 모델을 선택하거나 stage 토큰 합계를 계산하지 않는다. 불완전 관측 때문에 다른 invocation의 알려진 값이 사라지지 않는다.

한 입력 cycle에서 `sourceRef`는 invocation 하나를 식별한다. 동일 sourceRef의 stage, model, tokenUsage가 모두 같으면 한 번만 센다. 하나라도 다르면 입력 전체를 거부한다. 따라서 다른 stage에 같은 sourceRef를 재사용해도 충돌이다. `null`과 알려진 값의 조합도 충돌이며 자동 보완하거나 마지막 값을 선택하지 않는다. 수집기는 충돌을 해결한 관측 하나를 제공해야 한다. cycle 간 상태는 유지하거나 병합하지 않는다.

참조는 locale에 의존하지 않는 UTF-16 코드 단위 문자열 비교 순서로 정렬한다. `serializeAiUsageRecord(input)`은 같은 검증·집계 후 고정된 필드 순서로 JSON을 반환한다. 입력 순서와 동일 관측의 중복 추가는 결과를 바꾸지 않는다. 두 함수는 입력을 변경하거나 입력 객체의 가변 참조를 보존하지 않으며 외부 I/O나 AI 호출을 수행하지 않는다.

## sourceRef와 신뢰 경계

trusted 수집기의 cycle identity 권위는 repository와 requirement Issue number다. 같은 Issue의 re-PLAN, retry, repair 및 post-merge LEARN/Product Evaluation은 같은 cycle에 속한다. PR 번호와 merge SHA는 provenance로 연결하며 cycle identity를 바꾸지 않는다. 집계기는 이를 해석하거나 인증하지 않는다.

권위 있는 원본은 완료된 GitHub Actions run/job의 raw job log다. 수집기는 repository, run id, job id, invocation ordinal을 확인해야 한다. 권장 sourceRef 형식은 다음과 같다.

```text
github-actions-job-log://<owner>/<repo>/run/<runId>/job/<jobId>#codex-<ordinal>
```

하나의 job에 여러 invocation이 있으면 각각 다른 참조가 필요하다. 동일 invocation을 다시 관측하면 같은 참조를 사용한다. 집계기는 이 형식을 강제하지 않으며 문자열의 존재만으로 evidence를 인증하지 않는다.

trusted 수집기가 대상으로 삼을 workflow/job 계약은 다음과 같다.

| stage | workflow / job |
| --- | --- |
| PLAN | Read-only AI PLAN / plan |
| IMPLEMENT | PLAN Bounded IMPLEMENT Worker / attempt0, timeout_retry, repair1, repair2의 실제 실행 |
| SEMANTIC_REVIEW | Trusted Rail / Semantic REVIEW / isolated AI Semantic Reviewer |
| LEARN | Read-only AI LEARN / isolated read-only AI Learner |
| PRODUCT_EVALUATION | Trusted Product Evaluation / isolated read-only AI Product Evaluator |

skipped job은 호출로 세지 않는다. workflow의 모델 설정, prompt 문자열, AI가 생성한 설명은 실제 사용량 evidence가 아니다. Codex 출력은 untrusted data이며 실제 시작 배너와 종료 usage를 구분하는 책임은 수집기에 있다. 예상값을 이 관측 계약에 제출하지 않는다.

## 부분 관측과 비용 미확인

`providerCallCount`는 이 evidence 계약에서 model 배너와 종료 usage가 짝지어진 실행 블록의 수다. 내부 제공자 API 요청 수를 측정하는 필드가 아니다. 불완전한 invocation이 하나라도 있으면 완전한 invocation만 센 부분 합계를 반환하지 않는다. `observedStageInvocationCount`는 그 경우에도 제공된 관측 수를 보존한다.

관측 없는 stage의 `null`은 미확인이며 실행 횟수 0을 뜻하지 않는다. 모든 제공 관측이 완전해도 cycle 전체의 수집 완전성을 보장하지 않는다. 참조 재사용이나 동일 실행에 대한 서로 다른 참조 때문에 과소·과대 집계가 생길 수 있으며 집계기는 이를 인증할 수 없다.

현재 로그에는 실제 청구 금액의 권위 있는 근거가 없으므로 `monetaryCost`는 항상 `null`이다. 토큰 0이나 빈 목록에도 비용 0을 부여하지 않는다. 가격표 적용, 추정, 역산 및 금액 입력을 지원하지 않는다.

## 후속 범위와 검증

이 레코드는 기존 #259 비용 비교 입력 형식이 아니다. 검증된 어댑터 없이 직접 제출하거나 `measured` 비용으로 표시하지 않는다. 후속 범위는 raw log 취득·파싱·인증, exact SHA 및 run/job provenance 확인, cycle 연결, 수집 완전성 확인, 사용자 화면과 실제 비용 비교 연결 및 실제 cycle 검증이다.

이번 slice는 모델·effort, AI 호출, retry/fallback, 실행 정책 및 승인 흐름을 변경하지 않는다. 기존 exact SHA/provenance, deterministic CI, Semantic REVIEW, Human-only Merge 및 Auto Merge 금지 원칙을 유지한다. 이 evidence는 자동 승인이나 merge 권한이 아니다.

테스트는 v2 반환 shape, invocation별 값과 출처 보존, 중복·충돌, 불완전 관측, 미관측, 결정적 직렬화, 입력 검증 및 불변성을 다룬다. 저장소 검증 명령은 `npm test`이며 이번 변경안 생성 과정에서는 실행하지 않았다.
