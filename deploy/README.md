# 单机部署与运行

本项目使用一个 Compose 服务：容器内 Nginx 提供产品 `/`、固定版本编辑器 `/editor/`，并将 `/api/` 代理至唯一 Node API 进程。SQLite 与完整原生正文保存在 `/data`；数据目录不会通过静态入口公开。首期支持桌面 Chrome、Edge 当前稳定版本，不验收移动端编辑。

## 初始化与构建

需要 Git、Docker Engine 和 Docker Compose v2。首次联网构建还需下载 Node 镜像、系统包和 pnpm 依赖。必须保留产品 `.git` 和编辑器 submodule 的 Git 元数据：打包脚本检查固定提交及 submodule 是否干净，不能直接使用缺少 Git 元数据的源码压缩包。

在产品仓库根目录执行：

```sh
git submodule update --init --recursive
cp deploy/.env.example deploy/.env
```

编辑 `deploy/.env`，将 `PUBLIC_ORIGIN` 改为浏览器实际访问的入口，例如 `http://192.168.1.10:8080`。不要填写容器地址或浏览器自己的 localhost；只填写协议、主机与端口，不带路径、查询或片段。`HTTP_PORT` 改动时也要修改 `PUBLIC_ORIGIN`。

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs --tail=100 drawio-cloud
```

健康检查通过容器 Nginx 请求 `/api/health`，成功响应为 `{"status":"ok"}`，同时检查代理及 API 可达。它不替代首次保存、磁盘持久化和无公网验收。

若在本机构建，需要根 `package.json` 指定的 Node 24 与 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

根构建命令依次执行 `pnpm --filter @drawio-cloud/server build`、`pnpm --filter @drawio-cloud/web build`、`node scripts/build-editor.mjs`，产物分别为 `apps/server/dist`、`apps/web/dist`、`build/editor`。编辑器资源来自固定 submodule；当前 packager 校验 v32.0.2 的完整提交。没有修改官方源码时不需要 Ant 重编译。

## 配置与持久化

- `PUBLIC_ORIGIN`：外部浏览器入口，必须与实际 Origin 一致，变更 API 会校验 Origin 和会话 CSRF 凭据。
- `HTTP_PORT`：宿主映射端口，默认 8080；容器 Nginx 固定 8080，API 固定监听 `127.0.0.1:3000`，不公开 API 端口。
- `BIND_ADDRESS`：宿主绑定地址，默认 `0.0.0.0`。HTTPS 网关与容器位于同一宿主时可使用 `127.0.0.1`。
- `MAX_DOCUMENT_BYTES`：完整原生文档的 UTF-8 字节上限，默认 20971520（20 MiB），导入与保存使用同一限制。容器入口自动将 Nginx body 上限设为 `6 × MAX_DOCUMENT_BYTES + 65536`，与 API 一致，给 JSON 编码留出空间。额外代理也必须使用此公式；正文仍按实际文档字节再次校验。
- `COOKIE_MODE`：HTTP 配置 `http`，HTTPS 配置 `https`（启用 Secure Cookie），必须与 `PUBLIC_ORIGIN` 协议一致。
- `DATA_VOLUME_NAME`：默认命名卷 `drawio-cloud-data`。保持名称不变，容器重建继续使用原数据。
- `DATA_DIR`：容器内固定绝对路径 `/data`。直接运行服务端时也必须提供绝对路径，例如 `/srv/drawio-cloud/data`，不能使用相对路径；目录必须可写且位于支持原子重命名及同步的本地文件系统，避免网络文件系统。
- `TRUSTED_PROXIES`：本单容器代理地址固定 `127.0.0.1`，Compose 已明确配置，禁止使用裸 `true` 或信任所有来源。若改成独立代理容器，必须为代理配置固定容器 IP，并把该 IP 写入 API 的 `TRUSTED_PROXIES`；不要使用客户端 IP 或随容器重建变化的地址。

Nginx 透传浏览器 Origin，并覆盖 forwarded 头以避免客户端伪造。仅设置 `frame-ancestors 'self'` 的 CSP，允许同源 iframe，不禁止官方可选外网素材请求。`/editor` 归一化到 `/editor/` 并保留查询参数，以保证编辑器相对资源地址正常。

命名卷在容器重建或普通 `docker compose down` 后保留。**不要执行 `docker compose down -v`，不要删除命名卷或更换卷名后误认为原数据消失。** 若改用宿主 bind mount，请提供绝对路径、事先创建目录并授予容器 node 用户（UID/GID 1000）读写权限；同时挂载 SQLite、WAL 和正文所在的整个数据目录。

系统仅支持单个 API 进程，禁止 Compose 扩容、多副本部署或多个实例共享 `/data`。Nginx worker 不属于 API 副本。数据挂载不是备份；首期不提供自动备份、历史版本或回收站，磁盘故障无产品级恢复保障。

## 首次管理员与首次保存

1. 在首次启动的空数据卷上，通过 `PUBLIC_ORIGIN` 进入中文初始化页面，注册管理员。没有默认账号或默认密码；初始化成功后永久关闭注册入口，普通账号由管理员创建。
2. 登录管理员，在文件列表新建文件并打开编辑器，修改图形，等待宿主显示“已保存”。只有服务端确认提交后才代表保存成功。
3. 下载原生 `.drawio`，重新打开确认正文一致；随后退出编辑，避免有效租约影响再次打开。异常关闭可能需要等待最长 60 秒租约过期。
4. 保留数据卷执行容器重建，再登录并打开、下载文件，确认账号、正文和版本仍存在。

普通用户仅操作自己文件，管理员可管理全部文件，但不能抢占编辑锁或删除正在编辑的文件。永久删除需确认且无法恢复。会话失效、锁丢失、超限或网络故障时，按界面提示下载当前内容；页面崩溃或关闭后没有跨关闭草稿恢复。

## HTTPS 与网络边界

局域网 HTTP **没有传输加密**，账号凭据和正文会经过明文网络。需要 HTTPS 时，在外部 Nginx 网关使用 `https-nginx.conf.example`，替换域名、证书和上游地址，将 `PUBLIC_ORIGIN` 改为真实 `https://` 入口，同时设置 `COOKIE_MODE=https`。网关与产品同宿主时绑定 `BIND_ADDRESS=127.0.0.1`；独立网关部署时将内部端口限制在受控网络。

