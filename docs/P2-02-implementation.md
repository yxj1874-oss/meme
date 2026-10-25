# P2-02 实现交付：XPBD 刚体、接触、摩擦、关节

> 设计见 [`P2-01-design.md`](P2-01-design.md)（P2D1–P2D13 全部按默认，实现中的改动记在该文末「实现修订」R1–R20），黄金语料见 [`golden/p2/MANIFEST.md`](../golden/p2/MANIFEST.md)，候选赛报告见 `candidates/p2/<set>/REPORT.md`。
> 下文所有数字都来自参考基底（linux/arm64 容器，Mesa 25.0.7 lavapipe，LLVM 19.1.7，dawn.node 0.6.2，Node 24.22.0，substrate `sha256:9e7171cb…`）上的实际运行。

## ① 目标与本次新出现的决策点

**目标**：球刚体（带转动）的 XPBD：球与球、球与平面的接触，恢复系数，静/动摩擦，distance / ball / hinge / fixed 关节；每一项先有解析解、格式的闭式或守恒律作裁判；p0、p1 的全部输出字节不变。

实现中新出现的分歧点 H1–H4 已由你选定（"全部按默认"）；H1 换上后在关节场景里发散，你随后选择撤回 H1 并补全候选赛（R19）。

| # | 分歧点 | 你的选择与依据 |
|---|---|---|
| **H1** | 并行求解器（C-Solver，P2D2） | **保留质量拆分**（Tonge 2012）。最初的默认 A 是"换成直接相加的 Jacobi"：当时 C-Solver 的扰动集合只有接触堆与零重力碰撞簇，直接相加在 G41 重的在上的竖叠穿透 3.4×10⁻⁴·r（质量拆分 6.8×10⁻⁴·r），24 个扰动场景无一失败。换上后 G45 发散：最大速度 1534 m/s，`tunnel.physics` 与 `precision.physics` 判红。一个刚体挂两个关节时，同一自由度上叠加多达四个约束的完整修正，Jacobi 迭代的增益超过 2。候选赛补进 16 条随机关节链后（R19），直接相加在其中 15 条上发散，失败率 0.375，被淘汰；质量拆分与按约束数平均都没有失败。平均法仍在帕累托前沿上（穿透 3.46×10⁻⁴·r），但 G42 的动量误差 6.7×10⁻³，是舍入界的 7 倍，过不了 G42 的动量裁判。直接相加的 Jacobi 留作候选。 |
| **H2** | 姿态更新（C-Quat） | **换成指数映射**：自由旋转 \\|ω\\|h = 0.4（`E_SPIN` 的上限）时姿态相位误差 2.6×10⁻⁸，一阶更新是 2.7×10⁻³；多 2 行，ms 持平。一阶更新加归一化（Müller 2020）留作候选；转得慢时两者逐字节相同（G36 的复摆 \\|ω\\|h ≈ 10⁻⁴，465 个输出文件哈希全同）。 |
| **H3** | XPBD 的数值阻尼（R6） | **接受**：投影到约束最近点的格式有 O(h) 阻尼（单摆能量每周期约损失 h·ω₀²·T，h = 1 ms 时约 2%），已由修正方程精确预测并写进 G35；要减小就多给子步。沿旧梯度的投影（SHAKE/RATTLE 式）作为 P3/P4 的候选。 |
| **H4** | 摩擦、恢复系数阈值（C-Friction、C-Restitution） | **保持默认**：位置级静摩擦 + 速度级动摩擦的距离误差 3.2×10⁻³（速度级库仑 7.9×10⁻³）；阈值 2\\|g\\|h 的静止抖动为 0（无阈值 1.6×10⁻³ m/s）。 |

## ② 测试先行

- 13 个黄金场景（G35–G47）、107 条断言结果（p0 + p1 + p2 共 376 条），全部由 [`tools/gen_golden_p2.ts`](../tools/gen_golden_p2.ts) 生成；CI 检查生成结果与提交一致，并且现在会发现 golden 目录里生成器不认识的陈旧文件（R18）。
- 阈值锁共 180 条（含 p0、p1），0 条改动。
- 裁判：
  - **修正方程**（G35）：θ̈ = −(g/L)·sinθ − h·(θ̇³ + (g/L)·cosθ·θ̇)，RK4 在 h/16 上积分，按记录时刻采样，用同一套过零点测量。f64 分析：它对格式周期的二阶余项是 5/24·(ω₀h)²。
  - **格式的闭式**：柔性约束 x' = (x + h·v)/(1 + ω²h²)（G37）；离散顶点 (e·v)²/2g − e·v·h/2（G38）；常加速度下 s = a·t·(t + h)/2（G40）。
  - **解析解**：椭圆积分周期 4·√(L/g)·K(sin(θ₀/2)) 与平行轴定理（G35、G36）；牛顿碰撞定律（G39）；纯滚动 a = 5/7·g·sinθ、打滑 a = g(sinθ − μ_d·cosθ)、临界角 tanθ_c = 3.5·μ_s（G40）。
  - **守恒律与需求**：线动量到舍入（G39、G42、G43）；穿透 ≤ 10⁻³·r（G41、G44，需求）；平移 4096 m 逐位不变（G44）；执行计划与物理局部性逐字节（G45）。
