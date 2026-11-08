# Background Tasks (`background-tasks`)

An Antigravity UI plugin that renders a dedicated **Background Tasks** panel in the Auxiliary (side) Pane with zero LLM token consumption.

## Features

- **Current Conversation (Live + History)**: Inspect all background tasks (`run_command`, `IsDaemon` services, and `schedule` timers/crons) from the active conversation and its child subagents, with accurate exit code detection (`exit 0` vs non-zero failure).
- **Cross-Conversation Active Monitor**: Automatically surfaces background tasks currently running in other conversations with one-click navigation (`Open ↗`).
- **Category & Status Filtering**: Filter by `All`, `Running`, `Daemon`, `Schedule`, `Completed`, or `Failed / Canceled`, plus instant keyword filtering across summaries and commands.
- **Live Elapsed Timers**: 1-second ticking timers for running tasks and exact execution durations for completed tasks.
- **On-Demand Live Log Viewer**: Expand any task to stream its `.system_generated/tasks/task-<idx>.log` output with line search, auto-scroll to bottom, and one-click copy.
- **Configurable Schedule Monitor Hooks (`hooks.json`)**:
  - **`PostInvocation` (`Off` | `Cmd` | `Subagent` | `Both`)**: Injects a zero-bloat `ephemeralMessage` reminding the agent to set a `schedule` timer whenever non-daemon background commands and/or child subagents are running without an active `schedule` timer.
  - **`Stop Guard`**: Optionally blocks the agent from ending its turn (`NO_TOOL_CALL`) while monitored background commands or subagents are still running without an active `schedule` timer.

## Installation

1. Clone or copy this folder into your Antigravity plugins directory:

   ```bash
   # macOS / Linux
   git clone https://github.com/DYY-Studio/antigravity-background-tasks.git ~/.gemini/config/plugins/background-tasks
   ```

   ```powershell
   # Windows (PowerShell)
   git clone https://github.com/DYY-Studio/antigravity-background-tasks.git "$HOME\.gemini\config\plugins\background-tasks"
   ```

2. Restart Antigravity and open **Background Tasks** in the right-side auxiliary panel.
