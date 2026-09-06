# self-improvement-mvp

검증된 Self-Improvement 구조만 남긴 clean MVP 실험 저장소입니다.

## 목표

Human의 시작 승인 1회 이후, 최종 Merge 직전까지의 Self-Improvement 흐름을 신뢰 경계와 exact SHA 검증을 유지한 채 자동화합니다.

```text
Issue
→ Human: SI-승인
→ AUTHORIZE
→ IMPLEMENT
→ SEAL
→ PUBLISH
→ VERIFY exact published HEAD
→ SEMANTIC REVIEW
→ 필요 시 FIX <= 2
→ MERGE_READY / STOPPED
→ Human Merge
```

## 핵심 원칙

- Human start는 `SI-승인` 1회
- 최종 Merge는 Human-only
- `IMPLEMENT` / `FIX`에는 GitHub write credential 없음
- untrusted candidate patch는 trusted `SEAL` 이후에만 처리
- `PUBLISH`는 Trusted Rail만 수행
- `VERIFY`는 exact published HEAD SHA 기준
- Semantic Review는 verified SHA만 검토
- `FIX`는 최대 2회
- Auto Merge 금지
- live collaborator permission 대신 versioned trusted approver policy 사용
- `LOCAL FIX`와 `STRUCTURAL CHANGE`를 구분
- 이후 Candidate Generator를 연결해 closed self-improvement loop 완성

## Trust Boundary

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

## 현재 단계

Phase 0부터 시작합니다.

먼저 상태 머신, trust model, invariant를 정의하고 테스트로 고정한 뒤 실제 GitHub Actions와 Codex 실행을 연결합니다.
