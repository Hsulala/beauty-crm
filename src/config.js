// 讀取並檢查環境變數。缺少或太弱時直接拒絕啟動，避免帶著空密碼上線。
export function loadConfig(env = process.env) {
  const problems = [];
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (adminPassword.length < 12) problems.push('ADMIN_PASSWORD 至少需要 12 個字元');
  if (sessionSecret.length < 32) problems.push('SESSION_SECRET 至少需要 32 個字元（可用 openssl rand -hex 32 產生）');

  const databaseUrl = env.DATABASE_URL ?? '';
  const usePglite = env.USE_PGLITE === '1';
  if (!databaseUrl && !usePglite) problems.push('缺少 DATABASE_URL（本機試用可改設 USE_PGLITE=1）');

  if (problems.length) {
    const error = new Error(`設定有誤：\n- ${problems.join('\n- ')}`);
    error.problems = problems;
    throw error;
  }
  return { adminPassword, sessionSecret, databaseUrl, usePglite, port: Number(env.PORT || 3000) };
}
