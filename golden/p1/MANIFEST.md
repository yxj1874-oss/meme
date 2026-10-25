# 黄金语料 p1：G21–G34

> 绑定 schema `v = 2`。每条展开为 `golden/p1/<gid>/{scene*.json, oracle.json, expected.json}`，全部由 [`tools/gen_golden_p1.ts`](../../tools/gen_golden_p1.ts) 生成（CI 检查生成结果与提交一致）；`expected.json` 由参考基底上的 `golden rebase` 写入；`g32_migration_v1_v2/p0_snapshot.json` 是 P0 结束时冻结的哈希，不由生成器产生。容忍度与 `bounds` 锁在 [`../thresholds.lock`](../thresholds.lock)。
> 设计见 [`docs/P1-01-design.md`](../../docs/P1-01-design.md) ②（与设计不一致处见该文 R1–R15）。"实测"一栏取自参考基底（substrate `sha256:9e7171cb…`）。

## 记号

与 [p0](../p0/MANIFEST.md) 相同：I(p,c) 线性图像，m2 为 Σx²/spp，N = spp，D = max_bounces，P = 掩码内像素数，u = 2⁻²³。另外：

- E(p)：f64 回放给出的像素期望（[`src/oracle/replay.ts`](../../src/oracle/replay.ts)）：重放 GPU 的 Philox 相机抖动（流 0，计数器 (px, py, s, 0)），逐样本求解析值再平均。离轮廓、地平线或两物体并列太近（f32 光线可能走另一条分支）的样本标记为 fragile，所在像素不参与比较。
- var_p：像素的光传输方差 = m2 给出的样本方差 − 回放算出的像素内抗锯齿方差（jitterVar）。
- E_ss(μ, α)：GGX 单次散射方向反照率，VNDF 定义域上的 f64 嵌套自适应 Simpson（[`src/oracle/ref_bsdf.ts`](../../src/oracle/ref_bsdf.ts)）。
- se_robust：采样器权重均值的标准误，其中无效样本（权重 0）的占比取 Wilson 95% 上界（R4）。
- 统计断言默认 5σ，同一 golden 内按 Bonferroni；seed 固定在场景里，通过与否是确定的。

## 覆盖矩阵

| 类别 | 场景 |
|---|---|
| 确定性：执行计划不变 | G34（另：`npm run determinism` 双进程检查 G34 的场景） |
| 能量：白炉（δ 与 GGX） | G21 G23 |
| 能量：BSDF ≤ 1、互易、采样器一致、χ² | G24 |
| 解析解：菲涅尔、点光源、球光源视因子、天空视因子 | G22 G25 G26 G28 G31 |
| 无偏性：bsdf / nee / mis / balance 互相一致 | G26 G27 |
| MIS 方差：Veach 定理 9.2 | G26 G27 |
| 收敛：1/√N | G29 |
| 极端输入：粗糙度 → 0、光源贴面 | G30 G31 |
| 契约：迁移、回滚、P0 字节不变 | G32 |
| 契约：schema v2 拒绝语料 | G33 |
| 回归：golden 图像 | 所有带 render 的场景（参考基底上逐字节） |

`kills` 字段列的是该 golden 设计要抓的错误类别；[`ci/mutants.json`](../../ci/mutants.json) 里的精选变异是其中可写成一行改动的子集，下表"变异"一栏列出预期由它变红的那些。

## 场景

