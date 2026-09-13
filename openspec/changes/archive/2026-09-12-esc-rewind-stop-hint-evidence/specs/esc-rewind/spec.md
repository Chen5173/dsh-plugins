## MODIFIED Requirements

### Requirement: 「再按 Esc 回退」提示只在用户主动停止后出现

系统 SHALL 仅在**本会话内出现过 `running` 由 true 变 false 的下降沿**、且该回合能被判定为**用户主动停止**时，才显示「再按 Esc 回退本轮」提示。判定 MUST 只使用宿主写入的耐久证据，MUST NOT 以「尾部非 settled」这类瞬态客户端投影单独作为停止依据（运行中的 assistant 行在客户端投影里不产出节点，下降沿那一刻的尾巴通常是本轮刚发出的 user 提问，据此判定会在自然结束时误弹）。停止证据为：该回合的 assistant 行带 `interrupted` 标记，或该回合 `turn/end` 的原因 `kind` 为 `aborted` 且取消原因 `kind` 为 `user`（后者覆盖「尚未产出任何内容即被停止」的回合）。自然结束证据为：该回合的 assistant 行为 settled，或该回合 `turn/end` 为其它终态（`completed`/`error`/`max-tokens`/`blocked`）。判定 MUST 在该回合定型之后结算（`running` 位与对话投影的到达顺序不保证）：未定型时 MUST NOT 提示、MUST NOT 判定为停止。提示 MUST 每回合至多一次，草稿非空时 MUST NOT 提示。首次挂载或切换进入一个**本身就非正常结束**的历史会话（例如上一轮 429 失败、或历史上被中断的回合）时，因本会话内没有下降沿，MUST NOT 弹出该提示。

#### Scenario: 自然正常结束不提示（即使对话投影尚未落定）

- **WHEN** 回合自然正常结束，`running` 由 true 变为 false，而此刻客户端对话投影尚未落定（尾部仍是本轮刚发出的 user 提问，尚未出现 settled 的 assistant 行）
- **THEN** 不出现任何提示；随后 settled 的 assistant 行落定，依然不出现提示

#### Scenario: 本会话内工具栏 Stop 后提示一次

- **WHEN** 用户在本会话内用工具栏 Stop 停止一次（对应 `turn/end` 为 `aborted`/`user` 或 assistant 行带 `interrupted`）
- **THEN** 出现「再按 Esc 回退本轮」提示一次（每回合至多一次）；提示允许晚于停止动作一两帧出现（等该回合定型）

#### Scenario: 尚无内容即被停的回合同样提示

- **WHEN** 生成尚未产出任何内容时用户用工具栏 Stop 停止（对话里没有 assistant 行，但该回合 `turn/end` 为 `aborted`/`user`）
- **THEN** 出现「再按 Esc 回退本轮」提示一次

#### Scenario: 切进已失败的会话不提示

- **WHEN** 用户切换进入一个尾部非正常结束（如上一轮 429 失败、或历史上被中断）的会话，且本会话内没有发生过 `running` 下降沿
- **THEN** 不出现「再按 Esc 回退本轮」提示；仅当用户随后亲手按 `Esc` 或点工具栏 Stop 触发停止后，才显示该提示

#### Scenario: 草稿非空时不提示

- **WHEN** 用户停止了一个回合，随后在该回合定型前于输入框写入了草稿
- **THEN** 不出现「再按 Esc 回退本轮」提示，正在编辑的草稿不被干扰

#### Scenario: 删除模式下提示保留警示措辞

- **WHEN** 删除模式（`deleteOldOnRewind`）开启时上述任一停止路径成立
- **THEN** 提示使用删除态警示文案（「已停止 · 再按 Esc 将删除本轮并重来（不可恢复）」），与归档态普通文案可区分
