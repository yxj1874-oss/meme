# P1-02 实现交付：光先对（δ 镜面、GGX + 菲涅尔、NEE + MIS，仅球与平面）

> 设计见 [`P1-01-design.md`](P1-01-design.md)（P1D1–P1D13 全部按默认，实现中的改动记在该文末「实现修订」R1–R16），黄金语料见 [`golden/p1/MANIFEST.md`](../golden/p1/MANIFEST.md)，候选赛报告见 `candidates/p1/<set>/REPORT.md`。
> 下文所有数字都来自参考基底（linux/arm64 容器，Mesa 25.0.7 lavapipe，LLVM 19.1.7，dawn.node 0.6.2，Node 24.22.0，substrate `sha256:9e7171cb…`）上的实际运行。

## ① 目标与本次新出现的决策点

**目标**：材质扩展到 metallic / roughness / ior 三参数的微表面模型，加入点光源、球光源、环境光的直接光采样与 MIS；每一项都先有解析解、f64 数值积分或 f64 回放作裁判；p0 的全部场景经新内核渲染后逐字节不变。

新的分歧点（选择题，★ 为我的默认）。F1–F4 是机制 ① 候选赛的结果。

**你的选择（2026-10-25）：F1–F6 全部按默认。** 已执行：运行时的 GGX 采样改为球冠法、MIS 权重改为 balance（两者都是 override 的默认值，TypeScript 侧的镜像是 `DEFAULT_CANDIDATES`，单元测试保证两边一致）；受影响的 golden 已重录哈希（见 ⑤）。被换下来的 VNDF 与 power 仍编译在内核里，并继续受 golden 检验：G24 用 VNDF 跑两种材质（`*_vndf`），G26、G27 用 power 跑一组（`power`）。

| # | 分歧点 | 选项与数据 |
|---|---|---|
| **F1** | 介质的漫反射/镜面耦合（C-Coupling，P1D2） | **A★ Kelemen**：ior → 1 处的连续性误差 1.5×10⁻⁴，低于它的 5σ 分辨率 6.3×10⁻⁴；方差 0.0213；16 行。<br>**B Ashikhmin-Shirley**：方差低 23%（0.0163），4 行，但 ior = 1.0001 时反照率比 Lambert 低 0.263：ior = 1 时材质必须正好是 Lambert（P1D1），它在这里不连续。<br>朴素 F 加权（负对照）被淘汰：互易误差 0.99，12 个随机材质全部失败。 |
| **F2** | GGX 采样（C-GGXSample，P1D8） | **A★ 换成球冠法**（Dupuy & Benyoub 2023）：与 VNDF 是同一个分布，误差、方差、ms 都在噪声内持平，少 3 行（16 对 19），所以 VNDF 按规则被它支配。换的代价：含微表面材质的 golden 重录哈希，oracle 不变。<br>**B 保留 VNDF**（Heitz 2018）：3 行之差可以忽略，引用更广。<br>D(m)cos 也在前沿上，但方差是前两者的 10 倍，不建议。 |
| **F3** | MIS 权重（C-MIS，P1D7） | **A★ 换成 balance**：G26 + G27 的方差比 power 低 1.9%（两者用同一组随机数，差值超过噪声），少 1 行；误差、ms 持平。另一个好处是 Veach 定理 9.2 的方差上界（G26 A3、G27 A2）会直接作用在默认配置上。<br>**B 保留 power**（β = 2）：通常的经验是 power 更好；本次只有两个基准场景。 |
| **F4** | 球光源采样（C-SphereLight，P1D9） | **A★ 锥采样**：唯一合格的候选。<br>面积采样被淘汰：12 个随机场景中 1 个失败，G27 上方差为 NaN（背面拒绝后 pdf 换算在掠射处退化）。 |
| **F5** | P1-01 ⑥ 承诺的指标里，"每个光源的 NEE 占比"和"MIS 权重直方图"没有做（已做：总 NEE 占比、波瓣选择计数、阴影光线数） | **A★ 放到 P3**：两者都要按光源做确定性归约（不能用无序原子操作），P3 的指标与 patch 协议一起设计。<br>**B 在 P1 补上**。 |
| **F6** | G12、G24 的 \|wi\| 长度界（4u、8u）依赖参考基底上 sin/cos 约 1 ulp 的精度；WGSL 只保证 2⁻¹¹（§15.7.4.1） | **A★ 保持**：界的推导里已写明这一前提；精度更差的基底会明确报红，不会悄悄出错。<br>**B 对余弦采样方向归一化**：界变成与基底无关，但会改变 P0 的每个字节，p0 golden 要按 ADR 全部重录。 |