| id | 场景 | 断言（数学形式） | 容忍度与来源 | 实测 | 变异 |
|---|---|---|---|---|---|
| G21 `mirror_sphere_constant_env` | δ 金属球（F0 = 1）、常量环境 1、D = 1、16 spp | 球内像素 I = 1；逃逸光线 I = 1 | (spp − 1 + 5D)·u = 2.4×10⁻⁶（Higham §4.2）；逃逸光线精确 | 误差 0 / 0 | — |
| G22 `dielectric_mirror_fresnel` | δ 介质球（ior 1.5、底色黑）、分区天空 | I(p) = (1/N) Σ_s F_diel(μ_s)·L(反射方向)（回放） | abs 2×10⁻⁵：μ 误差 ≤ 16 ulp(1)，\|dF/dμ\| ≤ 9.6；rel 10⁻⁵ | 最差 = 容忍度的 0.027 | fresnel-schlick-for-dielectric、fresnel-eta-inverted、delta-reflect-direction |
| G23 `ggx_conductor_furnace` | GGX 金属球（F0 = 1）、常量环境 1、D = 1、roughness 0.3 / 0.6 / 1 | 16 组像素（按 E 分组）：\|Σ(I − E)\| ≤ 5·√(Σ var_p / N)，E = E_ss(μ, α) | E_ss 在 129 点 μ 网格上线性插值，μ ≥ 0.15 时插值误差 ≤ 4×10⁻⁵（腐蚀后的掩码内 μ ≥ 0.18） | 最差 z = 1.89 / 1.76 / 2.13 | g2-as-g1、vndf-pdf-no-g1 |
| G24 `ggx_bsdf_probe` | 探针，9 种材质用默认采样器（球冠法）：金属 roughness 0.1 / 0.3 / 0.6 / 1，涂层（ior 1.5）0.1 / 0.3 / 0.6 / 1，混合（metallic 0.5、ior 1.8）；另有 2 个探针（金属 0.3、涂层 0.1）用候选 VNDF；每个探针 256 个分层随机方向 × 16 384 个样本 | A1 \|E[w] − E_ref\| ≤ max(5 se_robust, 2×10⁻⁴)；A2 E[w] ≤ 1 + 5 se_robust（A1、A2 超界时以 16 倍样本重测，以重测为准，R16）；A3 采样权重与重算一致；A4 互易；A5 支撑集、\|wi\| 长度；A6 χ²（32 × 64 格） | A3 512u；A4 10⁻⁴（相对）；A5 8u；A6 p ≥ 10⁻⁴；推导见 `bounds` | A1 最差 z 4.26（coat_r06 一个方向第一轮 5.55，重测后 3.06）；A3 最大 4.9×10⁻⁵；A4 最大 4.9×10⁻⁶；A5 6.6×10⁻⁷；A6 最小 p = 0.062 | g2-as-g1、vndf-pdf-no-g1、caps-full-sphere、ggx-d-cancelling、fresnel-*、coupling-naive、kelemen-ebar-dropped |
| G25 `point_light_lambert_plane` | 点光源 10 cd 在 Lambert 平面上方 2 m，nee，D = 1 | I(p) = (ρ/π)·I·cosθ / r²（回放，逐像素） | rel 2×10⁻⁵：r² 与 cosθ 各 ≤ 16 ulp，乘积与裕量 ×4；abs 10⁻⁷ | 最差 = 容忍度的 0.041 | point-inverse-square |
| G26 `sphere_light_lambert_plane` | 发光球（L = 8、R = 0.5、高 1.5 m）照灰平面，bsdf / nee / mis（默认 balance 权重）/ power（候选）各 256 spp | A1 每种估计器 8 组：\|Σ(I − E)\| ≤ 5σ，E = ρ·L·(R/d)²·cosθ（视因子）；A2 两两 z ≤ 5；A3 Σ var_mis ≤ Σ (min(var_bsdf, var_nee) + μ²/2)·(1 + 5√(2/((N−1)P))) | CLT + Bonferroni；Veach 1997 定理 9.2（每种技术一个样本） | A1 最差 z 2.51；A2 最大 1.80；A3 比值 0.118 | mis-weight-swap、nee-bsdf-double-count、cone-pdf-halved |
| G27 `mis_glossy_consistency` | GGX 金属平面（roughness 0.3）在一小一大两个球光下（200 / 4 cd/m²）；bsdf / nee / mis / power | A1 四种估计器两两 z ≤ 5；A2 同 G26 A3 | 同 G26 | A1 最大 0.62；A2 比值 0.744 | mis-weight-swap、nee-bsdf-double-count、cone-pdf-halved |
| G28 `env_nee_split_sky` | G10 的倾斜平面（θ = 60°），nee 与 mis | \|mean − ρ(1 + cosθ)/2\| ≤ 4·√(Σ var_p / N)/P；三通道相等 | 天空视因子（Duffie & Beckman）；CLT | nee 误差 −4.3×10⁻⁴（界 2.8×10⁻³）；mis −2.7×10⁻⁴（界 1.5×10⁻³） | env-pdf-hemisphere |
| G29 `mis_convergence_slope` | G26 的场景缩到 32 × 24，mis，N ∈ {1, 4, 16, 64, 256, 1024} | RMSE 对 N 的 OLS 斜率 ∈ [−0.55, −0.45]；RMSE·√N / σ̂ ∈ [0.85, 1.15] | 同 G11；σ̂ 取自 N = 1024 的 m2 | 斜率 −0.469（只看 N ≥ 4 时 −0.498，N = 1 受重尾影响偏低）；校准 0.865–0.963（N ≥ 4） | cone-pdf-halved |
| G30 `roughness_to_zero` | 介质球（ior 1.5、底色黑），α = 4, 2, 1.25 ×10⁻³ 与 δ | 与 δ 图像的平均绝对差随 α 单调下降，末项 / 首项 ≤ 0.5 | α 比 0.3125，连续的极限给出约 0.31 加噪声；δ 分支里的常数偏差不会随 α 缩小 | 3.30, 2.00, 1.39 ×10⁻⁴（比 0.42） | delta-reflect-direction |
| G31 `light_touching_surface` | 发光球贴在平面上（d = R）；点光源离平面 1 mm（0.001 cd） | A1、A3 有限、统计能量判据；A2 同 G26 A1（贴面时球恰在每个平面点的地平线上，解析式依然成立）；A4 点光源回放 | A4 rel 10⁻⁴：2 cm 内的 f32 相机相对坐标误差 ~3×10⁻⁸ m 对 r ≥ 10⁻³ m | A2 最差 z 1.59；A4 最差 = 容忍度的 0.030 | point-inverse-square |
| G32 `migration_v1_v2` | p0 的全部 37 个场景文件 | A1 migrate 后用 P1 内核渲染，图像、AOV、状态文件与冻结的 P0 哈希逐字节相同；A2 migrate → rollback → migrate 的 scene_hash 不变；A3 有损回滚报 `E_ROLLBACK_LOSSY` 并列出全部路径 | 精确 | 778 个文件 0 差异；37 个场景往返 0 失败 | migration-ior-default、lambert-path-through-general-bsdf |
| G33 `schema_v2_corpus` | 15 条 v2 拒绝语料 | 每条的错误码与路径精确相等 | 精确 | 15 / 15 | light-inside-check-off |
| G34 `det_plan_invariance_p1` | 走遍所有 P1 路径：δ 镜面、GGX 金属、介质涂层、Lambert 地面、点光源、球光源、分区天空；mis，D = 3，64 × 48，64 spp | 5 种执行计划（pass 切分、tile 大小、tile 顺序、提交批次）下所有输出文件逐字节相同；校验器通过 | 精确 | 4 组比较 0 差异；校验器通过 | pass-local-sum |
