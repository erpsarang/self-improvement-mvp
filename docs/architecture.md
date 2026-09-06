# 아키텍처

이 저장소의 MVP는 외부 자동화를 실행하는 시스템이 아니라, 이후 구현이 따라야 할 상태와 신뢰 경계를 고정하는 순수 도메인 모델이다.

```text
Human SI-승인
     ↓
Trusted AUTHORIZE
     ↓
Untrusted IMPLEMENT
     ↓
Trusted SEAL
     ↓
Trusted PUBLISH
     ↓
Exact SHA VERIFY
     ↓
Semantic Review
     ↓
LOCAL FIX <= 2
     또는
MERGE_READY / STOPPED
     ↓
Human Merge
```

`state.ts`는 위 흐름에서 이미 발생한 사건을 검증해 기록할 뿐, GitHub 또는 Codex를 호출하지 않는다. 특히 `RECORD_PUBLISHED`는 PUBLISH 구현이 아니라 Trusted Rail이 반환할 immutable `published_head_sha`를 상태에 기록하는 경계다. `PASS`도 `MERGE_READY`까지만 이동하며 merge 실행은 포함하지 않는다.

## 구성 요소

- `authorization.ts`: `SI-승인`, trusted approver, policy version을 검사하고 authorization provenance를 생성한다.
- `state.ts`: 허용된 전환, exact SHA, FIX 횟수 제한을 적용한다.
- `review-decision.ts`: `PASS`, `LOCAL_FIX`, `STRUCTURAL_CHANGE`만 review decision으로 허용한다.
- `policy/trusted-approvers.yml`: 실시간 collaborator 조회를 대신하는 versioned policy다.

GitHub Actions, Codex 호출, branch/PR 생성, write token, artifact SEAL, checkout, Semantic Review 호출, Candidate Generator, PUBLISH 및 Auto Merge는 의도적으로 범위에서 제외한다.
