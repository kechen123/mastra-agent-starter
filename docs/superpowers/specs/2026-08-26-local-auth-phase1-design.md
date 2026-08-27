# 本地账号密码登录（第一期）设计

- 日期：2026-08-26
- 阶段：关闭匿名访问（不是权限系统）

## 目标与边界

- 用户用本地账号密码登录后，才能访问业务 API 或前端工作台。
- 所有已登录账号暂共享同一份业务数据；不引入角色、租户、owner 字段。
- 不实现注册、邀请码、`DEPLOYMENT_PROFILE=production`。
- 不启动服务、数据库或 MinerU；不执行真实迁移。

## 关键决策（spec 之外的小取舍）

| 决策点 | 选择 | 理由 |
|---|---|---|
| Mastra Provider 形态 | 继承 `MastraAuthProvider` 抽象类 | 锁定版本支持 `authenticateToken` / `authorizeUser`；与 `requiresAuth: true` 路由天然协作 |
| 是否使用 SimpleAuth | 否 | 静态 token 不能撤销，无法满足"可撤销 DB 会话"要求 |
| Token 形态 | 32 字节随机 → base64url | `crypto.randomBytes(32).toString('base64url')` ≈ 43 字符，高熵 |
| 持久化 | 仅存 SHA-256 哈希（`createHash('sha256').update(token).digest('hex')`） | DB 被 dump 也不泄露原始 token |
| Cookie 名 | `mastra_session`（spec 固定） | 与业务 token 区分；客户端只读，不写回 |
| Origin 校验范围 | unsafe 方法 + `/auth/login` | spec 明确；`GET/HEAD/OPTIONS` 兼容浏览器预检 |
| 用户创建入口 | CLI `npm run users:create -- --username <u>`，密码通过 `process.stdin` 两次输入 | 不进入 history，避免 `ps` 泄露；用户名存在立即失败 |
| TTL 单位 | `AUTH_SESSION_TTL_DAYS`（天） | 默认 7；spec 早期草稿曾写 `HOURS`，最终统一为天 |
| `last_seen_at` 写入策略 | Phase 1 不写入 | SSE / 高频 GET 写放大风险高；schema 中保留该列仅为后续阶段（观测、闲置超时）预留 |
| 错误响应字段 | 同时兼容 `message` 与 `error` | Mastra 鉴权层在错误路径上既可能输出 `message` 也可能输出 `error`，前端统一读取两者 |
| 多设备 | 每次登录独立创建 session；`POST /auth/logout` 只吊销当前 Cookie | 其它设备的会话不受影响 |
| 认证方式 | 仅 Cookie | 不提供 Bearer / API Key 回退 |

## 数据模型

迁移 `backend/database/migrations/0001-local-auth.sql`，**只新增**，不动 `init.sql`：

```sql
CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- username_normalized 已有 UNIQUE 约束，**不再**额外建同名索引。

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- token_hash 已有 UNIQUE 约束，**不再**额外建同名索引或 partial 索引。
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
```

校验：
- `username`（展示字段）独立保留，可改名时不影响登录。
- 不为每请求更新 `last_seen_at`：Phase 1 不维护该字段，避免 SSE / 高频 GET 写放大；列保留仅为后续阶段（观测、闲置超时）预留。登录查询始终过滤 `revoked_at IS NULL` 与 `expires_at > now()` 与 `disabled_at IS NULL`。
- `password` 长度 **12–128 字符**，进入 hash 前再做一次长度检查；不在错误响应中回显。
- `password_hash` 形如 `scrypt$N=16384,r=8,p=1$<saltB64>$<hashB64>`（`N=2^14` 的十进制形式），自描述参数；不可写明文/可逆加密/固定 salt。
- 不写 `~/.bash_history`、URL、Cookie value 之外的任何位置。

不再为每请求更新 `last_seen_at`：Phase 1 不写入该字段，避免 SSE / 高频 GET 写放大；schema 保留该列仅为后续阶段（观测、闲置超时）预留；登录查询始终过滤 `revoked_at IS NULL` 与 `expires_at > now()` 与 `disabled_at IS NULL`。

## 后端模块

