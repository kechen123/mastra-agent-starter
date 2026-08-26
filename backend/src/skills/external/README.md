# 外部 Skill（说明性目录）

> ⚠️ 此目录**仅作为源码侧的说明 / 映射**，不承载真实的 Skill 文件。

第三方 Skill（例如从 skills.sh 安装的 Skill）的实际运行目录是：

```text
backend/market-skills/<owner>/<repo>/<skillName>/
```

该目录由 `backend/market-skills/.gitignore` 忽略，**不进入版本控制**。

## 为什么这里不放真实文件？

- 避免出现「两套安装源」——业务开发如果误把 Skill 放在源码侧，会与
  marketplace 的 install / uninstall 流程产生分歧。
- 真实运行目录必须由 `POST /skills/market/install` 等安装接口写入，
  并由相同接口清理；任何源码侧的手动放置都会被忽略。

## 安装路径

前端「技能」模块 → 浏览 / 搜索 skills.sh → 预览 → 安装到本地。

详见 `docs/skills.md` 与 `docs/extending.md`。