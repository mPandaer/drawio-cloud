# Spec Delta

## Purpose

通过自部署官方 draw.io 的嵌入协议连接产品文档与编辑画布，提供以服务端确认为依据的保存状态及异常保护，同时保留可用的官方编辑能力和持续升级边界。

## ADDED Requirements

### Requirement: Trusted embedded document exchange
系统 SHALL 在自部署 draw.io iframe 中加载与交换完整原生文档，宿主 MUST 校验消息 origin、来源窗口与消息结构，仅接受当前编辑器会话的数据，并向明确目标 origin 发送消息。

#### Scenario: Untrusted message
- **WHEN** 其他窗口或错误 origin 发送伪造 autosave 消息
- **THEN** 宿主忽略该消息，不调用保存 API 或改变保存状态

### Requirement: Bounded autosave scheduling
系统 SHALL 仅在内容改变时自动保存，停止修改约 2 秒后触发，持续修改时最多约 10 秒触发一次；同一文档请求依次提交，并保留请求进行期间产生的后续修改。网络或服务故障时不承诺完成时间。

#### Scenario: Continuous editing
- **WHEN** 用户持续修改且上一保存请求已完成
- **THEN** 即使尚未停止编辑，也在约 10 秒内提交最新完整内容

#### Scenario: Edits during a save
- **WHEN** 保存进行期间用户继续修改
- **THEN** 新修改不被丢弃，上一响应不会将新修改标记为已保存，后续请求使用更新版本

### Requirement: Server-confirmed status
系统 SHALL 展示未保存、保存中、已保存及保存失败状态，只有服务器成功提交对应内容且没有更新修改时才能显示已保存。错误 MUST 有明确提示，不把编辑器内的本地状态当作服务端成功。

#### Scenario: Save fails
- **WHEN** 保存返回错误或网络断开
- **THEN** 展示失败或未保存状态并保留画布，服务器上次保存内容不被声称已更新

### Requirement: Temporary failure and exit protection
系统 SHALL 在断网时保留当前画布，恢复连接且仍有有效编辑锁时重试；退出时对失败或待保存修改提示，并允许下载当前 `.drawio`。首期不提供跨关闭恢复草稿，浏览器崩溃可丢失未保存修改。

#### Scenario: Reconnect while owning lease
- **WHEN** 临时网络故障后恢复且窗口仍有有效租约
- **THEN** 重试最新待保存内容，成功后更新状态

#### Scenario: Exit with unsaved work
- **WHEN** 用户尝试产品内退出或关闭有未保存内容的页面
- **THEN** 产品内退出提示保存或下载，页面关闭触发浏览器允许的离开提醒，不静默丢弃内容

### Requirement: Preserve applicable official features
系统 SHALL 保留嵌入模式可用的官方内置图形、图片导出、在线素材和外部 URL 图片能力，联网功能可在网络可用时使用；首期不集成云盘，也不承诺外部引用资源离线可用。

#### Scenario: Optional external image
- **WHEN** 用户在网络可用时使用编辑器支持的外部 URL 图片功能
- **THEN** 产品不主动禁用该功能，保存完整文档并遵循官方内嵌或引用行为

#### Scenario: Offline core workflow
- **WHEN** 浏览器和服务器不能访问公网但局域网服务可达
- **THEN** 用户仍可用本地图形编辑、保存、导入与下载，外网功能失败不阻断核心流程
