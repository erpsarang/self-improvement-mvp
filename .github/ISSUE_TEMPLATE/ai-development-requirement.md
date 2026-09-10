---
name: AI 개발 요구사항
about: AI Development Framework로 신규 개발 사이클을 시작할 때 사용합니다.
title: "[개발] "
labels: ""
assignees: ""
---

## 목표

<!-- 무엇을 만들거나 변경해야 하는지 결과 중심으로 작성합니다. -->


## 배경 / 사용자 가치

<!-- 왜 필요한지, 누구에게 어떤 문제가 있는지 간단히 작성합니다. -->


## 범위

<!-- 이번 Issue에 포함되는 기능, 모듈, 화면, API 등을 작성합니다. -->

- 

## 범위 밖

<!-- 이번 작업에서 의도적으로 하지 않을 것을 작성합니다. -->

- 

## 완료 조건

<!-- Reviewer가 PASS 여부를 판단할 수 있도록 관찰 가능한 조건으로 작성합니다. -->

- [ ] 
- [ ] 
- [ ] 

## 검증 방법

<!-- 실행해야 할 자동 테스트, build, lint, 기능 검증 등을 작성합니다. -->

- [ ] 기존 테스트 통과
- [ ] 신규/변경 동작을 검증하는 테스트 추가 또는 검증 근거 제시
- [ ] build/check 통과

## 금지사항 / 제약조건

<!-- 수정하면 안 되는 영역, 호환성, 보안, 성능 등의 제약이 있으면 작성합니다. -->

- 무관한 파일 수정 금지
- `main` 직접 push 금지
- 최종 Merge는 Human-only

## 참고자료

<!-- 관련 문서, 기존 Issue/PR, API 계약 등이 있으면 작성합니다. -->

- 

---

### 시작 방법

위 요구사항을 최종 확인한 뒤 `policy/trusted-approvers.yml`에 등록된 **trusted approver가 직접** Issue 댓글에 정확히 다음 한 줄을 작성합니다.

```text
SI-승인
```

그 이후 Framework가 `AUTHORIZE → IMPLEMENT → Trusted Rail → Semantic REVIEW → 필요 시 bounded FIX`를 진행합니다. REVIEW가 `PASS`이면 `MERGE_READY`와 Human Merge PR을 생성하고, `STRUCTURAL_CHANGE` 또는 FIX 한도 초과 시 `STOPPED`에서 사람의 판단을 기다립니다. 최종 Human Merge PR은 사람이 검토하고 직접 Merge합니다.
