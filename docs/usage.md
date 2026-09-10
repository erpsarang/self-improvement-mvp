# AI Development Framework 사용 가이드

이 문서는 **신규 프로그래밍 요구사항을 AI Development Framework v0.1에 넣어 실제 개발 사이클을 시작하는 방법**을 설명합니다.

## 1. 언제 사용하는가

다음과 같은 신규 개발 요구사항에 사용합니다.

- 기존 기능 개선
- 신규 API / 화면 / 배치 / 도메인 로직 추가
- 작은 버그 수정
- 테스트 추가
- SAP RAP 같은 실제 애플리케이션 개발 작업

핵심은 사람이 구현 방법을 세세하게 지시하는 것이 아니라 **무엇을 만들어야 하는지와 완료 조건을 명확히 정의하는 것**입니다.

## 2. 사람이 하는 일

사람의 필수 개입은 기본적으로 두 번입니다.

```text
① 시작 승인: Issue에 SI-승인
② 최종 승인: Human Merge PR을 사람이 Merge
```

중간의 IMPLEMENT, VERIFY, REVIEW, 제한된 FIX는 Framework가 자동으로 진행합니다.

## 3. 요구사항 Issue 작성

GitHub에서 **AI 개발 요구사항** Issue 템플릿을 선택합니다.

좋은 요구사항은 최소한 다음 다섯 가지를 포함합니다.

1. **목표** — 무엇을 만들거나 바꿀 것인가
2. **범위** — 어떤 기능과 파일/모듈이 대상인가
3. **완료 조건** — 무엇이 충족되면 완료인가
4. **검증 방법** — 어떤 test/build/check가 통과해야 하는가
5. **금지사항** — 건드리면 안 되는 범위가 있는가

예:

```markdown
## 목표
Sales Order 조회 API에 Sold-to Party 필터를 추가한다.

## 범위
- Sales Order 조회 조건
- 관련 테스트

## 완료 조건
- Sold-to Party를 입력하면 해당 주문만 조회된다.
- 기존 조회 조건의 동작은 바뀌지 않는다.
- 자동 테스트가 추가된다.

## 검증 방법
- npm test 통과
- npm run build 통과

## 금지사항
- 무관한 파일 수정 금지
- main 직접 push 금지
```

## 4. 요구사항을 고정하고 시작하기

Issue 본문을 최종 확인한 뒤 댓글에 정확히 다음 한 줄을 작성합니다.

```text
SI-승인
```

이 댓글이 Human Authorization 경계입니다.

`Trusted AUTHORIZE`는 승인 이벤트와 당시 요구사항, 기준 SHA를 provenance로 고정합니다. 승인 후 Issue 본문을 임의로 바꿔 다음 단계를 속이는 방식은 신뢰 근거로 사용하지 않습니다.

## 5. 자동 개발 흐름

승인 후 기본 흐름은 다음과 같습니다.

```text
SI-승인
→ AUTHORIZE
→ IMPLEMENT
→ SEAL
→ PUBLISH
→ VERIFY
→ Semantic REVIEW
```

### IMPLEMENT

Codex Worker가 실제 코드를 작성합니다. Worker는 **untrusted**이며 GitHub write credential을 받지 않습니다. 결과는 candidate artifact일 뿐 아직 신뢰된 코드가 아닙니다.

### SEAL

Trusted Rail이 candidate의 출처와 exact bytes를 검증하고 봉인합니다.

### PUBLISH

봉인된 candidate만 `ai-publish/issue-<N>` branch에 게시합니다. `main`에는 직접 쓰지 않습니다.

### VERIFY

게시된 branch 이름을 믿는 것이 아니라 실제 `publishedHeadSha`를 exact checkout하여 test/build/check를 수행합니다.

### Semantic REVIEW

승인 당시 요구사항과 exact verified SHA를 함께 보고 다음 셋 중 하나를 판단합니다.

