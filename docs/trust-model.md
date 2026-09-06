# Trust Boundary

## Untrusted execution

`IMPLEMENT`와 `FIX`는 untrusted 영역이다. 이 영역에는 GitHub write credential을 제공하지 않으며, 산출한 candidate patch를 직접 PUBLISH할 수 없다.

## Trusted execution

`AUTHORIZE`, `SEAL`, `PUBLISH`는 Trusted Rail이 담당한다. `AUTHORIZE`는 repository에서 version 관리되는 trusted approver policy를 사용하며 live collaborator permission에 의존하지 않는다. 승인 provenance에는 재조회한 approval, approver, exact policy digest, 승인 시각, repository와 trusted workflow run identity를 보존하고, 신뢰 원본은 Issue comment가 아니라 Actions artifact이다.

candidate patch는 trusted `SEAL`을 거쳐야만 PUBLISH 대상으로 간주된다. 현재 MVP는 이 경계를 상태 전환으로 강제할 뿐 실제 SEAL 또는 PUBLISH를 실행하지 않는다.

## 검증과 검토

`VERIFY`는 immutable `published_head_sha`와 실제 검증 대상 SHA의 exact match만 성공시킨다. Semantic Review에는 이 검증을 통과한 동일 SHA만 입력할 수 있다.

## Merge

`MERGE_READY`는 merge 가능한 상태이지 merge 완료가 아니다. Merge는 Human-only이며 Auto Merge 기능과 GitHub write 동작은 존재하지 않는다. `RECORD_HUMAN_MERGE`는 외부에서 Human merge가 완료됐다는 사실만 기록한다.
