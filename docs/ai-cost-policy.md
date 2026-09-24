# AI 설정 기준선과 로컬 비용 비교

이번 slice는 호출 설정의 관측 목록과 로컬 비교 계산만 제공합니다. 실행 정책을 적용하거나 workflow에 모듈을 연결하지 않습니다. 추가 AI 호출, 네트워크 호출, 사용량 수집, 모델 변경 및 자동 fallback은 없습니다.

## 설정 기준선

`src/ai-execution-baseline.ts`는 기준 SHA `7d8a4fd53647e2498a6c38e0442ab61c849601a8`에서 제공된 workflow 발췌를 기록합니다.

| stageId | workflow | 모델 설정 | 확인된 effort |
| --- | --- | --- | --- |
| plan | .github/workflows/plan.yml | 미명시 | medium |
| bounded-implement | .github/workflows/plan-implement-worker.yml | 미명시 | low |
| implement | .github/workflows/implement.yml | 미명시 | medium |
| fix | .github/workflows/fix-worker.yml | 미명시 | 미확인 |
| semantic-review | .github/workflows/semantic-review.yml | 미명시 | medium |
| learn | .github/workflows/learn.yml | 미명시 | medium |
| product-evaluation | .github/workflows/product-evaluation.yml | 미명시 | medium |

모델의 `unspecified`는 제공된 설정에 모델 명시가 없다는 뜻입니다. FIX의 effort `unknown`은 기본 effort를 추정하지 않는다는 뜻입니다. 모든 `actualModel`은 `unknown`입니다. 이 목록은 실제 실행 모델, 전체 workflow 내용 또는 action의 기본 동작을 증명하지 않습니다.

사용자가 보고한 Astra 중심 실행은 실제 모델이 확인된 실행 기록을 확보한 후 해당 실행을 baseline으로 라벨링해야 합니다. 현재 목록만으로 `action-default`가 어떤 모델인지 단정하거나 Astra 가격을 적용하지 않습니다.

## 입력 계약

`src/ai-cost-comparison.ts`의 `compareRuns(baseline, candidate)`는 외부 서비스에 의존하지 않는 동기 함수입니다. `RunInput` 타입을 제공하며 실제 호출에서는 두 인자를 모두 런타임 검증합니다. JSON과 같은 로컬 데이터 객체를 입력합니다. 지정 필드 누락과 추가 필드는 거절합니다.

- `cycleId`, `workloadKey`, `policyLabel`, `currency`: 공백만으로 구성되지 않은 문자열입니다. 문자열은 자동 정규화하지 않습니다. cycleId와 policyLabel은 두 실행에서 달라도 됩니다.
- `measurementKind`: `expected` 또는 `measured`입니다. 입력 제공자가 구분하는 값이며 함수가 실측 여부를 검증하지는 않습니다.
- `unitScale`: 1 이상의 안전 정수입니다. 통화 1단위당 정수 비용 단위 수입니다. 예를 들어 USD와 unitScale=1000에서 costUnits=120은 0.12 USD입니다. 환율 변환은 하지 않습니다.
- `stages`: 위 일곱 stageId를 정확히 한 번씩 포함합니다. 배열 순서는 자유롭습니다. 각 항목은 `stageId`, `callCount`, `costUnits`만 갖습니다.
- `callCount`: 0 이상의 안전 정수입니다. 같은 단계의 반복 호출은 이 값과 단계 비용에 합산합니다.
- `costUnits`: 0 이상의 안전 정수 또는 `null`입니다. 미확인 비용은 `null`로 입력합니다. 미호출 단계는 반드시 callCount=0, costUnits=0입니다. 호출이 있었지만 알려진 비용이 0인 경우에는 양수 callCount와 costUnits=0을 허용합니다.
- `quality`: `planQuality`, `implementationSuccess`, `deterministicCi`, `semanticReview`, `humanMergeJudgment` 다섯 필드를 모두 갖습니다. 각 값은 `pass`, `fail`, `unknown`입니다. 미관측은 필드 생략 대신 `unknown`입니다.

두 실행의 workloadKey, measurementKind, currency, unitScale은 정확히 일치해야 합니다. 예상치와 실측치는 서로 비교하지 않습니다. 같은 workloadKey라는 입력만으로 업무 난이도나 실험 조건의 동등성을 입증하지는 못합니다. 비용 및 호출 수는 외부 API의 사용량 필드가 아니라 사용자가 제공하는 로컬 집계값입니다.

숫자 문자열, 소수, 음수, NaN, Infinity, 안전 정수 범위 초과는 거절합니다. unitScale=0도 거절합니다. 알려진 전체 비용과 전체 호출 수를 합산한 결과가 안전 정수 범위를 초과하면 RangeError를 발생시킵니다. 그 외 계약 오류는 TypeError입니다. 일부 비용이 미확인이면 해당 실행의 비용 합계를 계산하지 않습니다.

## 결과 계약

결과는 실행 식별 정보와 비교 단위, 기준 목록 순서의 `stages`, `totals`, 독립적인 `quality`를 제공합니다. 입력을 변경하지 않습니다.

비용 차이 `deltaCostUnits`는 candidate-baseline입니다. 음수면 비용 감소입니다. `savingsPercent`는 (baseline-candidate)/baseline×100이며 소수 근삿값입니다. 비용 증가에서는 음수, 비용이 같으면 0입니다. 단계별 비용과 전체 비용에 같은 계산 규칙을 적용합니다. 호출 수 차이 `deltaCallCount` 역시 candidate-baseline입니다.

