# AI stage 관측 레코드: 내부 계약 v1

이번 slice는 외부 서비스와 독립적인 내부 입력 계약과 순수 집계 함수만 정의한다. 실제 실행 evidence를 자동 취득하는 수집기는 포함하지 않는다. 이 레코드만으로 Canonical 또는 App의 실제 cycle 사용량 수집이 완료되었다고 주장할 수 없다.

## 입력과 출력

`src/ai-usage-record.ts`의 `aggregateAiUsageRecord(input)`은 다음 입력을 검증하고 새 레코드를 반환한다.

```ts
{
  cycleRef: string,
  observations: Array<{ stage: AiUsageStage, sourceRef: string }>
}
```

`cycleRef`와 `sourceRef`는 공백만으로 이루어지지 않은 문자열이어야 한다. 원본 문자열은 공백을 포함해 그대로 보존한다. URL 해석, 정규화, 참조 생성 또는 존재 여부 확인은 하지 않는다. 객체에는 정의된 필드만 허용하며, 잘못된 입력은 `TypeError`로 거부한다. 관측 목록 자체가 누락되면 오류이고, 명시적인 빈 목록은 허용한다.

stage는 `PLAN`, `IMPLEMENT`, `SEMANTIC_REVIEW`, `LEARN`, `PRODUCT_EVALUATION`으로 제한한다. 출력은 `schemaVersion: 1`, 원본 `cycleRef`, 위 고정 순서의 `stages` 배열을 갖는다. 각 stage 항목은 다음 필드를 갖는다.

| 필드 | 의미 |
| --- | --- |
| `stage` | 허용된 stage 식별자 |
| `sourceRefs` | 해당 stage의 중복 제거된 원본 참조 목록 |
| `observedStageInvocationCount` | 참조로 구분되는 관측 실행 수. 관측이 없으면 `null` |
| `providerCallCount` | 항상 `null` |
| `model` | 항상 `null` |
| `tokenUsage` | 항상 `null` |
| `monetaryCost` | 항상 `null` |

동일 입력 cycle 내 `(stage, sourceRef)`가 같은 관측은 한 번만 센다. 같은 참조가 다른 stage에 있으면 별도로 집계한다. cycle 간 상태는 유지하거나 병합하지 않는다. 참조 목록은 locale에 의존하지 않는 UTF-16 코드 단위 문자열 비교 순서로 정렬한다.

`serializeAiUsageRecord(input)`은 같은 입력 검증 및 집계를 거친 뒤 고정된 필드 순서로 JSON 문자열을 반환한다. 입력 순서 또는 중복 관측의 추가는 직렬화 결과를 바꾸지 않는다. 두 함수 모두 입력을 변경하지 않으며 외부 I/O나 AI 호출을 수행하지 않는다.

## sourceRef와 신뢰 경계

trusted 호출자는 실제로 실행된 stage의 증거만 입력해야 한다. stage 설정, 실행 예정 상태, 모델 설정값 또는 AI가 생성한 설명은 실제 실행이나 사용량을 입증하지 않는다. 문자열 검증 성공은 증거의 진위나 신뢰성을 보증하지 않는다.

`cycleRef`는 호출자가 정확히 식별한 하나의 cycle을 가리켜야 한다. `sourceRef`는 그 cycle의 해당 stage에서 개별 실행 하나를 정확히 식별해야 하며, 동일 실행을 다시 관측했을 때 같은 문자열을 제공해야 한다. 서로 다른 실행에는 서로 다른 참조가 필요하다. 예를 들어 하나의 run/job/artifact에 여러 실행이 들어 있으면 그 공유 참조만으로 개별 실행을 식별할 수 없다. 수집기는 실행을 구분하는 정확한 증거 참조를 제공해야 한다. 이 문서는 외부 서비스의 참조 형식이나 URL 구조를 정의하지 않는다.

증거 취득과 인증, exact SHA 및 run/job/artifact provenance 확인, cycle 연결, 개별 실행 식별과 참조의 안정성은 후속 trusted 수집기의 책임이다. 집계기는 잘못 재사용한 참조나 동일 실행에 붙인 서로 다른 참조를 판별하지 못한다. 전자는 과소 집계, 후자는 과대 집계를 만들 수 있다.

## 부분 관측의 한계

`observedStageInvocationCount`는 제공된 증거에서 관측한 stage 실행 수다. stage 실행 하나와 제공자 API 호출 하나는 같다고 가정하지 않는다. 관측이 없는 stage의 `null`은 미확인을 뜻하며 실행 횟수 0을 뜻하지 않는다. 관측이 있는 stage도 전체 실행이 수집되었음을 보장하지 않는다. 따라서 이 레코드를 완전한 cycle의 총 호출 수로 해석하면 안 된다.

이번 계약은 실제 model/token 증거를 입력받거나 추출하지 않는다. `providerCallCount`, `model`, `tokenUsage`, `monetaryCost`는 관측 유무와 무관하게 항상 `null`이다. 이 필드를 입력 관측에 추가하면 거부한다. 가격을 추정하거나 역산하지 않으며 금액도 계산하지 않는다.

## 후속 범위와 #259

이 필드들은 새 내부 계약이며 외부 API 필드 또는 기존 #259 비용 비교 입력 형식이 아니다. 후속 #259 어댑터가 검증되기 전에는 이 레코드를 기존 비용 비교 입력에 직접 제출하거나 `measured` 비용으로 표시하지 않는다. 참조 문자열의 존재만으로 #259의 신뢰 요건을 충족한다고 주장하지 않는다.

후속 범위는 trusted 실행 증거의 자동 취득과 workflow 연동, cycle 간 정확한 연결, 관측 완전성 확인, 실제 모델·토큰 추출, #259 measured/sourceRef 어댑터, Canonical 실제 cycle 검증 및 App sync다. 이번 slice는 AI 모델·effort, 실행 조건, retry/fallback, 호출 수, 실행 결과 또는 승인 판단을 변경하지 않는다. 기존 exact SHA/provenance, deterministic CI, Semantic REVIEW, Human-only Merge 및 Auto Merge 금지 원칙을 유지한다.

검증 대상은 출처 보존, 고정 직렬화 순서, 중복 제거, 미관측 처리, 입력 거부 및 입력 불변성이다. 저장소 검증 명령은 `npm test`이며, 이 변경안 생성 과정에서는 실행하지 않았다.