- 元测试：MT2 精选变异 63 条（P2 新增 19 条，另改写 2 条原有的物理变异），MT3 性能门加入 G45 的场景与 3 个新计数器，MT5 阈值锁，MT6 迁移往返（G46：p0 + p1 共 97 个场景）。

## ③ 实现

| 模块 | 内容 |
|---|---|
| `schema/` | `scene.schema.json` 升到 v3（`physics_materials`、`joints`、`physics.substeps` / `contacts`、刚体的角速度与姿态、单位 `rad/s` 与 `m/N`）；`scene.schema.v2.json` 冻结；`schema.ts` 自动载入所有冻结版本 |
| `src/core/` | v2 → v3 迁移与有损检查的回滚；语义检查新增 `E_INITIAL_OVERLAP`、`E_MASS_RATIO`、`E_SPIN`、`E_NORM`、`E_FRICTION_ORDER`、`E_JOINT_REF`、`E_JOINT_SELF`，`E_BUDGET` 与 `E_PRECISION_DT` 按 R5 调整 |
| `src/kernels/physics_p2.wgsl` | 取代 `physics_p0.wgsl`。`translate_main` 就是 P0 的循环；`free_main` 加姿态；有相互作用时每子步 predict / count / solve / velocity / commit 五个 pass，gather 加双缓冲，没有原子操作；接触对一律以较低下标为 a 求值，两边的乘子逐位相同；定点位置差精确相减后只舍入一次；速度与角速度都用 delta 形式（R2、R3） |
| `src/runtime/physics.ts` | 刚体、静态碰撞体、关节与每体关节表的打包，按场景选择内核路径，状态与诊断的记录；`physics_metrics.ts` 在 CPU 上用 f64 求能量、动量、角动量、穿透、关节残差 |
| `src/runtime/run.ts` | `state/step_k.rot.bin` 与 JSON 里的 `q`、`omega_rad_s`（只在有转动时写出）；新校验器 `energy.physics`、`tunnel.physics`、`precision.physics`；退出码 7 |
| `src/oracle/` | `physics_assertions.ts`（P2 断言）、`assert_util.ts`（断言共用的上下文与工具） |
| `tools/` | `gen_golden_p2.ts`、`contest_p2.ts` 与共用的 `contest_lib.ts`、性能门对新 schema 场景跳过 A/B |

## ④ 会让本实现失败的极端输入

| 输入 | 状态 |
|---|---|
| 质量比悬殊（P0 登记） | 已兜住：`E_MASS_RATIO` 收紧到 100（R4）；G41 在边界上穿透 6.8×10⁻⁴·r |
| 高速隧穿 | 不做 CCD：`tunnel.physics` 判红并以退出码 7 结束（G44 负对照：50 m/s 的 1 cm 小球） |
| 球心重合 | 已兜住：确定的回退法线 +z；G44 的探针里两球对称分开，结果有限、可重现 |
| 贴面静止 | 已兜住：恢复系数阈值；G44 中 4 s 内最大穿透 1.8×10⁻⁹ m，速度恒为 0，能量不增 |
| 大坐标上的接触 | 已兜住：G44 把一堆碰撞、摩擦、反弹的球整体平移 4096 m，每个记录步的状态字节（除整数米的高位外）完全相同 |
| 长时间堆叠的能量蠕变 | 已兜住：G41 中 4 s 内能量最大值等于初值 |
| 实现中新发现：动摩擦按原文写法弱 3.5 倍 | 已修（R1） |
| 实现中新发现：由四元数差求 ω 的 f32 相消 | 已修（R2） |
| 实现中新发现：f32(h)·f32(1/h) ≠ 1 每子步复利 | 已修（R3） |
| 实现中新发现：XPBD 的 O(h) 阻尼 | 已量化并写进裁判（R6，选择题 H3） |
| 实现中新发现：一个刚体挂多个关节时直接相加的 Jacobi 发散 | 已兜住：求解器保留质量拆分（H1）；C-Solver 的扰动集合加入 16 条随机关节链（R19）；变异 `mass-splitting-off` 由 G45 的校验器抓到 |

## ⑤ 验收布尔清单（参考基底实测）

