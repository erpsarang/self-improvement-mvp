/** 사람에게 보여 주는 상태이며 WorkflowState 및 실행 판단과 독립적이다. */
export type HumanStatus =
  | 'PLAN'
  | 'PLAN_AUTHORIZE'
  | 'IMPLEMENT'
  | 'VERIFY'
  | 'MERGE_READY'
  | 'STOPPED';

export interface HumanStatusSummary {
  currentSituation: string;
  nextAction: string;
}

/** 표시 전용 변환. 승인, 검증, 리뷰 또는 병합 판단에 사용하지 않는다. */
export function getHumanStatusSummary(input: unknown): HumanStatusSummary {
  switch (input) {
    case 'PLAN':
      return {
        currentSituation: 'AI가 계획을 제안했습니다. 아직 구현 승인이 아닙니다.',
        nextAction: '계획을 검토하고 구현 범위가 준비된 경우에만 승인 여부를 결정하세요.',
      };
    case 'PLAN_AUTHORIZE':
      return {
        currentSituation: '해당 PLAN에 대한 정확한 사람 승인 검증이 완료되었습니다. 구현 시작을 뜻하지 않습니다.',
        nextAction: '승인된 PLAN과 구현 범위를 확인하고 별도의 구현 시작 절차를 진행하세요.',
      };
    case 'IMPLEMENT':
      return {
        currentSituation: '승인된 범위의 구현 후보를 준비하고 있습니다. 검증·리뷰 완료를 뜻하지 않습니다.',
        nextAction: '구현 결과와 후속 검증·리뷰 결과를 기다리세요.',
      };
    case 'VERIFY':
      return {
        currentSituation: '구현 후보를 검증하고 있습니다. 검증 성공이나 리뷰 통과를 뜻하지 않습니다.',
        nextAction: '검증·리뷰 결과를 확인한 뒤 다음 안내를 따르세요.',
      };
    case 'MERGE_READY':
      return {
        currentSituation: '검증·리뷰를 통과한 후보가 사람의 병합을 기다리고 있습니다.',
        nextAction: 'PR의 변경 내용과 reviewed exact SHA를 확인하고 사람이 최종 병합 여부를 결정하세요.',
      };
    case 'STOPPED':
      return {
        currentSituation: '작업이 중단되었습니다. 구현·검증·리뷰의 성공을 뜻하지 않습니다.',
        nextAction: '중단 사유와 관련 기록을 확인하고 다음 진행 여부를 결정하세요.',
      };
    default:
      return {
        currentSituation: '현재 상태를 확인할 수 없습니다. 성공 여부는 확인되지 않았습니다.',
        nextAction: '관련 실행 기록과 결과를 확인한 뒤 다음 행동을 결정하세요.',
      };
  }
}