```
backend/src/infrastructure/auth/
  password.ts        # scrypt hash/verify，常数时间比较
  session.ts         # 创建会话、查会话、撤销
  local-auth-provider.ts  # MastraAuthProvider 子类；从 Request Cookie 提取 token
  request.ts         # Origin 校验、Cookie 解析、Cookie 序列化助手
backend/src/modules/auth/
  service.ts         # login(username, password, request) / logout(request) / me(request)
backend/src/server/routes/
  auth.ts            # POST /auth/login, POST /auth/logout, GET /auth/me
backend/src/scripts/
  users-create.ts    # CLI 脚本：stdin 两次输入密码，校验用户名存在性
```

Provider 接口实现：

```typescript
class LocalAuthProvider extends MastraAuthProvider<AuthUser> {
  async authenticateToken(token: string, request: MastraAuthRequest): Promise<AuthUser | null>
  async authorizeUser(user: AuthUser, request: MastraAuthRequest): Promise<boolean>
}
```

- `authenticateToken`：Mastra 在调用前先用 `Authorization` 头 / `mastra-token` Cookie 抽 token，本项目只用 `mastra_session` Cookie，因此 Mastra 传入的 token 通常是空串；本方法在 token 为空时自行从 `request` 的 Cookie 头拿 `mastra_session`，按 SHA-256 hash 查 `auth_sessions`，校验：未撤销 + 未过期 + 用户未禁用。
- `authorizeUser`：
  - 安全方法（GET/HEAD/OPTIONS）放行所有有效用户；
  - `/auth/login`（POST）始终放行，由路由层单独做 Origin 校验；
  - 其它不安全方法（POST/PATCH/PUT/DELETE）：校验 `Origin` 与 `AUTH_ALLOWED_ORIGIN`（精确匹配，缺省 `http://localhost:5173`），不通过直接拒绝。
- 不实现 `mapUserToResourceId`：当前会话互斥、Memory/Thread scoping 仍走 `core/execution/controller.ts` 的进程内 Map；后续接入多租户时再补。

`mastra/index.ts` 改为：

```typescript
const localAuth = new LocalAuthProvider();
export const mastra = new Mastra({ server: { apiRoutes, auth: localAuth } });
```

## 路由契约

| 路由 | 方法 | requiresAuth | 行为 |
|---|---|---|---|
| `/healthz` | GET | false | 同前 |
| `/readyz` | GET | false | 同前 |
| `/auth/login` | POST | false | Origin 校验，1) 输入校验；2) 用户名规范化查 `app_users`；3) 即使用户不存在也跑一次 dummy hash 防时序；4) 一致失败统一 401 |
| `/auth/me` | GET | true | 必须 Cookie 命中 → 返安全用户对象 |
| `/auth/logout` | POST | **false** | 注销必须能清掉任何状态下的 Cookie（过期/已吊销/篡改），鉴权失败时 handler 不会被执行、Set-Cookie 也送不到客户端；改为公开路由，路由层用 `isOriginAllowed` 兜底 |
| 其余业务路由（全部） | 各自 | **true**（明确写出，便于契约测试） | 业务保持不变 |

状态码：
- 401：用户名/密码错误、未认证、session 失效。
- 403：Origin 不合法。
- 400：请求体格式错误。
- 500：其它服务端错误。

错误响应在 `application/json` 顶层字段上是 `message` 或 `error`（Mastra 鉴权层在错误路径上既可能输出 `message` 也可能输出 `error`，与项目既有 `{ message: string }` 风格并存）；前端必须同时识别两者；服务端不主动改写 Mastra 内部返回体。

不输出 `password_hash`、原始 token、`token_hash`；安全用户对象仅 `{ id, username }`（按本期用户声明的最小信息集，不含 `created_at`）。

认证流程锁定只读 Cookie：
- 本地会话认证只接受 `mastra_session` Cookie；不提供 Bearer / API Key 回退。
- 多设备同时登录：每次登录创建独立会话；退出只撤销当前会话，其他设备的会话不受影响。
- 浏览器自动携带 Cookie，前端 JavaScript 不可读、不可写（HttpOnly + SameSite=Strict）。

## 前端

