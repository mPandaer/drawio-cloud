# Spec Delta

## Purpose

在所有浏览器与设备之间提供按文件独占的编辑会话，通过有限期限租约和保存版本检查保护文档，避免旧窗口、过期身份或并发请求静默覆盖有效修改。

## ADDED Requirements

### Requirement: Exclusive per-file editing
系统 SHALL 仅允许同一文件存在一个有效编辑窗口，包括管理员；同一用户可以同时编辑不同文件。锁申请 MUST 是原子的，不支持强制抢占。

#### Scenario: Concurrent opening
- **WHEN** 两个浏览器或设备同时打开同一文件
- **THEN** 仅一个窗口获得编辑权，另一个禁止进入编辑状态并提示“该文件已在另一个窗口打开，目前只支持单窗口编辑”，提供重试入口

### Requirement: Lease renewal and expiration
编辑窗口 SHALL 每 10 秒续租，服务端 SHALL 在最近一次成功申请或续租后 60 秒失效租约，正常退出主动释放；过期窗口不得恢复旧租约并直接保存。

#### Scenario: Crashed window expires
- **WHEN** 编辑窗口崩溃且 60 秒内没有成功续租
- **THEN** 其他窗口重试可取得新锁，旧窗口恢复后保存被拒绝

#### Scenario: Clean exit releases lock
- **WHEN** 编辑窗口完成必要保存并正常退出
- **THEN** 锁释放，其他窗口无需等待 60 秒即可打开编辑

### Requirement: Fenced and versioned saves
每次保存 SHALL 校验当前有效账号、文件权限、窗口租约凭据和预期版本；校验与提交 MUST 防止并发覆盖。成功保存增加版本，失效凭据或版本不匹配 MUST 不改变正文。

#### Scenario: Stale save after another lease
- **WHEN** 旧窗口的请求在租约过期且新窗口获得锁后到达
- **THEN** 请求被拒绝，新窗口内容不被覆盖

#### Scenario: Revision mismatch
- **WHEN** 持有有效锁的窗口使用旧版本号保存
- **THEN** 返回版本冲突，正文与版本保持不变，客户端暂停保存

### Requirement: No deletion while editing
系统 SHALL 在删除提交时检查文件租约，任何角色均不得删除有有效编辑锁的文件。

#### Scenario: Administrator deletes occupied file
- **WHEN** 管理员尝试删除正在编辑的文件
- **THEN** 拒绝删除并提示先退出编辑或等待锁释放

### Requirement: Lost-lock and conflict recovery
系统 SHALL 在租约失效后暂停保存并允许下载当前内容；版本冲突 SHALL 提供重新加载服务器版本或将当前内容另存为新文件，不自动合并或覆盖。另存 MUST 重新验证账号、容量和名称。

#### Scenario: Conflict resolution
- **WHEN** 窗口收到版本冲突并选择另存为
- **THEN** 当前内容作为新文件保存，原文件不变，新文件获得独立版本与编辑会话

#### Scenario: Account no longer valid
- **WHEN** 编辑账号停用或会话失效
- **THEN** 停止保存和续租，提示重新登录或联系管理员，当前内容仍可本地下载