## ② 测试先行

- 14 个黄金场景（G21–G34）、132 条断言结果（p0 + p1 共 269 条），全部由 [`tools/gen_golden_p1.ts`](../tools/gen_golden_p1.ts) 生成；CI 检查生成结果与提交一致。
- 容忍度：全部带推导与出处。阈值锁共 147 条（含 p0）；除 `tol` 外，G12、G24 的 74 条界也在 oracle 的 `bounds` 里锁定：原来写在断言代码里的权重一致、互易、长度、χ²、反照率下限（R12），以及重测倍数（R16）；负对照：把 G24 的权重界放宽一倍，`thresholds --check` 判红。
- 裁判：
  - **f64 回放**（[`src/oracle/replay.ts`](../src/oracle/replay.ts)）：在 CPU 上重放 GPU 的 Philox 相机抖动，逐样本求解析值。确定性路径（δ 波瓣、单点光、D = 1）逐像素比较；随机路径比较期望，并减去回放算出的像素内抗锯齿方差。
  - **f64 求积**（[`src/oracle/ref_bsdf.ts`](../src/oracle/ref_bsdf.ts)）：VNDF 定义域上的嵌套自适应 Simpson；另用一个独立的斜率空间积分交叉核对，5 个检查点一致到 10⁻⁷。
  - **解析解**：球光源视因子 E = πL(R/d)²cosθ、点光源平方反比、倾斜平面的天空视因子、精确介质菲涅尔（PBRT-v4 第 9 章）。
  - **统计**：分组 z 检验（Bonferroni）、χ²、Veach 定理 9.2 的方差上界、OLS 收敛斜率、Wilson 区间（se_robust，R4）。
- 元测试：MT2 精选变异 44 条（P1 新增 17 条，全部要求被 oracle 抓到；`caps-full-sphere` 针对新的默认采样器），MT5 阈值锁（现覆盖 `bounds`），MT6 迁移往返（G32）。

## ③ 实现

| 模块 | 内容 |
|---|---|
| `schema/` | `scene.schema.json` 升到 v2（材质三参数、`lights`、`render.strategy`、`x-migrations`）；`scene.schema.v1.json` 冻结 |
| `src/core/` | 多版本 schema 校验（`validateSceneSchema(instance, version)`）；`migrate.ts`：v1 → v2 迁移、v2 → v1 回滚（有损时 `E_ROLLBACK_LOSSY` 并列出路径）；语义检查新增 `E_LIGHT_INSIDE` 与光源 id 检查 |
| `src/kernels/bsdf_p1.wgsl` | 金属 / 介质 / δ 三类材质；GGX D（Walter 2007，无相消的 t，R3）、高度相关 Smith G2（Heitz 2014）、球冠（默认）/ VNDF / D(m)cos 三个采样器（override `GGX_SAMPLER`）、精确介质菲涅尔与金属 Schlick、Kelemen / Ashikhmin-Shirley / 朴素耦合（override `COUPLING`），波瓣选择概率夹在 [0.05, 0.95] |
| `src/kernels/render_p1.wgsl` | 取代 `render_p0.wgsl`：bsdf / nee / mis 三种策略，点光源、球光源（锥采样或面积采样，override `SPHERE_SAMPLER`）、环境光（常量或上半球）的 NEE，balance（默认）/ power 权重（override `MIS_HEURISTIC`）；NEE 维度块 `0x80000000 + b`；Lambert 快路径与 P0 的指令序列相同 |
| `src/runtime/render.ts` | 材质分类与打包、光源表与选择概率（R6）、管线特化（R11）、Kelemen 表（[`kelemen_es.f32`](../src/runtime/kelemen_es.f32)，由 [`tools/gen_tables.ts`](../tools/gen_tables.ts) 用 f64 求积生成，CI 检查一致） |
| `src/gpu/device.ts` | 进程内管线缓存（键 = 入口 + 排序后的 override 常量 + 源码） |
| `src/oracle/` | f64 回放、f64 BSDF 参考、材质探针（`probeMaterial`，含 se_robust）、P1 断言、NEE / MIS 下的统计能量校验（P1D13） |
| `tools/` | `gen_golden_p1.ts`、`gen_tables.ts`、`contest.ts`（候选赛）、阈值锁扩展、变异测试按 `expected_red` 先跑子集 |

## ④ 会让本实现失败的极端输入

