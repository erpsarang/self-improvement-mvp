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

/**
 * 요구가 AI 실행 정책(호출·모델·effort·비용·사용량)을 다루는가.
 * AI 주체어(AI/LLM/Codex/OpenAI/GPT)와 실행 관심사(호출·비용·모델·effort·token 등)가 함께 있을 때만 true다.
 * "AI 분석 결과를 표시한다" 같은 App 기능 요구나 "출고 비용"처럼 AI와 무관한 비용 요구에는 반응하지 않는다.
 */
export function needsAiExecutionPlanContext(requirement: string): boolean {
  const aiSubject = /\b(?:ai|llm|codex|openai|gpt)\b/i.test(requirement);
  const executionConcern =
    /(?:호출|비용|원가|사용량|토큰|가격|재시도|모델|reasoning\s*effort)/.test(requirement) ||
    /\b(?:call|cost|price|pricing|token|usage|effort|model|provider|fallback|retry)\b/i.test(requirement);
  return aiSubject && executionConcern;
}

const OUT_OF_SCOPE_MARKER = /(?:issue|이슈)\s*밖|범위\s*밖|범위에서\s*제외|별도\s*(?:issue|이슈)\s*(?:로|에서)\s*(?:다루|다룹|다룬|다뤄|처리|진행)|\bout[ -]of[ -]scope\b/i;
const BACKTICK_PATH = /`([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)`/g;

/**
 * 요구가 문장으로 범위 밖이라고 적은 backtick 경로.
 * 범위 밖 표시("이 Issue 밖", "범위 밖", "별도 Issue로 다룬다", "out of scope")가 있는 문장이나 그런 제목 아래 목록에만
 * 나오는 경로다. 다른 문장에서도 언급되면 범위 안으로 본다. "바꾸지 않는다" 같은 금지 문장은 표시가 아니다.
 * Context 우선순위에서만 쓰고 authority를 만들지 않는다 (App #310 PLAN run 37265738573).
 */
export function requirementOutOfScopePaths(requirement: string): ReadonlySet<string> {
  const outOfScope = new Set<string>();
  const inScope = new Set<string>();
  let outOfScopeSection = false;
  for (const line of requirement.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      outOfScopeSection = OUT_OF_SCOPE_MARKER.test(heading[1]!);
      continue;
    }
    for (const sentence of line.split(/(?<=[.!?。])\s+/)) {
      const marked = outOfScopeSection || OUT_OF_SCOPE_MARKER.test(sentence);
      for (const match of sentence.matchAll(BACKTICK_PATH)) (marked ? outOfScope : inScope).add(match[1]!);
    }
  }
  for (const path of inScope) outOfScope.delete(path);
  return outOfScope;
}

/** 범위 밖 경로의 backtick 언급을 지운 요구. 그 경로 이름이 Context 단어 점수를 올리지 않게 한다. */
export function withoutOutOfScopePathMentions(requirement: string): string {
  const outOfScope = requirementOutOfScopePaths(requirement);
  if (outOfScope.size === 0) return requirement;
  return requirement.replace(BACKTICK_PATH, (mention, path: string) => (outOfScope.has(path) ? "" : mention));
}

export function planImpactTestScopeGuidance(): string {
  return "Context Pack에 기존 테스트가 있고 그 테스트가 변경 대상의 반환 shape/API/contract를 정확히 검증한다면 영향 여부를 확인하세요. 수정이 실제로 필요할 때만 그 기존 테스트의 exact path를 implementationScope.allowedPaths에 포함하고, 무관한 테스트로 범위를 넓히지 마세요. 변경 대상 소스를 import하는 기존 테스트는 trusted 단계가 allowedPaths에 자동으로 추가하므로, 8개 bounded slot 안에 그 여유를 남겨두세요.";
}
