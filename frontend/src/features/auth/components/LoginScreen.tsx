import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
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
    <div className="flex h-full w-full items-center justify-center bg-app-bg text-app-text">
      <form
        onSubmit={handleSubmit}
        className="flex w-[400px] max-w-[92vw] flex-col gap-5 p-6"
        autoComplete="on"
        data-testid="login-screen"
      >
        <div className="grid place-items-center gap-3 mb-2 text-center">
          <span className="grid place-items-center w-11 h-11 rounded-full bg-app-text text-app-bg">
            <Sparkles size={19} strokeWidth={2.1} />
          </span>
          <h1 className="m-0 text-[24px] font-semibold tracking-[-0.03em] text-app-text">
            {appName}
          </h1>
        </div>
        <p className="text-[14px] leading-6 text-app-muted text-center m-0">登录后继续使用智能体工作台</p>
        <label className="grid gap-2 text-[13px]">
          <span className="text-app-muted">用户名</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            minLength={3}
            maxLength={64}
            className="h-12 rounded-xl border border-app-border-strong bg-app-surface px-3.5 text-[15px] text-app-text outline-none focus-visible:border-focus-border"
          />
        </label>
        <label className="grid gap-2 text-[13px]">
          <span className="text-app-muted">密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            minLength={12}
            maxLength={128}
            className="h-12 rounded-xl border border-app-border-strong bg-app-surface px-3.5 text-[15px] text-app-text outline-none focus-visible:border-focus-border"
          />
        </label>
        {errorMessage && (
          <p className="rounded-md border border-app-danger/40 bg-app-danger/[0.08] px-3 py-2 text-[12px] text-app-danger">
            {errorMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || username.trim().length < 3 || password.length < 12}
          className="h-12 rounded-xl border-0 bg-app-text text-[15px] font-medium text-app-bg transition-[transform,opacity] duration-150 active:scale-[0.99] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