| 输入 | 状态 |
|---|---|
| 粗糙度 = 0 | 已兜住：α < 10⁻³ 走 δ 分支；G30 的图像差随 α 单调收敛到 δ 结果（3.30 → 2.00 → 1.39 ×10⁻⁴） |
| 光源贴面（球光源与平面相切）、点光源离平面 1 mm | 已兜住：G31 有限、统计能量判据通过，并且整幅图与解析式一致（R9） |
| 掠射角 μ → 0 | 已兜住：μ ≤ 2⁻²⁰ 时 f 与 pdf 定义为 0；G24 的方向在 μ 上分层随机，覆盖到 μ ≈ 0 |
| ior 恰好为 1 | 已兜住：材质归为 Lambert，走与 P0 相同的指令；G32 逐字节相同；ior = 1.0001 处的连续性见 F1 |
| 实现中新发现：粗糙度 0.1 附近，GGX D 的教科书公式 t = cos²(α²−1)+1 相消 | 已修（R3）：权重一致性 7.1×10⁻⁵ → 3.9×10⁻⁵（界 512u = 6.1×10⁻⁵），变异 `ggx-d-cancelling` 守住 |
| 实现中新发现：光滑波瓣的无效样本占比约 10⁻⁴，一个方向里可能一个也抽不到，样本方差塌缩到真值的约 1/10 | 已修（R4）：se_robust；这正是候选赛里 VNDF 曾被误判"有偏"（z = 7.2）的原因，f32 仿真与 f64 积分都证明采样器无偏 |
| 实现中新发现：光泽涂层的采样权重是重尾的，某个方向偶尔抽不到稀有的大权重，读数偏低且样本标准误偏小（换成球冠法后 G24 coat_r06 一个方向 z = −5.55，16 倍样本时 −0.52） | 已修（R16）：超过 5σ 的方向用 16 倍样本重测，以重测为准；没有换 seed，也没有放宽 5σ |
| 实现中新发现：9 个 storage buffer 超过 WebGPU 默认上限 8 | 已修（R5） |
| 实现中新发现：P1 内核让 p0 场景慢 1.70 倍、多用 31% 显存 | 已修（R11），见 ⑤ 性能一行 |

## ⑤ 验收布尔清单（参考基底实测）

| 判据 | 结果 |
|---|---|
| p1 的 golden 的 oracle 全过，哈希一致（`--require-hashes`） | ✅ 14/14（132 条断言）。R3（D 的写法）和 F2、F3（默认换成球冠法与 balance）之后，含微表面材质或 mis 策略的 G23、G26–G31、G34 按 `golden rebase` 重录了哈希，断言的界未改；G21、G22、G25 哈希不变。G24 加了两个 VNDF 探针和重测规则（R16），G26、G27 的第四组改为 power |
| p0 的 golden 不变 | ✅ 20/20，哈希与 P0 录制值相同；只有 G12、G20 的 oracle.json 有改动（G12 的界移进 `bounds`，值不变；G20 多一条 `version_3` 拒绝用例） |
| G32：p0 的全部运行迁移到 v2、经 P1 内核渲染后与 P0 冻结哈希逐字节相同 | ✅ 778 个文件 0 差异；37 个场景迁移往返 0 失败 |
| G26、G27、G29：三种 strategy 无偏，balance 满足定理 9.2 上界，收敛斜率 ∈ [−0.55, −0.45] | ✅ 四种估计器最差 z 2.51；balance（默认）的方差为定理 9.2 上界的 11.8% / 74.4%；G29 斜率 −0.469（只看 N ≥ 4 时 −0.498），见 ⑥ |
| G34 与 `--determinism-check`：5 种执行计划逐字节相同，双进程逐字节相同 | ✅ G34 4 组比较 0 差异；`npm run determinism` 的 4 个场景（新增 G34）0 差异 |
| MT2：精选变异全部被抓到；P1 新增的 17 条都被 oracle 抓到（不只靠哈希） | ✅ 44/44；只靠哈希的仍是 P0 已接受的 2 条（`dim-block-reuse`、`jcs-number-format`，P0-02 E1）；`pass-local-sum` 同时被 G03 与 G34 的 oracle 抓到 |
| MT5：阈值锁 147 条，0 条改动 | ✅；负对照（G24 权重界放宽一倍）判红 |
| 性能门 | ✅ 工作量：G01 的光线段与求交次数与 P0 基线完全相同，`gpu_bytes_peak` 690 400 B（+288 B，+0.04%）。墙钟同机 A/B：G01 head 37.91 ms 对 base 45.52 ms（×0.83），G16 ×0.45。这次 A/B 偏向 head：base（P0）每次运行都重新编译管线（约 6 ms），head 有管线缓存；扣掉编译后 G01 约为 ×0.96。下一次提交起两边都有缓存，比较重新对称 |
| 4 个候选集的 REPORT.md 与选择题 | ✅ 见 ① F1–F4，已按你的选择采用，报告按新默认重新生成 |
| `src/` 中 TODO/FIXME = 0、lint、typecheck、单元测试 | ✅ lint 0 违规；typecheck 通过；单元测试 38/38（新增：`DEFAULT_CANDIDATES` 与内核 override 默认值一致） |

