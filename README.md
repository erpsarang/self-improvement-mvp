# AI Development Framework MVP

AI를 이용해 소프트웨어의 요구사항 해석, 설계, 구현, 검증, 리뷰, 수정, 공개, 학습, 자기개선을 하나의 **신뢰 가능한 반복 개발 프레임워크**로 연결하는 실험 저장소입니다.

저장소 이름은 현재 `self-improvement-mvp`이지만 프로젝트의 주어는 **AI Development Framework MVP**입니다. Self-Improvement는 프레임워크 전체가 아니라 개발 결과와 실행 방식을 개선하는 하위 `SELF-IMPROVEMENT` capability입니다.

```text
REQUIREMENT
→ PLAN
→ IMPLEMENT
→ SEAL
→ PUBLISH
→ VERIFY
→ REVIEW
→ 필요 시 FIX → SEAL → PUBLISH → VERIFY → REVIEW
→ PASS → MERGE_READY → Human Merge (Human-only)
검토 결과·provenance ── 별도 후속 흐름 ──→ LEARN → IMPROVE → LOOP
```

이 흐름은 특정 애플리케이션이나 AI 실행 도구에 종속되지 않습니다. 현재의 작은 도메인 모델에서 시작해 향후 SAP RAP 같은 실제 개발 대상에도 같은 신뢰 원칙을 적용하는 것이 목표입니다.

## 프레임워크 구조

```text
AI Development Framework
├─ Core
│  ├─ GRAPH Engine       개발 단계와 의존 관계를 연결
│  ├─ LOOP Engine        실행·피드백·개선 주기를 반복
│  ├─ Trust Model        실행 권한과 신뢰 경계를 통제
│  ├─ Human Approval     시작 승인과 최종 Merge를 보장
│  ├─ State Model        허용된 상태와 전환을 강제
│  └─ Provenance         승인·산출물·검증 대상의 근거를 보존
├─ Agents / Roles
│  ├─ Planner
│  ├─ Implementer
│  ├─ Verifier
│  ├─ Reviewer
│  └─ Improver
└─ Capabilities
   ├─ PLAN / IMPLEMENT / VERIFY / REVIEW
   ├─ FIX / PUBLISH
   └─ SELF-IMPROVEMENT
```

- **GRAPH**는 단계, 조건, 산출물과 역할을 연결하는 orchestration model입니다.
- **LOOP**는 GRAPH 실행 결과를 `LEARN`과 `IMPROVE`로 되돌려 반복하는 execution model입니다.
- **Trust Model**과 **State Model**은 GRAPH와 LOOP가 허용된 경계를 우회하지 못하게 합니다.
- **Human Approval**은 AI가 대신할 수 없는 명시적 권한 경계이며, **Provenance**는 어떤 승인과 exact SHA를 근거로 실행했는지 추적하게 합니다.
- **Agents / Roles**는 책임 주체를 표현하고, **Capabilities**는 그 주체에게 부여할 수 있는 동작 권한을 표현합니다. 이 문서의 capability 집합은 `PLAN`, `IMPLEMENT`, `VERIFY`, `REVIEW`, `FIX`, `PUBLISH`, `SELF-IMPROVEMENT`입니다. 특히 `IMPLEMENT` / `FIX`와 `VERIFY` / `REVIEW`는 가능한 한 역할과 신뢰 경계를 분리합니다.
- **Human Authorization**은 capability가 아니라 Human Approval을 실행 권한으로 바꾸는 별도의 인가 경계입니다. `AUTHORIZE`, `SEAL`, `RECORD_PUBLISHED` 같은 이름은 State Model이 다루는 event이거나 Trust Boundary이며, 대문자로 표기됐다고 모두 capability인 것은 아닙니다. `REQUIREMENT`, `LEARN`, `IMPROVE`는 workflow의 입력·node입니다.

상세한 레이어 관계는 [아키텍처](docs/architecture.md), 단계별 증명 목표는 [Roadmap](docs/roadmap.md)에서 설명합니다.

## 현재 실험 트랙: Self-Improvement capability

현재 구현은 전체 프레임워크 중 **Core Trust Layer**, **Human Authorization**, write credential 없는 **untrusted IMPLEMENT Worker**, 그리고 Worker 결과를 봉인·공개하는 **Trusted SEAL / PUBLISH**까지의 수직 단면을 실제 GitHub Actions로 연결합니다. Worker 결과는 직접 공개되지 않고 `candidate.patch + implement.json` artifact로만 남으며, Trusted Rail이 이를 검증해 봉인한 뒤 별도 최소 write 권한의 PUBLISH job만 publish branch를 갱신합니다.

