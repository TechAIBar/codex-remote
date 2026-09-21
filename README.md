# codex-remote

在手机浏览器里查看、续写 ChatGPT 桌面端（Codex）的对话：本机对话 + 桌面端通过 SSH 连的远程机器上的对话。支持流式输出、命令/文件审批、中断、新建对话。

- 零依赖：只用机器上已有的 Node、桌面端自带的 codex.exe、Windows OpenSSH。
- 独立进程：不改桌面端任何配置，桌面端照常开关。
- 安全：登录口令 + HTTPS 自签证书；5 次错口令锁 15 分钟；只放行对话相关的协议方法（不暴露文件/进程/配置）。

## 目录

| 文件 | 作用 |
| --- | --- |
| `server.js` | 网关：HTTPS + 登录 + WebSocket，桥接到本机/远程 app-server |
| `config.example.json` / 本地 `config.json` | 端口、主机列表（本机 + ssh 主机） |
| `lib/appserver.js` | 本机 stdio / 远程 ssh+proxy+websocket 两种连接 |
| `lib/auth.js` `lib/cert.js` `lib/wsframe.js` | 鉴权、证书、WebSocket 帧 |
| `public/` | 手机端页面（可"添加到主屏幕"） |
| `start.cmd` | 前台启动（看日志用） |
| `start-hidden.vbs` | 后台无窗口启动，日志在 `data/server.log` |
| `stop.cmd` | 停止网关 |
| `install-autostart.cmd` | 注册登录后自启（计划任务，需管理员） |
| `allow-firewall.cmd` | 放行 8443（需管理员） |
| `test-client.js` `test-browser.js` | 自测脚本（可删） |
| `data/` | 运行时数据：口令哈希、token、证书、日志。**不要外传** |

## 第一次使用

0. 安装 Node.js，确保 `node` 在 PATH 中；也可通过环境变量 `CR_NODE` 指定 `node.exe` 的完整路径。
   将 `config.example.json` 复制为 `config.json`，再按自己的环境配置。
   本机 Codex 默认从当前 Windows 用户的 `%LOCALAPPDATA%\OpenAI\Codex\bin` 定位；
   自定义安装可设置 `CODEX_BIN_DIR`，或在本地配置中填写 `codexBinDir` / `codexBin`。
   `config.json` 属于私有部署配置，已被 Git 忽略。


1. 设置口令（至少 8 位）：

       start.cmd set-password 你的口令

2. 放行防火墙（右键"以管理员身份运行"）：`allow-firewall.cmd`
3. 启动：双击 `start.cmd`（前台，能看日志）或 `start-hidden.vbs`（后台）。
   启动日志会列出所有可访问地址，例如 `https://<your-host>:8443`。
4. 手机连 VPN，浏览器打开上面的地址 → 输入口令。

### 手机端去掉证书警告（可选，推荐）

证书是自签的，第一次浏览器会提示"不安全"。两种处理：

- 直接点"继续访问/高级 → 继续"，功能不受影响。
- 一劳永逸：手机浏览器访问 `https://<电脑IP>:8443/cert.cer` 下载证书，鸿蒙里到 设置 → 安全 → 更多安全设置 → 从存储设备安装 → CA 证书，装上后不再警告。

证书 SAN 里包含了生成时电脑的所有 IPv4。如果电脑的 VPN IP 变了导致浏览器又报警告，删掉 `data/cert.pfx`、`data/cert.pass`、`data/cert.cer` 重启即可重新生成（手机上要重新装一次证书）。也可以把固定 IP/域名写进 `config.json` 的 `extraNames`。

## 网页端选择模型

打开一条对话后，标题下方的“模型”下拉框会从该对话所在主机获取可用模型（本机和 SSH 主机分别加载），右侧 ↻ 可重新获取列表。已有会话的自定义或隐藏模型会保留显示，不会自动替换成列表默认项。

选择模型后，从网页发送的下一条消息开始生效，后续轮次沿用该会话设置；仅选择但不发送不会修改服务端。“沿用会话设置”可取消待发送的选择。运行中请先等待结束或点“停止”。列表获取失败不会阻止沿用原模型发消息。

此功能仅修改网关网页，不修改桌面端启动参数、全局配置或安全设置，也不解决本机独立 app-server 与桌面端的实时同步问题。修改后刷新网页即可，无需重启桌面端或网关。新建对话的第一条消息仍沿用主机设置，进入聊天窗口后可为后续消息选择模型。

回归测试依赖本地安装的 `playwright-core` 和 Chrome/Edge；可用 `CR_NODE_MODULES` 指定模块所在目录。

回归测试：`node test-model-picker.js`（或 `npm run test:model-picker`；仅模拟接口，不读取登录凭据、不发送真实消息）。

## 开机自启

右键"以管理员身份运行" `install-autostart.cmd`，会注册计划任务 `codex-remote`，登录 Windows 后自动后台启动。卸载：`schtasks /delete /tn codex-remote /f`。

