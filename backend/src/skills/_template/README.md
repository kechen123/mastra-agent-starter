# Skill 模板

这是新增 Skill 的最小骨架，**不要直接生效**——它只是占位示例，避免新 Skill
不知道应该放在哪里、如何组织 `SKILL.md`。

## 使用步骤

1. 在 `backend/src/skills/local/<your-skill-id>/` 下新建一个目录（仅下划线
   `_template` 目录会被 Skill 注册器跳过；其他目录均会作为本地 Skill 加载）。
2. 复制本目录下的 `SKILL.md` 作为起点，修改：
   - `name`（目录名 + YAML `name` 字段必须稳定一致）。
   - `description`（一句话概括）。
   - `allowed-tools`（允许该 Skill 引用的 Tool 列表；运行时不会超出 Agent 的
     `toolIds` 交集）。
3. 编写正文：任务目标、输入与输出、工作步骤。
4. 重启后端；新 Skill 会出现在 `GET /skills` 中，并通过
   `POST /skills/:id/bind` 绑定到目标 Agent。

## 关键约束

- **不要**修改 `core/skill/registry.ts`。Skill 是文件系统驱动的：所有
  `backend/src/skills/local/*/SKILL.md` 都会自动被发现。
- `_template` 目录会被自动跳过，可以放心存放示例，不会污染 Skill 列表。
- `allowed-tools` 中的 Tool id 必须存在于 Tool Registry；运行时若 Tool 不
  存在或未在 Agent 的 `toolIds` 中声明，Skill 调用会被拒绝。
- 正文（任务目标、步骤等）由 Agent 在运行时作为附加指令读取；保持简洁。