```text
Issue
→ Human: SI-승인
→ AUTHORIZE
→ IMPLEMENT
→ Trusted Rail
   → SEAL
   → PUBLISH
   → VERIFY exact published SHA
   → SEMANTIC REVIEW
      ├─ PASS → MERGE_READY → Human Merge
      ├─ STRUCTURAL_CHANGE → STOPPED
      └─ LOCAL FIX (fixCount < 2) → FIX → Trusted Rail 재진입
```

- Issue #1의 상태 머신과 Trust Boundary는 모든 capability가 공유하는 **Core Trust Layer**의 첫 구현입니다.
- Issue #3의 `SI-승인 → AUTHORIZE`는 **Human Authorization** 인가 경계의 첫 구현입니다.
- Issue #10 / PR #11은 trusted `AUTHORIZE` 이후 Codex Cloud를 write credential 없는 untrusted `IMPLEMENT` Worker로 실행하고, 결과를 candidate artifact로만 기록합니다.
- Issue #12 / PR #13은 candidate를 실행하지 않고 identity와 digest를 검사해 `sealed.patch + seal.json`으로 승격하는 read-only Trusted `SEAL` 경계를 구현합니다.
- Issue #17 / PR #18은 sealed artifact만 재검증해 `ai-publish/issue-<N>` branch에 force 없이 공개하고, 실제 remote commit의 exact SHA를 `publish.json.publishedHeadSha`로 기록하는 Trusted `PUBLISH` 경계를 구현합니다.
- Worker에서 trusted 영역으로 넘어가는 GitHub Actions 진입점은 `.github/workflows/trusted-rail.yml` 하나로 유지합니다. GitHub의 `workflow_run` 연쇄 길이 제한을 피하기 위해 `SEAL → PUBLISH → VERIFY → REVIEW`는 별도 chained workflow가 아니라 이 Trusted Rail 내부의 최소 권한 job으로 확장합니다.
- `state.ts`는 외부 자동화를 직접 실행하지 않고 상태와 invariant만 검증합니다. GRAPH Engine과 LOOP Engine은 아직 구현하지 않습니다.

## 변하지 않는 신뢰 원칙

- Human start는 `SI-승인` 1회이며, trusted approver policy와 authorization provenance로 근거를 남깁니다.
- 최종 Merge는 **Human-only**이며 Auto Merge를 금지합니다.
- `IMPLEMENT` / `FIX`에는 GitHub write credential을 제공하지 않습니다.
- untrusted candidate patch는 trusted `SEAL` 이후에만 Trusted Rail의 `PUBLISH` 대상이 됩니다.
- `SEAL`은 candidate code를 실행하거나 기능적으로 승인하지 않고 source identity와 exact bytes를 provenance에 봉인합니다.
- Trusted Rail 전체에 일괄 권한을 부여하지 않고 각 trusted job이 필요한 최소 권한만 가집니다.
- `PUBLISH` write 권한은 `SEAL` read-only 경계와 분리하며 publish branch에만 사용합니다. `main` 직접 push와 force push는 금지합니다.
- `VERIFY`는 immutable `published_head_sha`와 exact match인 대상만 성공시킵니다.
- `VERIFY` 실패는 전환 거부 또는 Human 경계로 처리하며, REVIEW 없이 `STOPPED`로 전환하지 않습니다.
- Semantic Review는 verified SHA만 검토합니다.
- `FIX`는 최대 2회이며 `LOCAL FIX`와 `STRUCTURAL CHANGE`를 구분합니다. 각 `FIX` 후에는 반드시 `SEAL → PUBLISH → VERIFY exact published SHA → REVIEW`를 다시 거친 뒤, 그 재검토 decision에서만 `MERGE_READY`, `STOPPED`, 또는 다음 `FIX`로 전환합니다.

## Roadmap

