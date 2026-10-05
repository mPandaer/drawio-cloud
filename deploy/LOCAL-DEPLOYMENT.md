# 本机部署信息

- 仓库：`/opt/drawio-cloud`
- 配置：`deploy/.env`
- 访问入口（均为 HTTP，端口 6768）：
  - http://192.168.9.101:6768
  - http://server.local.com:6768
  - http://100.109.38.54:6768 （Tailscale 网络）
- 客户端必须将 server.local.com 解析到可达的服务器 IP；局域网通常为 192.168.9.101，远程 Tailscale 客户端可解析到 100.109.38.54。
- 首次访问由用户自行创建管理员；没有默认账号密码。HTTP 无传输加密，仅用于可信网络。
- 持久化：Docker 命名卷 `drawio-cloud-data` 挂载整个 `/data`，包含 SQLite、WAL 及文档；禁止 `down -v` 或删除卷。
- 自动重启：`unless-stopped`，宿主 Docker 服务已启用开机启动。
- 本地增加 `ALLOWED_ORIGINS` 逗号分隔白名单，保留精确 Origin 及会话 CSRF 验证。更新代码时请保留 config.ts、accounts/index.ts 和 Compose 的本地修改及对应测试。

## 管理命令

在 `/opt/drawio-cloud` 执行：

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs --tail=100
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

## 备份

命名卷不是备份。备份前停止服务确保 SQLite 及正文一致，再归档整个卷（不要只复制数据库）；归档后重启服务。可通过 `docker volume inspect drawio-cloud-data` 查询宿主数据目录。
