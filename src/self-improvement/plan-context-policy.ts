export function needsHumanOutputPlanContext(requirement: string): boolean {
  const lower = requirement.toLowerCase();
  if (["사람", "사용자", "표시", "다음 행동", "문구"].some((signal) => lower.includes(signal))) return true;
  return /\b(issue|pull request|pr|comment|human|user)\b/.test(lower);
}

export function planImpactTestScopeGuidance(): string {
  return "Context Pack에 기존 테스트가 있고 그 테스트가 변경 대상의 반환 shape/API/contract를 정확히 검증한다면 영향 여부를 확인하세요. 수정이 실제로 필요할 때만 그 기존 테스트의 exact path를 implementationScope.allowedPaths에 포함하고, 무관한 테스트로 범위를 넓히지 마세요.";
}
