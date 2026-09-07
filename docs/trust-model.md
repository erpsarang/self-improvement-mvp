# Trust Boundary

## Untrusted execution

`IMPLEMENT`와 `FIX`는 untrusted 영역이다. 이 영역에는 GitHub write credential을 제공하지 않으며, 산출한 candidate patch를 직접 PUBLISH할 수 없다.

## Trusted execution

`AUTHORIZE`, `SEAL`, `PUBLISH`는 Trusted Rail이 담당한다. `AUTHORIZE`는 repository에서 version 관리되는 trusted approver policy를 사용하며 live collaborator permission에 의존하지 않는다. Policy는 재사용 가능한 login 대신 immutable GitHub numeric user ID를 권한 identity로 사용하고 login은 설명 메타데이터로만 보존한다. 승인 provenance에는 재조회한 approval, approver ID와 현재 login, exact policy digest, 승인 시각, repository와 trusted workflow run/creation-attempt identity를 보존하고, 신뢰 원본은 Issue comment가 아니라 Actions artifact이다.

Actions artifact는 현재 운영 단계의 trust anchor이며 영구 ledger가 아니다. retention 만료 후 장기 provenance 감사까지 보장하지 않으며, durable/append-only provenance는 후속 Framework 설계 과제이다(TODO).

candidate patch는 trusted `SEAL`을 거쳐야만 PUBLISH 대상으로 간주된다. `SEAL`은 candidate code를 실행하거나 적용하지 않고 source identity, base SHA, provenance 구조와 exact bytes digest를 검증해 `sealed.patch + seal.json`을 만든다.

`PUBLISH`는 같은 Trusted Rail 내부의 별도 job이며 오직 이 sealed artifact만 입력으로 받는다. workflow 전체나 `SEAL` job에는 write 권한을 주지 않고 `PUBLISH` job에만 `contents: write`를 부여한다. PUBLISH는 exact `baseSha`의 별도 worktree에 sealed patch를 적용하고 `ai-publish/issue-<N>` branch에만 force 없이 publish한다. `main`에는 직접 push하지 않으며, 실제 remote branch SHA를 다시 조회해 exact match한 값을 `publish.json.publishedHeadSha`로 기록한다.

PUBLISH 재실행은 동일 base와 동일 tree의 기존 published commit만 idempotent하게 재사용할 수 있다. 기존 publish branch가 예상하지 않은 SHA를 가리키면 non-fast-forward overwrite를 시도하지 않고 fail-closed 한다.

## 검증과 검토

`VERIFY`는 immutable `published_head_sha`와 실제 검증 대상 SHA의 exact match만 성공시킨다. Semantic Review에는 이 검증을 통과한 동일 SHA만 입력할 수 있다. `VERIFY`와 Semantic Review는 아직 후속 구현 범위이다.

## Merge

`MERGE_READY`는 merge 가능한 상태이지 merge 완료가 아니다. Merge는 Human-only이며 Auto Merge 기능은 존재하지 않는다. Trusted PUBLISH의 GitHub write 권한은 publish branch 생성/fast-forward에만 사용하며 merge 권한으로 사용하지 않는다. `RECORD_HUMAN_MERGE`는 외부에서 Human merge가 완료됐다는 사실만 기록한다.
