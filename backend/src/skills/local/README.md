# 本地 Skill（`backend/src/skills/local/`）

此目录用于存放**业务项目自建**的 Skill。

- 每个 Skill 是一个独立子目录，目录名即 Skill 的 ID（小写、用 `-` 分隔）。
- 每个 Skill 必须包含一个 `SKILL.md`，作为该 Skill 的权威指令来源。
- 这些 Skill **会被文件系统自动发现**，无需手动注册。
- 这些 Skill **会被 Git 追踪**，跟随业务仓库一起版本管理。
- 这里的内容**不属于 marketplace**，不能通过 `POST /skills/market/install` 安装。

## 目录约定

```text
backend/src/skills/local/
└── my-skill/
    ├── SKILL.md             # 必需；YAML 头部 + Markdown 正文
    └── references/          # 可选；附件/参考资料
```

`SKILL.md` 的 YAML 头部支持以下字段：

```yaml
---
name: 我的技能
description: 一句话描述这个技能做什么。
compatibility: compatible
allowed-tools:
  - calculator
  - get-current-time
---
```

- `name` 与 `description` 会出现在 Skill 列表与详情接口里。
- `allowed-tools` 是 Skill 声明它需要使用的 Tool ID。如果列表中任何一个 Tool
  在当前 Agent 上不可用，这个 Skill 对该 Agent 会自动降级为
  `requires-runtime`，从而**无法被绑定**。
- 不允许放置 `scripts/` 目录或 `.sh|.py|.js|.ts` 等可执行扩展名文件，否则
  Skill 会立刻被识别为 `requires-runtime`。

## 添加一个本地 Skill

1. 在本目录下新建子目录，命名遵守 `^[a-z0-9][a-z0-9-]*$`。
2. 写入 `SKILL.md`（参考上面的 frontmatter）。
3. 后端启动后 `discoverLocalSkills()` 会自动发现该 Skill。
4. 通过 `POST /skills/:id/bind` 绑定到目标 Agent。

## 与其他来源的区别

| 来源 | 目录 | 是否 Git 追踪 | 典型用途 |
|------|------|---------------|----------|
| builtin | `backend/src/skills/builtin/<id>/` | ✅ | 平台自带的 Skill，随版本发布 |
| local | `backend/src/skills/local/<id>/` | ✅ | 项目自建 Skill |
| marketplace | `backend/market-skills/<owner>/<repo>/<skillName>/` | ❌（被 `.gitignore`） | skills.sh 安装的 Skill |