## ⑥ 黄金场景与指标

- 14 个场景（G21–G34），逐条的场景、断言、容忍度、实测与对应变异见 [MANIFEST](../golden/p1/MANIFEST.md)。
- 代表性实测：
  - 回放（逐像素）：G21 δ 白炉误差 0；G22 菲涅尔最差为容忍度的 2.7%；G25 点光源 4.1%；G31 离平面 1 mm 的点光源 3.0%。
  - G23 GGX 金属白炉：3 种粗糙度 × 16 组，最差 z = 2.13（界 5）。
  - G24：11 个探针 × 768 个反照率检验，最差 z = 4.26（coat_r06 的一个方向第一轮 5.55，按 R16 用 16 倍样本重测后 3.06）；权重一致 4.9×10⁻⁵（界 6.1×10⁻⁵）；互易 4.9×10⁻⁶（界 10⁻⁴）；χ² 最小 p = 0.062。
  - G26：四种估计器（bsdf、nee、mis = balance、power）对视因子解析式的最差 z = 2.51，两两之间最大 1.80；balance 的方差和是 Veach 上界的 11.8%（G27 为 74.4%）。
  - G28 天空视因子：nee 误差 −4.3×10⁻⁴（界 2.8×10⁻³），mis −2.7×10⁻⁴（界 1.5×10⁻³）。
  - G29 MIS 收敛斜率 −0.469（界 [−0.55, −0.45]），校准 0.865–0.963（N ≥ 4）。换成 balance 之前是 −0.507 与 0.93–1.05。只看 N ≥ 4 时斜率是 −0.498；偏离来自 N = 1 一点：它的 RMSE 0.0200 低于按 1/√N 外推的 0.027。单样本的 RMSE 在重尾时会偏低，而 balance 下单个样本贡献的上界（f·L·cosθ / p_light）是 power（f·L·cosθ / (2 p_light)）的两倍，尾巴更重。检验仍通过，界没有动。
  - G30 与 δ 图像的平均差：3.30 → 2.00 → 1.39 ×10⁻⁴（α = 4 → 2 → 1.25 ×10⁻³）。
  - G32：p0 的 778 个输出文件经迁移和 P1 内核后 0 差异。
- 新指标（`manifest.deterministic.metrics.lighting`）：`strategy`、`lights`（参与 NEE 的光源数）、`specular_lobe_choices`、`nee_share`（NEE 贡献占总亮度的比例）；工作量计数器新增 `work.shadow_rays`。
- 候选赛：`candidates/p1/{c_coupling, c_ggx_sampler, c_mis, c_sphere_light}/`，每个目录一份 REPORT.md（表格、度量定义、备注、淘汰原因）和 results.json，由 `ci/run-in-ref.sh node tools/contest.ts` 重新生成。

## 未做与限制

- F5：每光源 NEE 占比与 MIS 权重直方图未做，按你的选择放到 P3。
- G29 的斜率拟合包含 N = 1，而校准从 N ≥ 4 起算（同 G11）；balance 下 N = 1 受重尾影响，斜率 −0.469 离下界只有 0.019。若要让两者一致，可以把斜率拟合也限定在 N ≥ 4，这需要改 oracle，没有自行做。
- F6：|wi| 长度界依赖参考基底的 sin/cos 精度。
- 候选赛的 ms 噪声很大（5 次重复的极差达到中位数的 30–50%），ms 在四个候选集里都没有分出胜负；方差噪声用的是高斯近似 5·√(2/(n−1))，对重尾的估计器偏乐观。
- G24 的方向用 HarnessRng 分层随机，不是固定网格；粗糙度覆盖 0.1、0.3、0.45、0.6、1.0，α 在 10⁻³ 与 10⁻² 之间（roughness 0.032–0.1）只由 G30 的图像连续性间接覆盖。
- 跨基底（非 lavapipe）只能做容忍度比较，ꟻLIP + 掩码仍未实现（同 P0）。
