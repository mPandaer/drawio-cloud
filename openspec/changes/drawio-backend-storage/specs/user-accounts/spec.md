# Spec Delta

## Purpose

为少量局域网用户提供一次性管理员初始化、受控账号创建和可撤销登录身份，明确普通用户与管理员的文件权限，保证访问隔离与账号停用后的行为一致。

## ADDED Requirements

### Requirement: One-time administrator registration
系统 SHALL 仅在尚未完成管理员初始化时开放注册页面和初始化注册接口，成功后关闭入口；并发初始化 MUST 只产生一个初始管理员，且不得提供默认密码。

#### Scenario: Concurrent initialization
- **WHEN** 未初始化系统收到两个并发的有效注册请求
- **THEN** 仅一个请求成功创建管理员，另一个被拒绝，后续访问不再显示注册入口

### Requirement: Controlled account management
系统 SHALL 仅允许管理员创建普通账号、重置密码和停用账号；首期不提供公开注册、账号删除和角色变更界面，且 MUST 阻止停用最后一个可用管理员。

#### Scenario: Administrator creates an account
- **WHEN** 管理员提交唯一用户名及有效初始密码
- **THEN** 创建普通账号，该用户可登录并修改密码

#### Scenario: Disallowed management
- **WHEN** 普通用户尝试创建账号，或管理员尝试停用最后一个可用管理员
- **THEN** 操作被拒绝，已有账号状态不变

### Requirement: Revocable login sessions
系统 SHALL 提供登录、退出和当前用户修改密码，登录会话最长保持 7 天；退出使当前会话失效，修改或重置密码使该账号所有旧会话失效。受保护资源 MUST 拒绝未登录、过期或失效会话。

#### Scenario: Password reset invalidates sessions
- **WHEN** 管理员重置某用户密码
- **THEN** 该用户已有会话失效，必须使用新密码重新登录

#### Scenario: Logout or session expiry
- **WHEN** 会话已退出或创建超过 7 天后再次访问受保护资源
- **THEN** 拒绝访问并要求重新登录

### Requirement: Disabled account enforcement
系统 SHALL 在账号停用后立即使其会话失效、拒绝后续保存并释放其编辑锁，保留该账号文件供管理员管理。

#### Scenario: Disable an active editor
- **WHEN** 管理员停用正在编辑的账号
- **THEN** 停用生效后的保存与续租被拒绝，编辑锁释放，原有文件仍存在

### Requirement: Ownership-based authorization
普通用户 SHALL 只能列出、搜索和操作自己的文件；管理员 SHALL 能列出、搜索、查看、下载、编辑、重命名和删除全部用户的文件，但所有角色 MUST 遵守编辑锁与永久删除确认规则。

#### Scenario: Access another user's file
- **WHEN** 普通用户通过文件 ID 请求他人的正文或修改操作
- **THEN** 请求被拒绝，列表及搜索也不暴露该文件

#### Scenario: Administrator edits another user's file
- **WHEN** 管理员打开他人未被占用的文件
- **THEN** 管理员可以取得编辑锁并保存修改，文件归属保持不变
