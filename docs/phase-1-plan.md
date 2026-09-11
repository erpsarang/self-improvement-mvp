# v0.2 Phase 1: 업무 요구 → PLAN

1. **업무 요구 → AI PLAN** Issue 템플릿으로 불편한 점과 원하는 결과를 작성합니다. 기술적인 파일명이나 테스트 명령을 알 필요가 없습니다.
2. Actions의 **Read-only AI PLAN**을 기본 브랜치에서 실행하고 Issue 번호를 입력합니다. 저장소에 `CODEX_API_KEY` Actions secret이 필요합니다.
3. 완료 후 Issue에 남은 PLAN/provenance 링크 또는 실행 페이지의 `plan-issue-번호-run-attempt-*` artifact를 내려받아 `PLAN.md`를 읽습니다. `PLAN.json`은 같은 계획의 구조화된 결과입니다.

예: “매일 주문 목록에서 특정 고객의 주문을 찾느라 시간이 오래 걸립니다. 고객 이름으로 찾고 싶고 기존 날짜 검색도 계속 사용하고 싶습니다.”

workflow는 실행 시 Issue 제목/본문과 대상 저장소 기본 브랜치의 SHA를 고정합니다. AI가 해당 checkout의 코드, 테스트, 문서를 읽어 구현 접근, 변경 후보와 이유, 완료조건, 테스트 전략, 미확정 사항을 제안합니다. 분석 근거에는 실제 파일 경로와 원문 인용이 포함되며 artifact 생성 시 인용을 대조합니다. 인용 대조는 계획의 의미적 정확성을 보증하지 않으므로 사람이 가정과 제안을 확인해야 합니다.

Planner는 neutral directory에서 read-only sandbox와 drop-sudo로 실행합니다. checkout credential은 유지하지 않고 Planner job의 GitHub 권한은 contents/issues read만 부여합니다. 대상의 코드나 테스트를 실행하지 않습니다. 입력/출력과 Codex runtime 파일은 대상 밖 runner temp에 둡니다. 실행 전후 전체 대상 파일(.git 포함)의 SHA-256 목록이 다르면 artifact를 만들지 않습니다. 심볼릭 링크 등 일반 파일/디렉터리가 아닌 항목은 안전하게 실패시킵니다. 쓰기 차단은 sandbox가 담당하며 해시 비교는 추가 검사입니다.

이 workflow는 기본 브랜치에서의 수동 실행만 지원하고 PLAN artifact와 provenance 저장 및 Issue pointer 기록으로 종료합니다. 기존 v0.1 승인/구현 흐름 및 상태 모델과 연결하지 않습니다. PLAN을 생성해도 구현 승인이나 후속 단계 실행으로 이어지지 않습니다.


## v0.2 Phase 2-A: PLAN identity / provenance

trusted workflow가 AI 실행 전에 `identity.json`을 생성하고 PLAN artifact 안에 `PLAN.json`, `PLAN.md`와 함께 저장합니다. 다음 값을 고정합니다.

- requirement Issue 번호와 제목/본문 digest
- 대상 `owner/repository` 및 기본 브랜치에서 조회한 frozen target SHA
- PLAN workflow run ID / run attempt, workflow 실행 SHA
- exact artifact 이름 `plan-issue-{issueNumber}-{runId}-attempt-{runAttempt}`

requirement digest는 제목과 본문을 순서대로 배열에 넣은 `JSON.stringify([title, body])`의 UTF-8 바이트에 대한 SHA-256(소문자 hex)입니다. 공백이나 개행을 정규화하지 않습니다. 이후 승인 단계는 같은 방식으로 현재 Issue를 해시하여 변경을 탐지할 수 있습니다. 제목과 본문 경계도 구분하므로 단순 문자열 연결의 모호성이 없습니다.

업로드 성공 후 별도 provenance job이 `actions/upload-artifact@v4`가 반환한 artifact ID / SHA-256 / URL을 frozen identity와 결합하여 `PLAN-provenance.json`을 저장합니다. 이 파일은 `{exact PLAN artifact name}-provenance`라는 별도 artifact에 있습니다. digest는 업로드된 PLAN ZIP 전체에 대한 값이며 개별 `PLAN.json`의 digest가 아닙니다. 자기 자신을 포함한 archive의 digest를 기록할 수 없으므로 provenance는 분리합니다. 재실행은 run attempt가 달라 별개의 identity를 갖습니다.

Issue comment는 PLAN과 provenance artifact 링크, exact artifact 이름/ID/digest, requirement digest, repository, frozen SHA, run ID/attempt를 제공합니다. comment 작성 권한(`issues: write`)은 AI나 checkout이 없는 provenance job에만 있습니다. AI 응답의 필드는 provenance나 comment 생성에 사용하지 않습니다. provenance 저장 또는 comment 작성 실패 시 해당 job은 실패합니다.

이 pointer는 사람이 찾기 위한 안내이며 승인 증거 자체로 신뢰해서는 안 됩니다. 이후 승인 구현에서는 신뢰하는 workflow/run/attempt에서 생성된 provenance인지 확인하고, exact artifact ID/name/digest, 내부 identity, 현재 requirement digest를 대조해야 합니다. Artifact가 만료되거나 삭제된 경우 같은 이름의 다른 PLAN으로 대체해서는 안 됩니다. 이 단계에서는 `PLAN-승인`, IMPLEMENT 또는 기존 `SI-승인`/Trusted Rail 경로를 처리하거나 변경하지 않습니다.
