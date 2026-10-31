# aria2 + AriaNg 本机运行包

Windows 上使用 Scoop 安装的 aria2，由一个 PM2 应用统一管理 aria2 RPC 和 AriaNg WebUI。
运行时仅使用 Node.js 内置模块，不需要在解压后的运行包里执行 `npm install`。

## 获取并启动

前提：当前用户已安装 Scoop aria2、Node.js 22 或更新版本、PM2，命令行可运行 `pm2.cmd`。
默认 Scoop 路径为 `C:\Users\<用户名>\scoop`，不用修改成特定用户名。

1. 推送本仓库中的自定义文件后，打开 GitHub **Actions → Build Custom Runtime → Run workflow**。
   `master` 分支的前端、依赖清单、构建脚本或 `.custom` 内容变化也会触发构建。
2. 下载该次运行的 `aria2-webui-<运行编号>` Artifact，取出其中的 `aria2-webui.zip`。
   GitHub 网页下载的 Artifact 自身也可能是一层 ZIP。
3. 将运行包里的 `aria2-webui` 文件夹解压到用户目录，得到
   `C:\Users\<用户名>\aria2-webui\ecosystem.config.cjs`，避免多嵌套一层同名目录。
4. 在 PowerShell 中执行：

   ```powershell
   Set-Location "$env:USERPROFILE\aria2-webui"
   pm2.cmd start .\ecosystem.config.cjs
   ```

5. 浏览器访问 **http://127.0.0.1:6880**。WebUI 自动连接本机 aria2，无需填写 RPC 密钥。
   也可手动执行 `Start-Process 'http://127.0.0.1:6880'`。

## 默认路径和端口

| 用途 | 默认值 |
| --- | --- |
| 运行包 | `%USERPROFILE%\aria2-webui` |
| Scoop aria2 | `%USERPROFILE%\scoop\apps\aria2\current\aria2c.exe` |
| aria2 配置与 RPC 密钥 | `%USERPROFILE%\.aria2\aria2.conf` |
| 任务会话 | `%USERPROFILE%\.aria2\aria2.session` |
| DHT 缓存、其他运行数据 | `%USERPROFILE%\.aria2` |
| 下载文件 | `%USERPROFILE%\Downloads` |
| WebUI | `http://127.0.0.1:6880` |
| RPC | `http://127.0.0.1:6800/jsonrpc` |
| PM2 日志 | PM2 默认日志目录，通常为 `%USERPROFILE%\.pm2\logs` |

`USERPROFILE` 在默认 Windows 安装中位于 C 盘，例如 `C:\Users\Rolin`。
所有用户路径动态计算；运行文件通过自身位置定位，推荐按上述默认目录部署。

## 启停和升级

```powershell
pm2.cmd status
pm2.cmd logs aria2-webui --lines 50
pm2.cmd restart aria2-webui
pm2.cmd stop aria2-webui
# 从 PM2 列表移除应用时：
pm2.cmd delete aria2-webui
```

启动顺序为 Node 协调入口 → PowerShell 启动 aria2 → 带认证的 RPC 健康检查成功 → 开放 WebUI → 通知 PM2 ready。
RPC 30 秒内未就绪会退出并输出原因；端口被其他程序占用时会报错。
PM2 等待 ready 的时间是 35 秒；异常退出后等待 2 秒恢复，连续不稳定启动受 PM2 的重试次数限制。

正常停止时先停止 Web 服务，再请求 aria2 保存会话并正常退出；必要时升级为强制退出。
PM2 为清理预留 15 秒。aria2 还会监控 Node 入口的 PID，降低入口异常终止后残留后台进程的可能。
未完成的任务每 60 秒保存一次，并在退出时保存，启动时从会话文件恢复。
BT/磁力支持 DHT、PEX 和元数据持久化，默认 `seed-time=0`，完成下载后停止做种。