```
frontend/src/features/auth/
  components/LoginScreen.tsx
  types.ts
frontend/src/lib/api.ts        # 新增 login/logout/getCurrentUser，默认 credentials:'same-origin'
frontend/src/app/App.tsx       # 顶层认证闸门
```

`App.tsx` 状态机：

```
loading (首次 GET /auth/me) →
  - 200 → 在内存中记 currentUser → 渲染工作台
  - 401 → 渲染 <LoginScreen />
    - 提交 POST /auth/login → 成功记 currentUser、渲染工作台
    - 任意业务 API 401 → 清 currentUser、回到登录页
    - 侧边栏 "退出登录" → POST /auth/logout → 清 currentUser、回到登录页
```

`request()` 助手默认注入 `credentials: 'same-origin'`；SSE 与 stop 也必须使用同一凭据策略。绝不允许写入密码 / token 到日志 / 持久化。

## 配置（.env.example）

```bash
# 会话有效期（天），正整数，默认 7 天
AUTH_SESSION_TTL_DAYS=7
# Cookie 是否带 Secure；本地开发 false，生产必须显式 true
AUTH_COOKIE_SECURE=false
# 不安全方法 + /auth/login 的合法 Origin；本地默认 http://localhost:5173
AUTH_ALLOWED_ORIGIN=http://localhost:5173
```

新增 `package.json` 脚本：

```json
"users:create": "tsx src/scripts/users-create.ts"
```

不实际执行；只注册。

## 文档

- `README.md`：在"安全提示"前加段落"用户与登录"；补充账号创建命令；明确"会话共享数据"边界。
- `docs/architecture.md`：「安全设计」加 "Cookie / Origin / session 模型" 小节；「路由表」加 `/auth/*` 路由并标 requiresAuth。
- `docs/development.md`：加"本地登录调试"小节：复制 `.env.example` → 启动 DB → `npm run migrate` → `npm run users:create -- --username alice` → `npm run dev`。

每处都必须重申：`DEPLOYMENT_PROFILE=production` 仍拒绝启动；这是"关闭匿名访问"，不是权限系统。

## 测试（不引入新框架）

新增：

| 文件 | 覆盖 |
|---|---|
| `tests/unit/auth-password.ts` | hash/verify 正确；同一密码多次 hash salt 不同；错误密码 false；空密码 reject |
| `tests/unit/auth-username.ts` | trim+lowercase；长度 3–64；非法字符 reject |
| `tests/unit/auth-session.ts` | token 长度 + 字符表；DB 只存 hash；hash 对同 token 稳定 |
| `tests/unit/auth-cookie.ts` | 序列化输出 HttpOnly/SameSite=Strict/Max-Age/PATH=/；Secure 跟随配置；Cookie 解析；unsafe 方法判定 |
| `tests/contracts/run.ts` § 7 | 静态扫描 `src/server/routes/*.ts`：除 health + auth/login 外，所有 `registerApiRoute` 必须显式 `requiresAuth: true` |

可继续用现有 `tests/unit/run.ts` 自动加载；static 扫描加在 `tests/contracts/run.ts` 末尾，按 ID 集合验证。

## 安全边界与已知限制

- **进程内会话互斥的单实例假设依然生效**：auth 表里没有跨进程 lease；多实例需要 DB 租约（已经在架构文档说明）。
- **不存 owner/tenant**：`conversations` 等仍然共享；本期不修。
- **不阻止登录前的扫描**：登录端点必须加 Origin，但攻击者可能绕过；这是"关闭匿名"阶段，本就不承诺防滥用。
- **不锁错误次数**：本期不做限流；rate-limit 等到生产档位前加。
- **不使用 `SimpleAuth`**：保留静态 token 路径，但禁止默认 Provider 选用它。

## 已验证与未验证

**已验证**：路由清单、迁移脚本对文件的排序规则（`^\d{4,}[-_]`）、Mastra Provider 类型契约、`requiresAuth` 默认值含义（`server/types.d.ts:19` "default is true" 当未指定时）。

**未验证**：本次不执行 `npm run migrate`；不启动 dev 服务；不通真实数据库。`npm run typecheck` / `npm test` / `npm run lint` / `npm run build` 在最后执行作为唯一运行态校验。
