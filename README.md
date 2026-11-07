# Termux Pi 启动工具

在原生 Termux 中安装固定版本 Pi、配置自定义模型，并从手机上的项目目录启动编程代理。当前安装器版本 **0.1.0**，Pi 固定为 **1.5.0**。

这是一个独立的安装与启动封装。Pi 由上游项目提供；模型运行在你配置的服务端，文件和开发命令在手机 Termux 中执行。本项目不下载模型权重，不需要先安装 PRoot/Linux 发行版。

## 一行命令安装

在**原生 Termux 的普通 shell 提示符**输入，不要在 Pi 聊天输入区执行：

```sh
(command -v curl >/dev/null || pkg install -y curl) && curl -fL https://raw.githubusercontent.com/shigenben/termux-pi/v0.1.0/install.sh -o "$TMPDIR/termux-pi-install.sh" && bash "$TMPDIR/termux-pi-install.sh"
```

这是一条启动在线安装的命令。安装器会检查环境，显示需要安装的依赖，安装固定版本 Pi，并在终端中引导填写模型配置。首次安装仍需要网络以及你自己的模型 API Key；输入密钥时不回显。不要把密钥写进下载命令、仓库或截图。

默认配置是 DeepSeek 的 Anthropic Messages 兼容接口：

| 项目 | 默认值 |
| --- | --- |
| Base URL | `https://api.deepseek.com/anthropic` |
| API 类型 | `anthropic-messages` |
| 模型 ID | `deepseek-flash` |

也支持配置使用 HTTPS 的自定义 Anthropic Messages 或 OpenAI Chat Completions 兼容服务。协议兼容性仍取决于服务端；发布验证的端点见下文。接口地址填写 API 基地址，不是服务控制台地址。

安装完成后：

```sh
pi-termux doctor
pi-termux start
```

第一行离线检查安装、配置和凭据文件状态，不发模型请求；第二行启动 Pi，默认项目目录为安装根目录中的 `workspace/`。进入 Pi 后用自然语言交代任务，并查看它实际调用的文件工具、命令与结果。

## 常用操作

```sh
pi-termux configure
pi-termux demo
pi-termux start "$HOME/my-project"
pi-termux guard-check "$HOME/my-project"
pi-termux --help
```

- `configure` 重新设置模型；保留密钥的方式以交互提示为准。公开配置只存环境变量引用，真实密钥存于私有文件。
- `demo` 创建一份新的无依赖 Node 示例，不覆盖之前的示例。它会打印项目路径，按提示启动后可让 AI 读取说明、先跑失败测试、修改源码再复测。
- `start PATH` 在明确指定的 HOME 内项目中启动；项目需要是实际目录，不能是共享存储入口、HOME 本身或安装配置目录。
- `guard-check PATH` 离线检查本次文件工具策略，不调用模型。它不能代替模型开发验收或操作系统沙箱验证。

默认关闭自动发现扩展、MCP、skills、项目上下文与提示模板，使用专属配置目录；关闭会话持久化。本工具提供基础文件工具与 shell，按指定项目工作。文件工具限制路径，shell 子进程清理凭据类环境变量；**shell 仍拥有 Termux UID 的系统权限，这不是 OS 沙箱。** 在真实项目中，仍应审查命令与源码差异。

## 手机上如何打开键盘

0.1.0 的启动预设使用 Pi 的 `--tui-mode regular`，避免默认全屏交互与手机点按输入之间的部分冲突。它是启动方式调整，未修改上游 Pi 的代码。

本机已在新启动器的regular界面做两次“收起→点按”检查：ADB的`mInputShown`均从false变为true，截图确认软键盘显示。没有改Android输入法或Termux全局设置。尚未与原全屏模式做完整设备对照，不把它写成所有机型的根因修复。

若软键盘收起后点空白处仍无法弹出，可以展开 Termux 左侧会话栏，**单击 `KEYBOARD`**。长按该按钮及音量上加 K/Q 切换的是额外按键工具条，含义不同；这一手动入口来自源码核查，本轮未单独实测。

