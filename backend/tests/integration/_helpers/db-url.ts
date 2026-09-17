/**
 * 集成测试 DB 连接 URL 解析。
 *
 * TEST_DATABASE_URL 可能带 `?safety-identifier=test_xxx` 标记（runner 闸门），
 * pg 不识别该参数会原样透传，但 `pool.query` 内部对未知 param 会产生 warning。
 * 这里在交给 pg 之前先剥掉 safety-identifier，让连接静默。
 */
export function normalizeTestDbUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.searchParams.delete('safety-identifier');
    return u.toString();
  } catch {
    // 不是合法 URL 原样返回（让 pg 自己报错）
    return raw;
  }
}