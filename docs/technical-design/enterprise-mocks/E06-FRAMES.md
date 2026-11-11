# E06 Paper frames

Paper file `01M1X504XVC45FC0VDK857A37D`, page `p-18-0` (`17 · Product · Conversations, plans & coordination`). Native Paper elements on the enterprise shell (208px rail, Geist, file tokens; dark frames bind the `--color-dark-*` map). Synthetic data; copy from `packages/i18n/locales/en.json`.

Source: `paper-source/<nodeId>.jsx` + `.computed-styles.json`, listed in `paper-source/source-manifest.json`. Site: `site/index.html?screen=1&theme=<theme>#<id>/<state>`.

| Node | Screen id | Route | State | Theme | Device | Size |
| --- | --- | --- | --- | --- | --- | --- |
| `2IBL-0` | `task-conversation` | `/tasks/$taskId` | default | light | desktop | 1440×900 |
| `2IFZ-0` | `task-conversation` | `/tasks/$taskId` | default | dark | desktop | 1440×900 |
| `2J3V-0` | `task-conversation` | `/tasks/$taskId` | default | light | phone | 390×844 |
| `2IK1-0` | `task-conversation` | `/tasks/$taskId` | plan-review | light | desktop | 1440×900 |
| `2IO3-0` | `task-conversation` | `/tasks/$taskId` | question | light | desktop | 1440×900 |
| `2IS5-0` | `task-conversation` | `/tasks/$taskId` | empty | light | desktop | 1440×900 |
| `2IW7-0` | `task-conversation` | `/tasks/$taskId` | conflict | light | desktop | 1440×900 |
| `2J64-0` | `task-coordination` | `/tasks/$taskId/coordination` | default | light | desktop | 1440×900 |
| `2JD6-0` | `task-coordination` | `/tasks/$taskId/coordination` | default | dark | desktop | 1440×900 |
| `2JQJ-0` | `task-coordination` | `/tasks/$taskId/coordination` | default | light | phone | 390×844 |
| `2JH8-0` | `task-coordination` | `/tasks/$taskId/coordination` | empty | light | desktop | 1440×900 |
| `2JLA-0` | `task-coordination` | `/tasks/$taskId/coordination` | partial | light | desktop | 1440×900 |
| `2JSH-0` | `projects-onboarding` | `/projects/onboarding` | default | light | desktop | 1440×900 |
| `2JZO-0` | `projects-onboarding` | `/projects/onboarding` | default | dark | desktop | 1440×900 |
| `2K4U-0` | `projects-onboarding` | `/projects/onboarding` | default | light | phone | 390×844 |

Notes:

- `task-coordination` `default` shows a running plan (waiting, running, failed, stopped lanes); `partial` adds the terminal partly-delivered state with its notice.
- Baselines and `ui-baselines/*` are not registered here (phase 8).