| 判据 | 结果 |
|---|---|
| p2 的 13 个 golden 的 oracle 全过，哈希一致（`--require-hashes`） | ✅ 13/13（107 条断言）；全部 47 个 golden 通过 |
| G46：p0、p1 的全部运行迁移到 v3、经 P2 内核运行后逐字节相同；p0、p1 的 golden 不变 | ✅ 910 个文件 0 差异；97 个场景迁移往返 0 失败；p0、p1 的 golden 哈希全部不变（只有 G20 的拒绝用例改名，R17） |
| 单摆、复摆、弹簧（G35–G37） | ✅ 单摆周期与修正方程差 ≤ 2.4×10⁻⁶（界 3.8×10⁻⁶–1.5×10⁻⁵），收敛阶比值 1.96 / 1.98；复摆周期误差 7.4×10⁻⁶（需求 10⁻⁴）；弹簧轨迹与格式闭式差 2.1×10⁻⁷ m（界 5.1×10⁻⁶ m） |
| 恢复系数、碰撞、斜面、临界角（G38–G40） | ✅ 11 个顶点全部在界内；碰后速度误差 ≤ 7×10⁻⁸（正碰），斜碰 1.0×10⁻³（界 2×10⁻²）；滚动距离误差 7×10⁻⁷ m，打滑 1.7×10⁻⁴ m，自转 8.496 rad/s（理论 8.496）；临界角两侧判类正确 |
| 动量与堆叠（G41、G42） | ✅ 64 球动量误差为舍入界的 8.5×10⁻⁵；三种竖叠穿透 0 / 2×10⁻⁵·r / 6.8×10⁻⁴·r |
| 计划不变性、物理局部性、平移不变性、`--determinism-check` | ✅ G45 5 种计划 0 差异，加远处刚体后 0 字节差异；G44 平移 0 差异；`npm run determinism` 新增 G45 场景 |
| MT2：新增物理变异全部被 oracle 抓到 | ✅ 63/63；只靠哈希的仍是 P0 已接受的 2 条（`dim-block-reuse`、`jcs-number-format`）。`mass-splitting-off`（求解器退化成直接相加的 Jacobi）由 G45 的 `tunnel.physics` / `precision.physics` 抓到；`exp-map-half-angle`（指数映射用整角）由 G40 打滑球的自转抓到；`omega-from-quaternion` 由 G43 铰链的绕轴角速度抓到 |
| MT5：阈值锁 180 条，0 条改动 | ✅ |
| 性能门 | ✅ 工作量：G01、G16 原有计数器不变，`gpu_bytes_peak` 只有 G16 +32 B（步参数从 48 B 增到 80 B）；新计数器 `physics_substeps`、`pair_tests`、`constraint_solves` 与 G45 的场景记入基线。墙钟与父提交（P1）同机 A/B：G01 ×1.03，G16 ×1.05。G16 起初是 ×1.08：自由飞行的场景也在打包求解器数据、逐记录计算动量与角动量；改为只在有相互作用时打包、只在需要报告时计算（R16）。G45 的场景父提交读不了，只门控工作量 |
| 4 个候选集的 REPORT.md 与选择题 | ✅ 见 ① H1–H4；C-Solver、C-Quat 已按最终默认值重跑（C-Solver 的扰动集合扩到 40 个场景，R19） |
| lint、typecheck、单元测试 | ✅ lint 0 违规；typecheck 通过；单元测试 41/41（新增：v2 ↔ v3 迁移、物理候选默认值与内核一致） |

## ⑥ 黄金场景与指标

- 13 个场景（G35–G47），逐条的场景、断言、容忍度、实测见 [MANIFEST](../golden/p2/MANIFEST.md)。
- 新指标（`manifest.deterministic.metrics.physics.records[]`，有转动时）：`ke_rot_j`、`pe_spring_j`、`momentum_kg_m_s`、`angular_momentum_kg_m2_s`、`max_penetration_m`、`joint_residual_m`、`joint_residual_rad`、`contacts`、`e_projection_j`、`e_bounce_j`、`disp_ratio_max`；工作量计数器新增 `physics_substeps`、`pair_tests`、`constraint_solves`。
- 新校验器：`energy.physics`（R15 的预算）、`tunnel.physics`（子步位移 > 0.5·r）、`precision.physics`（R5）。
- 候选赛：`candidates/p2/{c_solver, c_friction, c_restitution, c_quat}/`，由 `ci/run-in-ref.sh node tools/contest_p2.ts` 重新生成。

## 未做与限制

- 只有球刚体（P2D1）：方块与 SDF 刚体在 P4。
- 不做 CCD（P2D7），靠 `tunnel.physics` 大声失败。
- XPBD 的 O(h) 数值阻尼（H3）：h = 1 ms 时单摆每周期约损失 2% 能量；柔性约束同样有隐式欧拉式的阻尼（G37：每秒振幅乘 0.939）。
- 角动量只守恒到 O(h)（R11）。
- 焊接残差的界是需求而不是推导值（R12）。
- G36 只测小振幅：刚体复摆的修正方程没有推导。
- 性能：墙钟 A/B 对新 schema 的场景没有基线（父提交读不了 v3），只门控工作量计数器；下一次提交起两边都能运行。