| Phase | 프레임워크 능력 | 증명 목표 |
| --- | --- | --- |
| 0 | Core State / Trust Model | 상태 전환, 신뢰 경계, exact SHA, Human-only Merge invariant를 강제할 수 있다. |
| 1 | Human Authorization | versioned policy와 provenance를 근거로 Human 승인만 실행 시작 권한으로 바꿀 수 있다. |
| 2 | AI IMPLEMENT | write credential 없는 Implementer가 요구사항에서 candidate patch를 만들 수 있다. |
| 3 | Independent VERIFY | 구현과 분리된 Verifier가 공개된 동일 SHA를 재현 가능하게 검증할 수 있다. |
| 4 | Semantic REVIEW / FIX | Reviewer가 의미적 품질을 판정하고 제한된 local fix만 안전하게 되돌릴 수 있다. |
| 5 | GRAPH Orchestration | 단계·역할·조건·산출물 의존 관계를 명시적인 GRAPH로 조정할 수 있다. |
| 6 | LOOP Execution | 종료 조건과 실행 한도를 지키며 검증·피드백·수정 주기를 반복할 수 있다. |
| 7 | Self-Improvement | Provenance가 있는 결과에서 학습해 프레임워크 개선 candidate를 제안하고 같은 경계로 검증할 수 있다. |
| 8 | Dogfooding | 프레임워크 자체와 실제 애플리케이션 개발에 전체 흐름을 적용해 범용성을 입증할 수 있다. |

Phase는 구현 항목 체크리스트가 아니라 프레임워크가 차례로 증명해야 할 능력입니다. 자세한 범위와 완료 증거는 [`docs/roadmap.md`](docs/roadmap.md)를 참고하세요.

## 현재 범위

Phase 1 Human Authorization은 Human이 Issue에 남긴 정확한 `SI-승인`을 GitHub API로 다시 조회하고 versioned trusted approver policy로 검증합니다. Policy의 권한 identity는 재사용될 수 있는 login이 아니라 GitHub의 immutable numeric user ID이며, login은 가독성과 provenance를 위한 설명값입니다. `AUTHORIZE` provenance는 trusted `authorize.yml` run과 실제 생성 attempt에 귀속된 Actions artifact에 저장하며, Issue comment에는 run과 artifact를 찾는 최소 pointer만 남깁니다. 같은 approval event의 재실행은 검증 가능한 기존 artifact를 재사용하는 no-op이며 live collaborator permission을 조회하지 않습니다.

Phase 2 AI IMPLEMENT는 `.github/workflows/implement.yml`에서 Codex Cloud를 untrusted Worker로 실행합니다. Worker에는 GitHub write credential을 주지 않으며, 승인 시점 exact SHA와 요구사항 snapshot만 입력합니다. Worker workspace는 곧바로 신뢰하지 않고 clean trusted job이 `candidate.patch`와 `implement.json` provenance를 생성해 candidate artifact로 기록합니다.

`.github/workflows/trusted-rail.yml`은 Worker 이후 trusted 영역의 단일 진입점입니다. workflow-level 권한은 비워 두고 `seal` job은 `contents: read`, `actions: read`만 가집니다. Trusted `SEAL`은 candidate를 실행하거나 적용하지 않고 source IMPLEMENT workflow identity, base SHA, provenance 구조와 SHA-256을 검증해 exact bytes 그대로 `sealed.patch`로 보존하고 `seal.json`으로 authorization → IMPLEMENT → SEAL chain을 기록합니다.

Trusted `PUBLISH`는 같은 workflow 안의 별도 job이며 `seal` 성공 뒤에만 실행됩니다. PUBLISH job에만 `contents: write`를 부여하고, sealed artifact를 다시 검증한 뒤 exact `baseSha` worktree에 patch를 적용해 deterministic `ai-publish/issue-<N>` branch를 생성하거나 fast-forward합니다. force push와 `main` 직접 push는 허용하지 않습니다. push 후 실제 remote SHA를 다시 확인하고 그 exact 값을 `publish.json.publishedHeadSha`로 기록합니다.

Actions artifact는 현재 단계의 **operational trust anchor**일 뿐입니다. repository/org retention 정책에 따라 artifact가 만료되면 이 단계만으로는 장기 provenance 감사를 보장할 수 없습니다. Durable/append-only provenance 및 장기 검증 방식은 후속 Framework 설계 과제로 남깁니다(TODO).

현재 구현 범위는 `AUTHORIZE → untrusted IMPLEMENT → candidate artifact → Trusted SEAL → Trusted PUBLISH → immutable published_head_sha`까지입니다. 다음 구현은 같은 Trusted Rail 안에서 그 exact published SHA만 대상으로 `VERIFY`하는 것입니다. Semantic Review, `FIX`, `MERGE_READY`, Auto Merge는 아직 구현하지 않습니다. 최종 Merge는 계속 Human-only입니다.