HTTPS 示例 `https-nginx.conf.example` 的 `client_max_body_size` 是硬编码值；修改 `MAX_DOCUMENT_BYTES` 后，必须手动按 `6 × MAX_DOCUMENT_BYTES + 65536` 同步该值。

额外网关必须保留 Origin 和 Host，并协调 body 上限。API 只信任与其直连的容器内 Nginx (`127.0.0.1`)；当前配置在这一层使用直接来源，外层网关后客户端限速会共享网关地址。如需保留真实客户端 IP，必须明确配置 Nginx 的可信网关 IP 与 real_ip 规则，不能直接相信任意客户端的 forwarded 头。

核心脚本、中文语言包和内置图形由本地提供。在线素材、外部 URL 图片、字体或官方远程导出/代理服务依赖外网及相应官方服务条件；外部引用不保证离线可用，部分导出还受浏览器跨域及 canvas 限制。没有云盘 OAuth 集成，也没有额外部署官方图片/PDF 渲染服务。无公网时的核心编辑和保存仍须在发布验收中实际验证。

## 升级边界与待验收

产品仓库 gitlink 决定编辑器版本，不自动追踪官方 dev。升级应在独立分支同步 fork 中选定的官方标签/提交，必要源码改动使用官方 Ant 构建；更新 packager 的版本校验并验证协议和资源兼容后，才更新产品 submodule 指针和构建镜像。产品业务修改与上游同步提交分开。

升级前停止唯一 API 进程，保留完整数据卷；后续 schema 升级必须采用明确迁移，不能清空数据。回退只适用于旧代码仍兼容当前 schema 的情况，不承诺无备份回滚。

当前环境 Docker 未安装，容器部署测试按要求暂不执行：**无法验证compose语法，Docker未安装**。本地构建结果不能替代镜像构建、容器健康检查、局域网 HTTP/HTTPS Cookie、首次注册与首次保存、保留挂载重建和无公网流程验证。这些项目仍待具备容器环境后验收，OpenSpec 6.1、6.2 保持未完成。
