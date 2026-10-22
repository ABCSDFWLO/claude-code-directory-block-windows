---
description: Show which directories directory-block restricts and how to change them
allowed-tools: Read
---

Report the current directory-block configuration to the user. Answer in the user's language.

1. With the **Read tool only** (shell access to these files is blocked on purpose), read:
   - the global config: `directory-block.json` in the user's Claude config directory (`%USERPROFILE%\.claude\directory-block.json`, or `%CLAUDE_CONFIG_DIR%\directory-block.json` when that variable is set)
   - the project config: `.claude\directory-block.json` under the project root `${CLAUDE_PROJECT_DIR}`

   A missing file is normal; just say it does not exist.
2. Summarize the `restricted` entries (with any `reason`), `allow` exceptions and `options`, noting which file each comes from. Point out that the project file can only add restrictions and tighten options.
3. If a file is not valid JSON or an entry is not an absolute Windows path, explain exactly what is wrong. Do **not** edit either file yourself; directory-block blocks that, and the user has to change it.
4. Tell the user how to change the settings from their own terminal (not through Claude):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" add "D:\path\to\restrict" --reason "why"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" remove "D:\path\to\restrict"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" list
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" check -- "type D:\path\to\restrict\file.txt"
   ```

   or to edit the JSON file in an editor. Changes apply to the next tool call; no restart is needed.
