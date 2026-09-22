export function needsHumanOutputPlanContext(requirement: string): boolean {
  const lower = requirement.toLowerCase();

  const koreanOutputIntent =
    /(표시|보여주|안내|문구|메시지|댓글)/.test(requirement);
  const koreanCommentIntent =
    /(?:이슈|issue|pr|pull request).{0,30}(?:코멘트|댓글)|(?:코멘트|댓글).{0,30}(?:남기|작성|게시|등록)/i.test(requirement);
  const englishOutputIntent =
    /\b(user-facing|human-facing|display|show|render|message|next action)\b/.test(lower);
  const englishCommentIntent =
    /\b(issue|pull request|pr)\b.{0,30}\bcomment\b|\b(add|post|write|publish)\b.{0,20}\bcomment\b/.test(lower);

  const operationalOutputIntent =
    /(?:실행|현재\s*처리)\s*상태.{0,40}(?:표시|보여주|안내)|다음\s*행동.{0,40}(?:안내|표시|보여주)/.test(requirement) ||
    /\b(?:user-facing|human-facing)\b.{0,40}\b(?:message|status|next action)\b|\bnext action\b.{0,40}\b(?:display|show|message|guidance)\b/i.test(requirement);
  const frameworkOutputContext =
    /\b(?:PLAN|PLAN_AUTHORIZE|IMPLEMENT|VERIFY|MERGE_READY|STOPPED)\b/.test(requirement) ||
    /(?:워크플로|workflow|orchestrator|trusted rail|self-improvement|framework)/i.test(requirement) ||
    (/`[A-Z][A-Z0-9_]{2,79}`/.test(requirement) && /(?:상태|state)/i.test(requirement));

  return koreanCommentIntent || englishCommentIntent || operationalOutputIntent ||
    ((koreanOutputIntent || englishOutputIntent) && frameworkOutputContext);
}

export function planImpactTestScopeGuidance(): string {
  return "Context Pack에 기존 테스트가 있고 그 테스트가 변경 대상의 반환 shape/API/contract를 정확히 검증한다면 영향 여부를 확인하세요. 수정이 실제로 필요할 때만 그 기존 테스트의 exact path를 implementationScope.allowedPaths에 포함하고, 무관한 테스트로 범위를 넓히지 마세요. 변경 대상 소스를 import하는 기존 테스트는 trusted 단계가 allowedPaths에 자동으로 추가하므로, 8개 bounded slot 안에 그 여유를 남겨두세요.";
}
