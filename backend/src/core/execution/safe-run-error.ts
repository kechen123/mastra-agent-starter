const SAFE_RUN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  INPUT_VALIDATION_FAILED: '请求参数无效，无法开始生成。',
  PROVIDER_UNAVAILABLE: '生成服务暂时不可用，请稍后重试。',
  APPROVAL_RECONCILE_MANUAL_INTERVENTION: '工具审批恢复失败，需要人工处理。',
  APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: '工具审批恢复失败，需要人工处理。',
};

export function getSafeRunErrorMessage(errorCode: string): string {
  return SAFE_RUN_ERROR_MESSAGES[errorCode] ?? '生成失败，请稍后重试。';
}
