# 项目目标
基于官方 draw.io 开发支持服务端存储的产品，同时保留持续升级官方编辑器的能力。

# 架构与仓库边界
- 产品仓库为 `drawio-cloud`，负责登录、文件管理、后端存储、权限和部署。
- 编辑器 fork 为 https://github.com/mPandaer/drawio-editor，上游为 https://github.com/jgraph/drawio。
- 使用自部署 draw.io 的 iframe 嵌入模式，由 `editor-bridge` 通过消息协议衔接文档加载、保存和状态反馈。
- 业务逻辑放在产品仓库，编辑器 fork 仅承载必要的配置和定制，尽量保持官方目录、源码格式和构建方式。

# 项目结构
```text
apps/web/                登录、文件列表、文件夹和编辑器入口
apps/server/             鉴权、文件读写、权限和版本管理
packages/editor-bridge/  draw.io 消息协议适配、加载和保存状态处理
packages/api-contract/   API 定义或生成的客户端类型（按需）
vendor/drawio/           编辑器 fork 的 Git submodule
deploy/                  容器、反向代理和部署配置
scripts/                 构建、打包和升级检查
openspec/                需求、设计和变更规划
.cursor/                 Cursor 命令与 OpenSpec 技能
```

# 编辑器版本与上游同步
- `vendor/drawio` 使用 submodule 固定提交；实际版本以产品仓库记录的 gitlink 为准。
- 初始化时固定为 `v32.0.2`（`2201e54`）；官方及 fork 的默认分支为 `dev`。
- 新克隆产品仓库后执行 `git submodule update --init --recursive` 获取编辑器。
- 当前编辑器本地 remote：`origin` 指向 fork，`upstream` 指向官方；`upstream` 不会随 submodule 自动配置。
- 当前编辑器采用浅克隆，升级时根据需要获取标签和历史。
- 升级应在独立分支合并选定的官方版本，验证通过后更新产品仓库的 submodule 指针。
- 发布使用明确的标签或提交，不自动跟踪上游最新分支；功能开发和上游同步提交分开。

# 存储与集成约定
- 后端保存完整的 draw.io 原生文档，文件名、所属用户、文件夹和版本等元数据单独管理。
- 保存接口应通过版本号或 ETag 检测冲突，避免多个标签页静默覆盖文档。
- 集成层校验消息来源，仅在后端保存成功后反馈已保存，并处理保存失败和未保存退出。

# 当前开发状态
- 已建立目录骨架和编辑器 submodule，前后端技术栈尚未确定，无业务实现和产品构建、测试命令。
- 产品仓库使用 `main` 分支，目前未配置远程仓库。

# Git提交规范
根据“git diff --staged”的输出，写一条简洁的提交信息，格式为[EMOJI] [TYPE](file/topic): [description in Chinese]。使用GitMoji表情符号（例如，✨ → feat），使用现在时、主动语态，每行最多120个字符，不要使用代码块。