| Decision | 의미 | 다음 행동 |
| --- | --- | --- |
| `PASS` | 요구사항을 충족 | `MERGE_READY` → Human Merge PR |
| `LOCAL_FIX` | 제한된 작은 수정으로 해결 가능 | FIX loop 자동 실행 |
| `STRUCTURAL_CHANGE` | 구조적 판단이나 요구사항 재정의 필요 | 자동 진행 중단, 사람 판단 |

## 6. LOCAL_FIX가 나오면

사람이 Codex에게 다시 직접 수정 지시를 내리지 않습니다.

```text
REVIEW = LOCAL_FIX
→ Trusted FIX Request
→ Untrusted FIX Worker
→ candidate
→ 다시 SEAL
→ PUBLISH
→ VERIFY
→ REVIEW
```

FIX Worker도 최초 IMPLEMENT와 동일하게 untrusted입니다. 수정 결과는 **반드시 전체 Trusted Rail을 다시 통과**해야 합니다.

v0.1에서 LOCAL_FIX는 최대 2회로 제한합니다. 무한 수정 loop를 허용하지 않습니다.

## 7. PASS가 나오면

Framework가 `MERGE_READY`로 전환하고 Human Merge PR을 생성합니다.

PR에는 검토를 통과한 exact reviewed SHA가 기록됩니다.

사람은 다음을 확인합니다.

- PR HEAD가 expected reviewed SHA와 일치하는가
- 변경 파일과 diff가 요구사항 범위 안인가
- 예상하지 못한 보안/운영 영향이 없는가
- Merge해도 되는가

문제가 없으면 사람이 직접 Merge합니다.

Framework는 Auto Merge하지 않습니다.

## 8. STRUCTURAL_CHANGE가 나오면

이 경우는 "AI가 알아서 더 크게 고쳐라"가 아닙니다.

예를 들면 다음 상황입니다.

- DB 구조 변경이 필요
- API 계약 자체를 바꿔야 함
- 여러 모듈의 책임 분리가 필요
- 요구사항이 서로 충돌
- 보안 또는 운영 정책 판단 필요

이때는 자동 loop를 멈추고 사람이 요구사항을 다시 설계해야 합니다. 필요하면 새 Issue로 분리한 뒤 다시 `SI-승인`부터 시작합니다.

## 9. 신규 요구사항 작성 원칙

Framework가 잘 동작하려면 요구사항은 **구현방법보다 완료조건 중심**으로 씁니다.

나쁜 예:

```text
foo.ts 31번째 줄에서 if문을 넣고 bar()를 호출해라.
```

좋은 예:

```text
취소된 주문은 출고 대상에서 제외되어야 한다.
완료조건:
- status=CANCELLED 주문은 출고 목록에 나타나지 않는다.
- 기존 정상 주문 조회에는 영향이 없다.
- 해당 동작을 검증하는 테스트가 추가된다.
```

구현 세부사항을 지나치게 고정하면 AI의 설계 여지를 없애고, 반대로 완료조건이 없으면 Reviewer가 무엇을 기준으로 PASS해야 할지 불명확해집니다.

## 10. 현재 v0.1의 한계

v0.1은 다음 경로를 실제 runtime으로 증명한 MVP입니다.

```text
Human 승인
→ AI IMPLEMENT
→ Trusted 검증
→ Semantic REVIEW
→ bounded FIX
→ 재검증
→ PASS
→ MERGE_READY
→ Human Merge
```

아직 범위 밖인 기능은 다음과 같습니다.

- PR 생성 이후 외부 `@codex review` 실패를 공식 FIX loop에 연결
- 범용 GRAPH Engine 전체 구현
- 장기 durable provenance 저장소
- 자동 Self-Improvement loop
- Auto Merge

따라서 v0.1은 **신규 요구사항을 안전한 AI 개발 사이클로 실행하는 최소 프레임워크**로 사용하고, 자동화 범위는 단계적으로 확장합니다.
