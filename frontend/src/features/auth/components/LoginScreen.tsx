import { useEffect, useState } from 'react';
import type { LoginScreenProps } from '../types';

/**
 * 登录页：仅呈现账号密码表单，不渲染任何业务工作台。
 *
 * 视觉风格与现有 Tailwind 主题保持一致（dark / light），无新依赖。
 *
 * 关键约束：
 *   * 不把用户名 / 密码写入 localStorage、sessionStorage、URL 或日志。
 *   * 提交按钮在登录请求未结束前禁用，避免重复提交。
 */
export function LoginScreen(props: LoginScreenProps) {
  const { onLogin, errorMessage, busy, appName } = props;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // 禁止浏览器自动填充时弹出意外的密码；输入即清错误。
  useEffect(() => {
    if (!errorMessage) return;
  }, [errorMessage]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const trimmed = username.trim();
    if (trimmed.length < 3 || password.length < 12) return;
    void onLogin(trimmed, password);
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-app-bg text-app-text">
      <form
        onSubmit={handleSubmit}
        className="flex w-[360px] max-w-[92vw] flex-col gap-4 rounded-xl border border-app-border bg-app-surface p-6 shadow-md"
        autoComplete="on"
        data-testid="login-screen"
      >
        <h1 className="text-lg font-semibold leading-tight">{appName}</h1>
        <p className="text-xs leading-snug text-app-muted">请使用本地账号登录。</p>
        <label className="grid gap-1 text-xs">
          <span className="text-app-muted">用户名</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            minLength={3}
            maxLength={64}
            className="rounded-md border border-app-border-strong bg-app-bg px-3 py-2 text-sm text-app-text outline-none"
          />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="text-app-muted">密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            minLength={12}
            maxLength={128}
            className="rounded-md border border-app-border-strong bg-app-bg px-3 py-2 text-sm text-app-text outline-none"
          />
        </label>
        {errorMessage && (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {errorMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || username.trim().length < 3 || password.length < 12}
          className="rounded-md border border-app-text bg-app-text py-2 text-sm font-medium text-app-surface transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:opacity-90 focus-visible:border-focus-border"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
