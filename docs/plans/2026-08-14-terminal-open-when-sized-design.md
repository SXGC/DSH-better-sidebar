# 终端尺寸同步设计

**日期**：2026-08-14
**状态**：已实施（2026-08-27 更新隐藏与恢复规则）
**目标版本**：v0.11.x 起；隐藏恢复修复 AGENT-387

## 1. 目标

最初修复 [issue #25](https://github.com/omdsh-dev/DSH-better-sidebar/issues/25)：xterm 在零尺寸容器中 `open()` 会导致渲染器初始化失败。后续确认仅延迟初次 `open()` 不足以保护已打开的终端：非活动 Tab、折叠右栏或折叠底栏使用隐藏布局时，现有 `ResizeObserver` 仍会调用 `FitAddon.fit()`，把网格压缩为 `2×1` 等过渡尺寸并同步给 PTY。

当前设计必须同时保证：

- 初始零尺寸时不调用 `term.open()`；
- 不可见时不调用 `fit()`，保留最后一次有效网格；
- 重新显示后等待容器尺寸稳定，再同步 xterm 与 PTY；
- 活动终端拖动、字体调整和自由窗口缩放仍按帧实时更新；
- WebSocket、输出解析、session 切换、PTY park、重连和关闭语义不变。

## 2. 根因

旧方案 `openWhenSized` 只处理一次性初始化：它在 host 首次出现正尺寸后执行 `term.open()` 和 `fit()`，随后退出。它没有控制后续 `ResizeObserver` 和字体订阅中的 `fit()`。

终端 Tab 实例在非活动状态继续挂载，但祖先通过 `display: none` 隐藏。此时 FitAddon 会把零尺寸容器钳制为极小网格。隐藏期间 WebSocket 仍向 xterm 写入输出；Git 等程序用 `\r` 覆盖进度行时，极小列宽会把逻辑行拆成大量软换行。恢复正常宽度只能重排已经损坏的行，不能恢复原覆盖语义。

因此“现有 ResizeObserver 无需改动”的旧结论不再成立。

## 3. 设计

### 3.1 `terminal-fit-controller`

`src/client/terminal-fit-controller.ts` 是 DOM、xterm 与 WebSocket 之间的内部尺寸控制器。adapter 提供测量、连接状态、`open()`、`fit()`、当前网格、PTY resize 和 animation frame 调度。

控制器状态：

- `hidden`：不 open、不 fit、不发送 resize；`requestFit()` 只延后需求。
- `settling`：可见但等待尺寸稳定；无效尺寸或新的 resize 请求都会重启等待。
- `ready`：已打开且有有效尺寸；活动 resize 在同一 animation frame 合并。
- `disposed`：取消 frame，后续操作均为 no-op。

### 3.2 稳定恢复

初次可见或 `hidden → visible` 后进入 `settling`。只有同时满足以下条件才执行一次 open/fit：

1. 仍可见；
2. host 仍连接到 document；
3. 宽高都大于零；
4. 连续两个 animation frame 没有新的 resize 请求；
5. 两次测量宽高相同。

每次新的 resize 请求递增 generation 并取消旧 frame，旧 callback 不能提交过渡尺寸。`term.open()` 最多执行一次。

### 3.3 活动缩放

进入 `ready` 后，多个 `requestFit()` 合并到一个 animation frame。执行时再次验证 host 连接和正尺寸，然后调用 `fit()`。只有 xterm 的 `cols` 或 `rows` 真正改变时才发送 PTY resize。

这条路径用于活动面板拖动、字体变化和自由窗口缩放，不等待两个稳定 frame，因此保持原有实时反馈。

### 3.4 隐藏期间输出

可见性来自已有 `TabComponentProps.visible`，由 terminal descriptor 原样传入 `TerminalView`。`visible` 变化只调用控制器，不重建 xterm、FitAddon、WebSocket、ResizeObserver 或 PTY session。

隐藏时 WebSocket 和 `term.write()` 继续工作，但不改变网格。xterm 使用最后一次有效列宽解释 `\r` 进度输出；从未获得有效尺寸的终端保留默认 `80×24`。

### 3.5 WebSocket resize

控制器只提交经过验证且去重的实际网格。若 fit 发生在 WebSocket 建立前，`TerminalView` 缓存该网格，并在 `onopen` 时补发；连接建立时不再无条件发送 xterm 默认尺寸。消息 schema 保持 `{ type: 'resize', cols, rows }`。

## 4. 生命周期边界

- 主 React effect 依赖仍为 session、cwd、tabId 和 store；`visible` 不触发终端重建。
- 独立 effect 调用 `controller.setVisible(visible)`。
- cleanup 先 dispose 控制器并取消 frame，再维持原有 observer、订阅、socket 和 xterm 清理顺序。
- tab 关闭发送 `close`、session 切换发送 `park`、同 session 卸载依赖 reconnect grace 的判断不变。
- adapter 调用处继续隔离 xterm dispose 竞态。

## 5. 测试

`tests/terminal-fit-controller.spec.ts` 覆盖：

- 初始隐藏和初始零尺寸；
- 已打开终端隐藏后保持网格；
- 变化尺寸后的两帧稳定恢复；
- 恢复期间快速再次隐藏；
- 活动 resize 合并和重复网格过滤；
- 隐藏字体变化延后、可见字体变化按帧执行；
- detached host、幂等 dispose 和 frame 清理；
- 真实 `@xterm/xterm` buffer 中 Git 风格 `\r` 进度不串接且不产生软换行。

`tests/lazy-chunk.spec.tsx` 守护 terminal descriptor 的 `scope`、`store`、`tabId` 和 `visible` 映射。原 `open-when-sized.ts` 及其测试由控制器和上述测试取代。

## 6. 限制

终端隐藏期间若 viewport 改变，PTY 暂时保留旧的有效尺寸；显示后才同步最终尺寸。这是有意行为，旧有效网格优于不可见或动画中的过渡网格。恢复同步至少延迟两个 animation frame，但不停止终端进程、WebSocket 或输出解析。
