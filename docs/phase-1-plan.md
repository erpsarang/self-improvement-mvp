# v0.2 Phase 1: 업무 요구 → PLAN

1. **업무 요구 → AI PLAN** Issue 템플릿으로 불편한 점과 원하는 결과를 작성합니다. 기술적인 파일명이나 테스트 명령을 알 필요가 없습니다.
2. Actions의 **Read-only AI PLAN**을 기본 브랜치에서 실행하고 Issue 번호를 입력합니다. 저장소에 `CODEX_API_KEY` Actions secret이 필요합니다.
3. 실행 페이지의 `plan-issue-번호-run-attempt-*` artifact를 내려받아 `PLAN.md`를 읽습니다. `PLAN.json`은 같은 계획의 구조화된 결과입니다.

예: “매일 주문 목록에서 특정 고객의 주문을 찾느라 시간이 오래 걸립니다. 고객 이름으로 찾고 싶고 기존 날짜 검색도 계속 사용하고 싶습니다.”

workflow는 실행 시 Issue 제목/본문과 대상 저장소 기본 브랜치의 SHA를 고정합니다. AI가 해당 checkout의 코드, 테스트, 문서를 읽어 구현 접근, 변경 후보와 이유, 완료조건, 테스트 전략, 미확정 사항을 제안합니다. 분석 근거에는 실제 파일 경로와 원문 인용이 포함되며 artifact 생성 시 인용을 대조합니다. 인용 대조는 계획의 의미적 정확성을 보증하지 않으므로 사람이 가정과 제안을 확인해야 합니다.

Planner는 neutral directory에서 read-only sandbox와 drop-sudo로 실행합니다. checkout credential은 유지하지 않고 GitHub 권한은 contents/issues read만 부여합니다. 대상의 코드나 테스트를 실행하지 않습니다. 입력/출력과 Codex runtime 파일은 대상 밖 runner temp에 둡니다. 실행 전후 전체 대상 파일(.git 포함)의 SHA-256 목록이 다르면 artifact를 만들지 않습니다. 심볼릭 링크 등 일반 파일/디렉터리가 아닌 항목은 안전하게 실패시킵니다. 쓰기 차단은 sandbox가 담당하며 해시 비교는 추가 검사입니다.

이 workflow는 수동 실행만 지원하고 PLAN artifact 저장으로 종료합니다. 기존 v0.1 승인/구현 흐름 및 상태 모델과 연결하지 않습니다. PLAN을 생성해도 구현 승인이나 후속 단계 실행으로 이어지지 않습니다.
