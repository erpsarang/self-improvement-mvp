# 이 저장소에서 작업하는 AI 세션에게

작업을 시작하기 전에 [`CHARTER.md`](CHARTER.md)를 먼저 읽는다. 헌장은 이 프레임워크의 목적, 가치의 우선순위, 과제 선정 기준, 프레임워크 고도화의 경계, 사람과 AI의 역할을 정한다.

- 변경을 제안하거나 만들기 전에 헌장 **제8장 "작업 전에 스스로 묻는 것"**을 한 번 지나간다.
- Trust Boundary의 설계 authority는 [`docs/architecture.md`](docs/architecture.md)다. 헌장은 그것을 느슨하게 하는 근거가 되지 않는다.
- 최종 Merge는 Human-only다. Auto Merge를 만들거나 켜지 않는다.
- 문서와 코드는 함께 바뀐다. 변경으로 거짓이 되는 문장을 README·docs에 남기지 않는다.
- 검증 명령은 `npm test`다.

이 파일은 사람과 직접 협업하는 AI 세션(Human-directed maintenance)을 위한 안내다. 프레임워크 안에서 돌아가는 Planner·Worker·Reviewer·Learner·Evaluator는 저장소 문서를 trusted instruction으로 읽지 않는다(`docs/trust-model.md`).
