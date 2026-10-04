# Spec Delta

## Purpose

让少量用户可以在单台局域网服务器上部署和持续运行完整绘图服务，明确统一访问入口、数据持久化、离线核心功能、配置能力以及首期支持的浏览器范围。

## ADDED Requirements

### Requirement: Single-server Compose deployment
系统 SHALL 提供 Docker Compose 部署方式，在单台服务器运行产品前端、API 和固定版本的自部署编辑器，不依赖 MinIO 或外部数据库服务。

#### Scenario: First deployment
- **WHEN** 运维人员初始化编辑器 submodule 并按部署说明构建及启动 Compose
- **THEN** 可进入管理员初始化注册，再完成登录、新建、编辑与保存

### Requirement: Unified configurable access
系统 SHALL 将产品页面、API 和 iframe 编辑器放在同一 HTTP 入口，地址与端口可配置，支持以后在反向代理接入 HTTPS；受保护正文不得作为匿名静态文件暴露。

#### Scenario: LAN address access
- **WHEN** 用户通过服务器局域网地址和配置端口访问
- **THEN** 产品与编辑器可正常通信和保存，不使用硬编码 localhost 地址

#### Scenario: Anonymous storage access
- **WHEN** 未登录访问持久化文档路径或 API
- **THEN** 无法获得文档正文

### Requirement: Persistence across container lifecycle
系统 SHALL 将数据库和正文保存在明确的持久化挂载中，容器重建或服务重启不得删除已提交数据；首期不提供自动备份或历史恢复。

#### Scenario: Recreate containers
- **WHEN** 停止并重建容器且保留数据挂载
- **THEN** 账号、文件和已提交正文仍可使用，版本一致

### Requirement: Locally available core assets
系统 SHALL 本地提供完成登录、文件管理、编辑、保存、导入和下载所需的脚本、样式及内置图形；可选外网资源不得成为核心启动的必要条件。

#### Scenario: Public network unavailable
- **WHEN** 服务启动后公网不可达且浏览器无外网访问
- **THEN** 核心页面与编辑器仍能加载并完成原生文档往返保存

### Requirement: Supported client experience
系统 SHALL 提供中文产品界面，并以桌面 Chrome、Edge 当前稳定版本为首期支持与验收范围；手机和平板编辑不作为首期验收目标。

#### Scenario: Supported desktop workflow
- **WHEN** 用户通过受支持桌面浏览器访问
- **THEN** 登录、搜索、编辑、冲突提示和下载流程可操作且产品提示使用中文
