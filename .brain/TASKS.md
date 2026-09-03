# 后续优化

- [x] [TASK-PERF-001] 将 `dsh-task-console` 改为轻量启动入口，任务页面、DAG 与 Trace 在用户进入对应界面后再懒加载。（0.17.5）
  - 现状基线：公网冷缓存测试中，HARNESS 完成加载约 71 秒；`dsh-task-console` 客户端传输约 167 KB，单项耗时约 31.6 秒。
  - 约束：保持技术包名、Typert namespace、SQLite 数据与现有任务 URL 兼容。
  - 验收：首屏只加载菜单注册所需的轻量代码；未打开 Board/Trace 时不下载其实现；分别记录冷缓存和热缓存的首屏时间及按需模块加载时间。
  - 实测：本机真实 Chrome 禁用缓存后，轻入口约 1.25 秒注册、传输 6,958 B，未请求 601,209 B 的重模块；点击 Board 后约 1.0 秒呈现任务中心并加载重模块。公网任务详情约 20.1 秒可交互；总 HARNESS 时间仍会受到 Station、Skill/MCP Console 等其他大插件影响。
  - 关联原型：`prototype/task-session-lightweight-v1.html`。

- [x] [TASK-FLEET-001] 为“装机者”增加四个 IP-only 装机工具、固定 Skill 版本、工具级权限隔离、中央账本及 DSH→Cloud Workflow 幂等续跑桥。
  - Stage 2 仅走受限 host-adapter；Stage 5/6/7/8/10 走控制面；Stage 1/3/4/9 为新鲜探测闸门。
  - Cloud 成功后仍须新鲜宿主探测证明健康；运行中操作沿用相同 operation ID 和账本 attempt。
  - 代码和离线回归完成，生产配置、迁移、隔离节点集成验收与部署尚未执行。