电脑需保持不睡眠（设置 → 系统 → 电源 → 睡眠：从不），否则手机连不上。

## 远程主机

在本地 `config.json` 的 `hosts` 中添加自己的 SSH 配置，例如：

```json
{
  "id": "remote",
  "label": "Remote",
  "type": "ssh",
  "ssh": "my-remote",
  "sock": "/path/to/app-server-control.sock"
}
```

`my-remote` 是你在 SSH 配置中定义的别名；请将 socket 示例替换为目标机器的实际路径。
SSH 凭证由本机 SSH 客户端管理，不应复制到本项目中。


`config.json` 里 `hosts` 数组中 `type: "ssh"` 的条目对应桌面端里连的远程机器。网关通过 `ssh <host> "codex app-server proxy --sock <path>"` 接到那台机器上桌面端已经拉起的 app-server 守护进程，所以看到的对话和桌面端一致，续写也在同一个会话里。

要求：`~/.ssh/config` 里已配好免密登录（桌面端能连就说明已经配好）。`sock` 路径可在远程机器上 `ls ~/.codex/app-server-control/` 或桌面端的远程配置里找到。

首次连接时如果远程主机不在 known_hosts 里会失败（BatchMode），先在电脑上手动 ssh 一次。

## 安全说明

- 仓库只包含配置示例，不包含登录凭证、证书、截图或真实部署地址。
- `data/`、`config.json`、`.env*`、证书和数据库文件不得提交或打包发布。
- `probe*.js` 和测试脚本会读取真实对话或登录状态；终端输出、截图及测试报告也属于私有数据。
- 浏览器测试可设置 `CR_NODE_MODULES` 指向本地 `playwright-core` 模块目录，
  `CR_TEST_QUERY` 指向专门用于测试的对话。`--send` 会向该对话发送测试消息。
- `node --test test/config.test.js` 只验证配置加载，不连接桌面端或远程服务器。
- 推送前检查 `git diff --cached` 和 `git ls-files`，确认只有准备公开的文件。
- 网关允许已登录用户发送消息和处理审批；对话中的代理仍可能执行命令或修改文件。
  请仅向可信用户开放，并优先通过可信局域网或 VPN 访问。


- 口令用 scrypt 哈希存储；登录成功后发 30 天有效的随机 token（HttpOnly + Secure + SameSite=Strict cookie）。
- 同一 IP 连续 5 次错口令锁 15 分钟。所有登录尝试和已登录设备可在页面"设置"里看到，并可一键"注销所有设备"。
- 网关只转发白名单里的协议方法（对话列表/读取/续写/中断/新建/审批回复），`fs/*`、`command/exec`、`config/*` 等一律拒绝。
- 换口令：`start.cmd set-password 新口令`（会注销所有设备）。作废所有登录：`start.cmd revoke`。

## 常见问题

- **手机连不上（超时/无法访问），但电脑上用自己的 IP 能打开**：几乎都是防火墙。Windows 第一次弹"是否允许 node.exe 访问网络"时若点了取消，会自动生成一条针对 node.exe 的入站 **Block** 规则，Block 优先级高于 Allow，单独放行 8443 端口没用。管理员运行 `allow-firewall.cmd` 会自动删除这条 Block 规则并补上按程序放行的规则。检查命令：`netsh advfirewall firewall show rule name=node.exe`，应显示"没有规则匹配"。
- 其他排查顺序：电脑上 `netstat -ano | findstr :8443` 要有 LISTENING；手机和电脑要在同一 VPN 网段（电脑 `ipconfig` 里对应网卡的 IPv4）；地址必须带 `https://` 和 `:8443`；证书警告点"继续访问"或先装证书。
- **本机对话与桌面端的关系**：Windows 版桌面端没有对外接口，网关只能自己再拉一个 `codex.exe app-server`，和桌面端各自维护内存状态、共同读写同一份会话文件。因此：
  - 手机上发的消息，桌面端要重新打开那条对话（或重启桌面端）才会看到；反之亦然。
  - 列表里的"运行中"只反映网关自己这边的状态，桌面端正在跑的对话在手机上显示为空闲。
  - 避免桌面端和手机同时给**同一条本机对话**发消息，两边会各跑一轮并交错写文件。
- **远程主机没有这个问题**：网关接的是桌面端已经拉起的那个守护进程，两边看到的是同一个会话，实时同步，桌面端正在跑的轮次手机上能看到流式输出、也能审批和中断。
- 同一条对话已有轮次在跑时再发消息，会收到 "turn already in progress" 之类错误提示，等它结束或先点"停止"。
- 页面显示"加载失败：initialize timeout"：本机 codex.exe 启动失败，看 `data/server.log`。
- 远程 tab 一直"连接失败"：在电脑上手动 `ssh <host> "codex app-server proxy --sock <path>"` 看报错；常见是远程守护进程没起（桌面端连一次远程即可拉起）。