升级时先停止应用，替换运行包文件，再启动。配置与下载目录独立于运行包，首次生成后不会被每次启动重置。
如果已有 `aria2.conf`，脚本保留现有内容；密钥缺失或最后一项为空时才追加随机密钥。
已有配置中的下载、BT 等选项保持原值；上表中的下载和 BT 默认值用于新生成的配置。
RPC 的启用、端口、本机监听、前台运行和会话路径由启动参数统一指定。

Windows 使用 PM2 的 `shutdown` 消息进行正常停止，ecosystem 已配置对应支持。
本包不注册 Windows 登录自启动，也不运行 `pm2 save`。若你另有 PM2 恢复流程，可自行运行
`pm2.cmd save` 保存**整个当前 PM2 应用列表**，并沿用已有的登录启动配置。

## 配置调整

修改 `%USERPROFILE%\.aria2\aria2.conf` 时应先停止服务，使用 UTF-8 编码保存，修改后重新启动。
AriaNg 中通过 RPC 修改的运行参数不等于修改了磁盘配置；希望下次启动沿用的参数应写入配置文件。
脚本通过 `--conf-path` 显式加载配置，不需要为 Scoop 的安装目录添加配置文件。

可通过环境变量或 `ecosystem.config.cjs` 的 `env` 调整以下值：

| 环境变量 | 用途 |
| --- | --- |
| `ARIA2_WEBUI_PORT` | WebUI 端口，默认 6880 |
| `ARIA2_RPC_PORT` | RPC 端口，默认 6800 |
| `ARIA2_DATA_DIR` | 配置、密钥、会话目录 |
| `ARIA2_DOWNLOAD_DIR` | 首次生成配置时使用的下载目录 |
| `ARIA2_PATH` | aria2c.exe 的绝对路径 |
| `ARIA2_POWERSHELL` | PowerShell 可执行文件，默认 Windows PowerShell 5.1 |

例如更改 WebUI 端口后重新加载 ecosystem：

```powershell
$env:ARIA2_WEBUI_PORT = '8080'
pm2.cmd startOrRestart .\ecosystem.config.cjs --update-env
```

此封装每次加载页面时都会将当前 RPC 连接设为配套的本机服务，主题、语言等界面偏好保留。
运行时密钥仅在本机生成，存在配置文件和浏览器的 AriaNg 连接设置中；不写入构建产物或启动 URL。
Node 只提供 `webui` 目录的文件，运行时配置脚本要求同源页面访问且禁用缓存。
WebUI 和 RPC 只监听本机；BT 下载仍通过独立的 peer/DHT 端口与其他节点通信。

## 单独使用 PowerShell 启动器

需要排查 aria2 时，可以在停止对应 PM2 应用后，在运行包目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-aria2.ps1
```

这会以前台方式启动 RPC，使用相同默认目录并保留配置；Ctrl+C 停止。
此模式不启动 WebUI，也不受 PM2 管理。

## 在源码仓库构建

GitHub 工作流为 `.github/workflows/custom-build.yml`，封装源文件集中在 `.custom`。
前端仍由仓库原有 Gulp 普通版构建链生成；仅运行包副本增加自动连接脚本，原始源码和 `dist` 不被定制补丁修改。

首次安装仓库已有构建依赖并构建：

```powershell
node .custom/install-deps.cjs
node .custom/build.cjs
node --test .custom/test.cjs
```

旧版 v1 锁中的固定 Git 包缺少 npm 新版本需要的版本元数据。`install-deps.cjs` 在临时目录
将锁转换为兼容格式、补齐该固定提交对应的版本字段，再执行 `npm ci --ignore-scripts`。
安装后逐项检查版本、来源和 integrity，保持仓库 `package.json`、`package-lock.json` 不变，
不解析升级依赖、不运行安装生命周期脚本。已有 `node_modules` 时可直接构建；该安装器会拒绝覆盖它。

输出为 `build/aria2-webui/`；GitHub 再将它压缩成 `build/aria2-webui.zip`。
打包采用明确的文件列表，配置、会话、下载和本机密钥不会被收集。
测试使用独立临时目录与端口；Windows 且 Scoop aria2 可用时运行真实 RPC 生命周期测试。
