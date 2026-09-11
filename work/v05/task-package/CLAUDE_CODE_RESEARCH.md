# Claude Code 官方资料与本任务的使用方式

本任务使用官方 Claude Code 文档核对命令。不要根据文档抓取时的功能，推断本机旧版本或受组织限制的账户一定可用。

## 已核对的原始资料

1. **Keep Claude working toward a goal**
   `https://code.claude.com/docs/en/goal`
   核对 `/goal` 的长度、触发、评估、状态、清除、恢复与终止条件。

2. **Model configuration**
   `https://code.claude.com/docs/en/model-config`
   核对 `fable`、版本门槛、effort 和账户计费提醒。

3. **Create custom subagents**
   `https://code.claude.com/docs/en/sub-agents`
   核对独立上下文、任务隔离和 worktree 行为。

4. **Orchestrate teams of Claude Code sessions**
   `https://code.claude.com/docs/en/agent-teams`
   核对实验性质、协调成本和避免同文件并发修改。

5. **Best practices for Claude Code**
   `https://code.claude.com/docs/en/best-practices`
   核对可执行验证、独立审计、长会话上下文管理。

6. **Choose a permission mode**
   `https://code.claude.com/docs/en/permission-modes`
   核对 permission mode 和长期执行目标是不同机制。

7. **Hooks reference**
   `https://code.claude.com/docs/en/hooks`
   了解 Stop hook，不作为本包必须安装的配置。

## 工程选择，不是 Claude Code 的自动保证

本包选择：主任务书存文件，短 goal 指向它；实施角色与复核角色分开；归档在独立目录重建；任务结束必须有执行证据。工作流不依赖启用 agent teams，不强装 hooks，不修改用户全局配置。

本包要求 Claude 编写的 `scripts/verify-v05.mjs` 是 Syna 项目自己的验收程序，不是 Claude Code 内置功能。`work/v05/STATE.md`、验收编号和审计账本也同样是本任务制定的项目约定。

不能因为目标评估器允许结束，就推断项目所有质量要求已被机器证明；不能因为存在多个 agent，就将意见一致冒充独立实证。最终仍以源码、可重跑测试、真实后端和归档重建记录为依据。

## 参考代码来源

本任务的历史起点是对话中交付的 Syna v0.4 源码归档；最新裁剪来自用户随后对 Hyla-mini 和 v0.5 范围的讨论。旧 RFC 仅用于理解历史，不凌驾于主任务书；本包没有把旧 RFC 当作未经修订的最终规范。