각 실행의 전체 비용은 일곱 비용이 모두 알려진 경우에만 산출합니다. 한쪽에 누락 비용이 있어도 다른 쪽의 완전한 전체 비용은 유지합니다. 부분 합계는 전체 비용으로 표시하지 않습니다. 어느 쪽이든 비용이 누락되면 차이와 절감률은 null이고 사유는 `missing-cost`입니다. `missingCostSides`는 누락된 쪽, totals의 `missingCosts`는 누락된 쪽과 stageId를 함께 제공합니다. 누락 비용이 없다면 기준선 비용 0에서 차이는 계산하되 절감률만 null, 사유는 `zero-baseline-cost`입니다. 두 사유가 겹치면 `missing-cost`를 우선합니다. 비용 누락은 알려진 단계의 비교나 호출 수 집계를 막지 않습니다.

품질 결과는 다음을 따로 표시합니다.

- `observations`: 다섯 항목 각각의 baseline/candidate 상태.
- `regressions`: baseline pass → candidate fail 항목.
- `candidateFailures`: 기준선 상태와 무관한 후보 fail 항목.
- `unknownItems`: 어느 한쪽이라도 unknown인 항목.
- `comparisonStatus`: unknown 항목이 하나라도 있으면 `insufficient`, 없으면 `sufficient`.

`sufficient`는 관측이 채워졌다는 뜻이며 품질 통과를 뜻하지 않습니다. fail → fail도 후보 실패입니다. unknown → fail은 회귀 확정 없이 후보 실패와 미확인에 모두 포함됩니다. unknown이 다른 항목의 관측된 회귀 신호를 가리지 않습니다. 절감률과 품질 상태를 결합한 성공 점수나 자동 승인 결과는 제공하지 않습니다.

## 합성 예제와 실행 방법

다음은 저장소 루트에서 기존 tsx를 통해 실행할 수 있는 완전한 로컬 예제입니다. 의존성이 준비된 환경을 전제로 합니다. 아래 숫자와 상태는 모두 합성이며 모델 가격이나 실제 품질 관측이 아닙니다.

```sh
node --import tsx --input-type=module <<'JS'
import { STAGE_IDS } from './src/ai-execution-baseline.ts';
import { compareRuns } from './src/ai-cost-comparison.ts';

const baseline = {
  cycleId: 'synthetic-before',
  workloadKey: 'synthetic-same-workload',
  policyLabel: 'synthetic-baseline',
  measurementKind: 'expected',
  currency: 'USD',
  unitScale: 1000,
  stages: STAGE_IDS.map(stageId => ({ stageId, callCount: 1, costUnits: 100 })),
  quality: {
    planQuality: 'pass',
    implementationSuccess: 'pass',
    deterministicCi: 'pass',
    semanticReview: 'pass',
    humanMergeJudgment: 'pass',
  },
};
const candidate = {
  ...baseline,
  cycleId: 'synthetic-after',
  policyLabel: 'synthetic-candidate',
  stages: baseline.stages.map(stage => ({ ...stage, costUnits: 80 })),
  quality: { ...baseline.quality, humanMergeJudgment: 'unknown' },
};
console.log(JSON.stringify(compareRuns(baseline, candidate), null, 2));
JS
```

예제의 전체 비용은 700 → 560 units, 차이는 -140 units, 절감률은 20%, 호출 수 차이는 0입니다. 동시에 품질 비교는 humanMergeJudgment 미확인으로 `insufficient`입니다. 이 결과는 실제 절감이나 품질 무회귀의 근거가 아닙니다.

검증 명령은 `npm test`입니다. 제공된 package.json에 따라 TypeScript 검사 후 테스트를 실행합니다. 추가 테스트는 입력 계약, 합계 범위, 0/누락 비용, 비교 방향, 단계 식별 및 모든 품질 상태 전이를 다룹니다. 이번 변경안 생성 과정에서는 명령이나 테스트를 실행하지 않았습니다.

## 한계와 후속 범위

이번 slice는 요구 전체 중 설정 기준선과 비교 계산을 다룹니다. 단계별 명시적 모델 정책, 실제 비용 절감, 품질 유지 검증은 아직 완료하지 않았습니다. 함수는 호출 증빙, 모델 ID, 토큰 사용량, 가격, workload 동등성, 품질 관측의 진위를 검증하지 않습니다. policyLabel은 설명용 문자열이며 실행 설정이나 provenance가 아닙니다.

후속 작업에서는 공식 모델 식별자, 지원 effort, 가격 및 실제 사용량 출처를 확인한 뒤 단계별 명시적 실행 정책과 예상 비용 산출을 구현해야 합니다. 실제 cycle의 모델·사용량·비용·품질 기록을 연결하고 확인된 Astra 중심 실행과 동일 조건으로 비교해야 합니다. 제한된 모델 하향 실험에는 품질 문제 관측 시 상위 모델로 복귀하거나 fallback하는 명시적 정책이 필요합니다. 실제 App cycle에서 PLAN 품질, 구현 성공률, deterministic CI, Semantic REVIEW, Human Merge 판단의 회귀 여부를 먼저 확인한 뒤 적용 범위를 확대합니다. deterministic 처리에 불필요한 AI 호출을 추가하지 않습니다.

기존 workflow, action 참조, 모델/effort, 권한, 토큰, 실행 조건, timeout은 변경하지 않습니다. 기존 Trust Boundary, exact SHA/provenance, deterministic CI, Semantic REVIEW와 Human-only Merge를 유지합니다. 이 비교 결과는 정책 적용, 실행 승인 또는 Merge 승인이 아니며 Auto Merge를 도입하지 않습니다.
