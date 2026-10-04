# Spec Delta

## Purpose

提供归属于用户的原生绘图文件管理和服务器持久化，使用户可以创建、查找、导入和下载完整文档，并明确容量、命名、写入失败与永久删除的可观察行为。

## ADDED Requirements

### Requirement: Flat file management
系统 SHALL 提供文件列表、新建、打开、重命名和文件名搜索，不提供文件夹。新建 MUST 使用用户输入的名称并打开空白画布；搜索 MUST 为不区分大小写的包含匹配，不搜索图内文字。

#### Scenario: Create and find a drawing
- **WHEN** 用户创建名为 Architecture.drawio 的文件并搜索 architecture
- **THEN** 新建文件归属当前用户、可打开空白画布且出现在搜索结果中

### Requirement: Unique owner-scoped names
系统 SHALL 保证同一用户的文件名唯一，空名称 MUST 被拒绝；不同用户可以使用相同文件名，重命名不得改变正文或归属。

#### Scenario: Duplicate creation or rename
- **WHEN** 用户尝试创建或重命名为自己已有的文件名
- **THEN** 操作被拒绝并提示改名，现有文件不被覆盖

### Requirement: Native document import and download
系统 SHALL 仅从 `.drawio` 文件导入有效原生文档，兼容官方压缩格式，导入始终创建新文件；无效内容或扩展名 MUST 被拒绝并说明原因。下载 SHALL 返回完整原生文档，不丢失页面及内嵌资源。

#### Scenario: Import compressed multipage document
- **WHEN** 用户导入有效的官方压缩多页 `.drawio` 文件
- **THEN** 创建新文件，打开与下载后页面及内嵌资源保持完整

#### Scenario: Unsupported import or duplicate name
- **WHEN** 导入扩展名不是 `.drawio`、正文无效或名称重复
- **THEN** 系统拒绝导入并提示原因或要求改名，不覆盖已有文件

### Requirement: Configurable document size limit
系统 SHALL 对导入和保存执行同一单文件大小限制，默认 20 MiB，可由部署配置调整。超限 MUST 被拒绝且保留上一份已保存正文；编辑中的内容仍可在浏览器下载。

#### Scenario: Oversized save
- **WHEN** 保存的原生文档字节数超过配置上限
- **THEN** 返回明确的超限错误，不更新正文与版本，编辑器保留当前内容并提供下载

### Requirement: Durable whole-document storage
系统 SHALL 持久化完整原生文档及独立元数据，只有正文和元数据均提交成功后才确认保存。写入失败或进程中断 MUST 不产生半份可读取文档；重启后文件正文与版本 MUST 一致。

#### Scenario: Failure during persistence
- **WHEN** 文档保存过程中出现写入失败或进程中断
- **THEN** 恢复后可读取一致的完整已提交文档，不将未成功提交的保存显示为成功

### Requirement: Permanent deletion
系统 SHALL 在用户明确确认“永久删除，无法恢复”后删除未被占用的文件，不提供历史版本、回收站或恢复接口。

#### Scenario: Confirm deletion
- **WHEN** 有权限用户确认永久删除一个未被占用的文件
- **THEN** 文件不再出现在列表中，正文不能通过原 ID 下载或打开

#### Scenario: Cancel deletion
- **WHEN** 用户取消永久删除确认
- **THEN** 文件及正文保持不变
