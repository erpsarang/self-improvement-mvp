# Issue #19 — Trusted PUBLISH smoke test

이 문서는 Phase 3 병합 후 실제 GitHub Actions에서 사용하는 smoke test의
candidate 변경이다. 실행 성공을 증명하는 결과 기록은 아니다.
현재 IMPLEMENT는 빈 candidate patch를 거부하므로 이 문서를 변경 대상으로 사용한다.

## 실행 경계

시작 승인은 사람이 Issue #19에 직접 `SI-승인` 댓글을 작성한다.
승인된 흐름은 다음과 같다.

```text
Human SI-승인 → Trusted AUTHORIZE → Untrusted IMPLEMENT → Trusted SEAL → Trusted PUBLISH
```

Untrusted Implementer는 작업 디렉터리의 파일 변경과 기존 테스트 실행만 수행한다.
SEAL 및 PUBLISH는 Trusted Rail이 담당한다. VERIFY, REVIEW, MERGE_READY는
이 작업에서 수행하지 않으며 최종 Merge는 Human-only이다.

## 실제 Actions 실행에서 확인할 증거

- Trusted AUTHORIZE가 성공한다.
- Untrusted IMPLEMENT가 성공하거나 설계된 valid no-op으로 종료한다.
- Trusted Rail의 SEAL과 PUBLISH가 성공한다.
- `ai-publish/issue-19` branch가 생성되거나 정확하게 idempotent reuse된다.
- `publish.json` artifact가 생성된다.
- `publish.json`의 `publishedHeadSha`가 실제 remote publish branch HEAD와 exact match한다.
- `main` 직접 push와 Auto Merge가 없다.

로컬 테스트 통과만으로 위 성공 조건이 충족되었다고 판정하지 않는다.

## 실패 시 Stop Policy

Trust Boundary 위반, provenance 오결합, 예상치 못한 write,
non-fast-forward overwrite, runtime blocker만 즉시 수정 대상으로 본다.
스타일, 리팩터링, P2 이하 제안은 후속 후보로 미룬다.
