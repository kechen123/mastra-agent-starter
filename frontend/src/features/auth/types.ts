// 本地账号密码登录最小类型。安全用户对象仅含 id + username。
export interface SafeUser {
  id: string;
  username: string;
}

export interface LoginScreenProps {
  onLogin: (username: string, password: string) => Promise<void>;
  /** 后端最近一次返回的友好错误文案（已包含 401 / 400 的中文化映射）。 */
  errorMessage?: string | null;
  busy?: boolean;
  appName: string;
}