原始用户反馈发生在 Pi 全屏界面。上游固定版本源码显示，全屏模式启用终端鼠标报告；Termux 在鼠标跟踪开启时将点按交给终端程序，跳过普通点按唤键盘路径。是否在某一机型上解决，需以设备实测为准。安装成功与完整手机触摸体验是不同验收项目。

## 安装位置、重复安装和下载包

默认安装在 `$HOME/.termux-pi`：

| 路径 | 用途 |
| --- | --- |
| `runtime/` | 固定版本 Pi 及 npm 依赖 |
| `releases/0.1.0/`、`current` | 本启动工具的版本文件和当前入口 |
| `bin/pi-termux` | 本地启动命令 |
| `config/` | 模型连接设置及 Pi 独立配置 |
| `private/api-key` | 权限为 0600 的私有密钥文件 |
| `workspace/`、`workspaces/` | 用户工作目录及示例 |

默认添加 `$PREFIX/bin/pi-termux` 链接。已有不属于本工具的同名命令或非空安装目录会报错，不自动覆盖。重复运行会校验既有版本，保留配置、密钥和工作文件。同版本内容不同时拒绝覆盖，修订后应发布新版本。

独立测试可用：

```sh
bash install.sh --root "$HOME/termux-pi-test" --no-link --skip-configure --yes
```

它使用新目录，不占用默认 `pi-termux` 命令。`--skip-configure` 只安装，随后可用该目录下的 `bin/pi-termux configure` 配置。`--yes` 仅接受明确列出的依赖安装，不授权升级全部环境。

发布包 `termux-pi-0.1.0.tar.gz` 只含可审查源码、示例和说明，配有 `SHA256SUMS`；没有 node_modules、个人密钥或手机日志。下载包仍需联网获取 Termux/npm 依赖。源码载荷有单独校验清单；校验用于检查完整性，不替代对发布来源的信任。

## 环境与验证范围

要求：原生 Android Termux、可用软件源、Node.js ≥22.19。安装器按需安装 `nodejs npm git ripgrep fd curl tar`，不执行整套环境 upgrade。Pi 使用上游建议的 `--ignore-scripts` 方式安装，并由显式 Node 入口启动。

已验证的基础路线：Android 16、ARM64、Termux `googleplay.2026.10.09`，Node v26.3.1，Pi 1.5.0；DeepSeek Flash 经 Anthropic Messages 完成真实 read/edit/bash：原始测试 10 通过/5 失败，单次修改后 15/15 通过，独立手机复验 15/15。仅样例源文件改变，测试文件保持不变。

安装器自身已完成独立手机安装、模型配置、doctor与SDK入口检查、示例AI修复和重复安装：示例最终15/15通过，只有源文件改变；模型配置和私有凭据逐字节保留，载荷11/11匹配。手机应用测试9通过、0失败、1项硬链接探针因系统EACCES无法创建而跳过。电脑端安装器10项离线回归通过。已有依赖和npm缓存条件下，两次候选的npm安装分别约35秒、16秒，不代表全新环境固定耗时。

本次安装器任务以Pi的`--print`模式运行，保留最终文本、源文件哈希和外部复验；它没有完整逐次JSON工具事件流。更早基础路线实验另有完整事件验收，二者不混作同一轮证据。

一次小型 Node 样例的成功不能代表所有机型、Termux 分支、扩展、大型项目或后台运行均兼容。编辑器、完整手机触摸 UI、本机离线模型和会话恢复不在当前承诺中。

## 本地构建

```sh
python scripts/build-release.py
```

构建脚本只读取发布白名单，统一 LF 和压缩包文件权限，生成 `app-manifest.sha256`、`dist/termux-pi-0.1.0.tar.gz` 及 `dist/SHA256SUMS`。不收集本机配置或历史目录。

## 上游资料

- [Pi 官方项目](https://github.com/earendil-works/pi)
- [Pi 固定 1.5.0 的 Termux 说明](https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/coding-agent/docs/termux.md)
- [Pi 固定 1.5.0 的 CLI 参数](https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/coding-agent/docs/cli.md)
- [DeepSeek Anthropic Messages 接口](https://api-docs.deepseek.com/guides/anthropic_api/)

本仓库封装代码使用 MIT License；Pi 与其他依赖继续遵循各自许可证。
