# 黄金语料 p0：首批 20 个场景（草案）

> 绑定 schema `v = 1`。每条已展开为 `golden/p0/<gid>/{scene*.json, oracle.json, expected.json}`，全部由 [`tools/gen_golden.ts`](../../tools/gen_golden.ts) 生成（CI 检查生成结果与提交一致）；`expected.json` 由参考基底上的 `golden rebase` 写入。容忍度锁在 `thresholds.lock`。
> 下文与实现不一致之处已按实现修订，并标注「实现修订」。
> 场景字段名与 [`schema/scene.schema.json`](../../schema/scene.schema.json) 一致。

## 记号

- I(p,c)：线性图像（PFM），像素 p、通道 c，单位 cd/m²-RGB；ID(p)：像素中心光线的首次命中；m2(p,c)：Σx²/spp。
- N = spp，D = max_bounces，P = 掩码内像素数。
- u = 2⁻²³：WGSL 不规定舍入方向，因此按 faithful rounding 取单位舍入误差（§15.7.4）。
- ulp(V)：f32 在 V 处的 ulp。
- q = 2⁻³² m：定点位置量子（D15-A）。
- 统计断言默认 4σ；同一场景内有多重检验时按 Bonferroni 取 5σ。seed 固定在场景里，所以通过与否是确定的，不会 flaky。

## 覆盖矩阵

| 类别（裁判契约） | 场景 |
|---|---|
| 确定性 | G01 G02 G03 |
| RNG | G04 G05 |
| 能量：白炉 | G08 G09 G14 |
| 能量：BSDF ≤ 1、Helmholtz 互易 | G12 |
| 解析解（渲染） | G07 G09 G10 |
| 收敛：1/√N | G11 |
| 数值：NaN/Inf 扫描 | G13 G15 G16（所有场景都会跑 V-NaN） |
| 数值：动能有界 | G16 G18 |
| 解析解（物理）：自由落体、Δt 减半收敛 | G17 |
| 契约：patch / schema | G19 G20 |
| 回归：golden 图像 | 所有带 render 的场景（参考基底上逐字节；跨基底用 ꟻLIP + 掩码） |
| 性能 | 元测试 MT3，跑在 G01、G03、G16 上 |

**P0 无法覆盖、已登记到 P2**：穿透深度上限、恢复系数、球球冲量、单摆周期、静摩擦临界角（都需要约束与接触）。
**登记到 P1**：GGX 的互易与能量、MIS、粗糙度 = 0、光源贴面。

---

## A. 确定性

### G01 `det_double_run`
- **场景**：128×96，N = 64，D = 4；环境 constant 0.5 cd/m²（白）；地面平面 ρ = 0.6；5 个球（ρ 在 0.2–0.9，颜色各不相同），另有 1 个自发光球（20 cd/m²）；其中 3 个球带 body；physics dt = 2⁻⁸，256 步，每 32 步记录一次。
- **断言**
  - A1：∀ 输出文件 f：sha256(f | 进程 1) = sha256(f | 进程 2)，两个都是新进程，都带 `--no-cache`。
  - A2：JCS(manifest.deterministic | 1) = JCS(manifest.deterministic | 2)。
  - A3：进程 1 内第二次运行的结果与第一次一致（抓缓存或全局状态）。
- **容忍度**：0。来源：确定性契约。
- **能杀死**：N1 隐式随机、N3 池化分配器不清零、N13 按完成顺序写结果、N17 计时混入确定性段。

### G02 `det_canonical_order`
- **场景**：两个子场景。G02a = G01 的渲染部分；G02b = 只有物理，1024 个带 body 的球，初始状态由 harness 流 4 生成后写死在 JSON 里。每个子场景 S 都有一个变体 S′：materials 和 objects 的 key 插入顺序被打乱（流 4），数字改写（`1` → `1.0` → `1e0`，`0.5` → `5e-1`），空白也改掉。
- **断言**：scene_hash(S) = scene_hash(S′)；所有输出逐字节相等。
- **容忍度**：0。
- **能杀死**：按插入序遍历（`Object.keys`）、图元或物体顺序依赖、哈希依赖数字的字面写法。

### G03 `det_plan_invariance`
- **场景**：G01，按以下执行计划各跑一次。
  - P1：单 pass，全帧，64 spp
  - P2：4 × 16 spp，tile 16²
  - P3：64 × 1 spp，tile 8²
  - P4：P2 + 用 harness 流 5 置换 tile 顺序
  - P5：每个 tile 单独 submit，分 7 批
  - 物理：1 次 dispatch 跑 256 步 / 256 次 dispatch 各 1 步 / 每步一次 submit
- **断言**：所有计划的 `deterministic.outputs` 逐字节相等（plan_hash 可以不同）。
- **容忍度**：0。
- **能杀死**：N4、N5、N6；变异"先按 pass 求和再相加"；跨 tile 的数据竞争。

## B. RNG

### G04 `rng_kat_crosscheck`
- **断言**
  - A1：TS 实现的 Philox4x32-10 与 Random123 `kat_vectors` 中所有 philox4x32_10 行逐位相等。
  - A2：WGSL 与 TS 逐位相等。覆盖 seed ∈ {0, 1, 0x9E3779B9, 0xFFFFFFFF}，stream ∈ {0, 3, 4, 5}，共 2²⁰ 组输入（2¹⁹ 组顺序计数器 + 2¹⁹ 组由流 4 生成的随机 seed/stream/计数器）。
  - A3：`to_unit_float`（f32(u ≫ 8)·2⁻²⁴）的 WGSL 与 TS 结果逐位相等；值域 ⊂ [0, 1)。最大值 = 1 − 2⁻²⁴ 需要输入字 ≥ 0xFFFFFF00，随机输入不保证覆盖，改由 CPU 单测用固定输入检查（实现修订）。
  - A4：A2、A3 在 M6 Metal 上同样成立（这是跨基底的，属于 L3 级逐位一致）。
- **容忍度**：0。来源：WGSL 整数运算模 2^bitwidth 精确（§6.2.3）；u ≫ 8 < 2²⁴，所以 f32 转换精确；乘 2⁻²⁴ 是乘以 2 的幂，精确。
- **能杀死**：轮数 10 → 9、常数改动、`≫ 8` → `≫ 9`、16 位分段的 mulhi 写错。

### G05 `rng_stream_quality`
- **断言**（每项 n = 2²⁰）
  - A1：一维均匀性，1024 个箱，χ²（自由度 1023）的 p ∈ [1e-4, 1 − 1e-4]。
  - A2：二维 (u0, u1)，64×64 个箱（自由度 4095），p 的范围同上。
  - A3：跨流相关：同一计数器下 |pearson(流 0, 流 3)| ≤ 4/√n = 3.91e-3。
  - A4：seed 雪崩：逐位翻转 32 个 seed 位，每次在 2¹⁶ 个计数器 × 128 个输出位上统计被翻转的比例，要求 ∈ 0.5 ± 8.63e-4（5σ，Binomial(2²³, ½)，对 32 次检验做 Bonferroni）。
  - A5：counter 雪崩：对 128 个计数器位做同样的检验，判据同 A4。
- **容忍度来源**：零假设分布（χ² 分布；独立时 r ≈ N(0, 1/n)；二项分布）。
- **能杀死**：seed 不进 key（A4）、dim_block 复用（A3 / A2）。同一套检验也是候选赛 C-RNG 的质量分。

## C. 能量 / 渲染解析解

### G06 `empty_black`
- **场景**：64×64，N = 4，环境 constant 0 cd/m²，objects 与 materials 均为空。
- **断言**：∀p,c：I(p,c) == 0（±0 都接受，因为 §15.7.2 允许忽略零的符号）；m2 == 0；PNG（8-bit RGB，无 alpha）的像素全为 0，PNG 用 node:zlib 独立解码并校验 CRC；ID ≡ NONE（0xFFFFFFFF）。
- **容忍度**：0。
- **能杀死**：累加器未清零、自发光泄漏、AOV 未初始化。

### G07 `env_constant_exact`
- **场景**：64×64，N = 48（**故意不是 2 的幂**），环境 constant 1 cd/m²（白），没有物体。
- **断言**：∀p,c：I(p,c) == 1.0（逐位精确）；m2(p,c) == 1.0。
- **精确性论证**：辐亮度 = L·color/Y(color) 在 CPU 上用 f64 计算，只舍入到 f32 一次，结果是 1.0；每个样本精确为 1.0；48 个 1.0 的累加和在 f32 中精确（整数 < 2²⁴，"正确舍入"作用于可表示的精确结果时就是精确值，§15.7.4）；均值在 CPU 上算 f32(48/48) = 1。
- **A3（实现修订，新增）**：彩色环境 `scene_red.json`（color = (1,0,0)，L = 1 cd/m²，N = 16）：每个像素 RGB = (1/0.2126, 0, 0)，BT.709 亮度 Y = 1，相对误差 ≤ (N + 2)·u。直接检验光度契约 D6-A。
- **能杀死**：Y 归一化写错（A3）、少累加一个样本、在 GPU 上做除法（N11）。

### G08 `furnace_convex`
- **场景**：128×128，N = 16，**D = 1**；环境 constant 1；一个球，r = 1，位于原点，ρ = (1,1,1)；相机在 (0, −4, 0)，看向原点，up = (0, 0, 1)，vfov = 0.6。变体 G08b：ρ = 0.5。
- **断言**
  - A1：∀p ∈ M_sphere（ID = 球，腐蚀 1 px）：|I − 1| ≤ τ（G08b 中为 |I − 0.5| ≤ 0.5τ）。
  - A2：∀p ∈ M_env：I == 1（精确）。
- **容忍度**：τ = (N − 1 + 5D)·u = 2.38e-6。来源：Higham §4.2 中递推求和的界 γ_{N−1}；每次弹射为 f·cos/pdf 预留 5 ULP（x/y 为 2.5 ULP，加两次乘法，再留余量）。
- **关键性质**：D = 1 时，一次自交就会让这个样本取 0，误差 ≥ 1/N = 0.0625，远大于 τ，所以这是一个精确的 acne 探测器。
- **能杀死**：去掉光线起点偏移、ρ 乘错、余弦采样的 pdf 写错。负对照 `bsdf_gain=1.001` 见 G15。

### G09 `furnace_enclosure_series`
- **场景**：相机在原点，位于一个球的内部（r = 1，球心在原点）；该球的材质 ρ = 0.75（白），emissive 1 cd/m²（白）；环境 0；64×64，N = 16；D ∈ {0, 1, 8}。
- **期望**：L_D = Le·(1 − ρ^{D+1})/(1 − ρ)，即 L_0 = 1，L_1 = 1.75，L_8 = 3.6996612548828125（= 242461/65536，在 f32 中精确）。
- **断言**：∀p,c：|I − L_D|/L_D ≤ τ_D，其中 τ_D = (N − 1 + 5(D + 1))·u：τ_0 = 2.38e-6，τ_1 = 2.98e-6，τ_8 = 7.15e-6。
- **另外**：V-Energy 的上界 B_c 在这里恰好等于 L_D，因此还检查校验器在紧上界下没有误报。
- **为什么零方差**：从球内出发的每条路径都必然打到墙，每次弹射的权重都是 ρ，所以每个样本的值完全相同，τ 只来自舍入。
- **能杀死**：第一次命中不计自发光（D = 0 时得到 0）、深度差一（D = 1 时得到 1 或 2.3125）、球内求交选错根（得到 0）、自发光重复计算。

### G10 `tilted_plane_split_sky`
- **场景**：平面过原点，法向 n = (sin θ, 0, cos θ)，θ = π/3；ρ = 0.5（白）；环境 split：up = (0, 0, 1)，上半球 1，下半球 0；相机在 3n 处看向原点，平面充满画面；64×64，N = 64，D = 1。
- **期望**：μ = ρ·(1 + cos θ)/2 = 0.375。单个样本 X ∈ {0, ρ}，p = 0.75，σ_X = ρ·√(p(1−p)) = 0.21651。
- **断言**
  - A1：|Ī − μ| ≤ 4σ_X/√(P·N) = 1.69e-3（P = 4096）。
  - A2：合并样本方差（由 m2 计算）：|s²/σ_X² − 1| ≤ 0.01。相对标准差 √((κ − 1)/(P·N)) = 2.26e-3，其中 κ 是 Bernoulli 的峰度 2.33；0.01 约为 4.4σ。
  - A3：I_r == I_g == I_b（逐位相等，因为白色环境和白色材质使用同一组随机数）。
- **来源**：等向天空视因子 (1 + cos β)/2（Duffie & Beckman,《Solar Engineering of Thermal Processes》，等向漫射模型）；Lambert BRDF ρ/π（PBRT-v4 §9.2）；CLT。平面是平的，出射光线不会再打到它，所以 D = 1 是精确的。
- **能杀死**：均匀半球采样配余弦权重、采样维度相关、split 判定写反。

### G11 `mc_convergence_slope`
- **场景**：G10，改为 32×32（P = 1024），N ∈ {1, 4, 16, 64, 256, 1024}。样本按前缀嵌套（计数器以样本序号为键）。
- **定义**：RMSE(N) = √(mean_p (I_N(p) − μ)²)。
- **断言**
  - A1：ln RMSE 对 ln N 做 OLS，斜率 b ∈ [−0.55, −0.45]（independent 采样器，D9-A）。
  - A2：∀N：RMSE(N)·√N/σ_X ∈ [0.9, 1.1]（绝对校准，不只看斜率）。
- **容忍度来源**：RMSE 的相对标准差 ≈ √((κ − 1)/(4P)) ≤ 2.2%（κ ≤ 3）；斜率的标准差 ≈ 0.022/√Σ(xᵢ − x̄)² = 3.8e-3，所以 ±0.05 约为 13σ；校准的 ±10% 约为 4.5σ。嵌套样本会让各点相关，但不会让斜率有偏。
- **能杀死**：样本序号不进计数器（斜率约为 0）、像素之间相关。

### G12 `bsdf_probe_lambert`
- **探针模式**：`meme probe bsdf`；材质 ρ = (0.8, 0.5, 0.2)，另有变体 ρ = (1,1,1)。用流 4 生成 K = 256 个分层的 ω_o，每个方向 M = 2¹⁶ 个样本。下面的判据都对 768 个（方向 × 通道）检验做 Bonferroni，取 k = 5。
- **断言**
  - A1 反照率：用均匀半球采样估计 â(ω_o)（与 BSDF 自带的采样器无关），|â − ρ_c| ≤ 5σ̂/√M。
  - A2 能量：â ≤ 1 + 5σ̂/√M（ρ = 1 变体同样检查）。
  - A3 pdf 归一化：用均匀采样估计 2π·mean(pdf)，|Ê − 1| ≤ 5σ̂/√M。
  - A4 采样一致性：采样器返回的权重 w 与重新计算的 f·cos/pdf 之差 ≤ 8 ulp(w)；E_sample[w] 与 â 之差 ≤ 5·√(σ₁²/M + σ₂²/M)。
  - A5 互易：在 4096 对方向上 |f(i,o) − f(o,i)| ≤ 2⁻²²·max f。
  - A6 支撑：f ≥ 0，pdf ≥ 0，并且 f > 0 ⇒ pdf > 0。
  - A7 采样器分布：2²⁰ 个样本落入 (cos θ, φ) 的 32×64 个箱；余弦 pdf 的箱概率有闭式 (μ_hi² − μ_lo²)/64，不需要数值积分（实现修订）；期望 < 5 的箱合并（Cochran 规则）；χ² 的 p ≥ 1e-4。
- **来源**：pbrt-v3 `src/tests/bsdfs.cpp` 中的 χ² 测试；Mitsuba 3 `mitsuba.chi2`；Veach 1997 博士论文第 6 章（BSDF 的互易与守恒）。
- **能杀死**：pdf 少除 π、cos 取绝对值的位置写错、半球翻转。

## D. 数值鲁棒性

### G13 `grazing_degenerate_rays`
- **场景**：平面 z = 0，n = (0, 0, 1)，ρ = 0.7；环境 split，上半球 1，下半球 0；一个相切球，球心 (2, 0, 0.5)，r = 0.5（与 x 轴相切于 (2, 0, 0)）；一个 r = 1e-3 的小球位于 (1, 0.3, 0.3)；高度取奇数，65 行。
  - 13a：相机在 (−5, 0, 0)，看向 (5, 0, 0)。中间一行的像素中心光线落在平面内（dir·n = 0 且 o·n = 0，即 0/0），并且与相切球的判别式恰好为 0。
  - 13b：相机抬高到 z = 1e-3（掠射命中）。
- **断言**
  - A1：I、m2、ID 中的非有限值个数 = 0（CPU 按位扫描）。
  - A2：∀p,c：0 ≤ I ≤ 1·(1 + (N − 1)·u)。这是一个无源场景（环境最大值 1，ρ ≤ 1），每个样本的值 ≤ 1。
  - A3：13a 中间一行，在 x 小于相切点的范围内，ID ∈ {NONE, tangent}；结果在 L1/L2 上确定。
  - A4：所有 ID 的取值都合法。
- **来源**：WGSL §15.7.2 Finite Math Assumption：除零得到的是不确定值，不一定是 NaN，所以只能靠守卫加上界兜住。
- **能杀死**：去掉平行光线守卫、判别式 < 0 时对负数开方。

### G14 `scale_extremes_furnace`
- **共同设置**：白炉，D = 1，N = 16，128×128。
  - 14a：r = 1e-3，位于原点，相机在 (0, −4e-3, 0)。
  - 14b：r = 1e3，位于原点，相机在 (0, −4e3, 0)。
  - 14c：**同一场景内尺度差 10⁶**：r = 1e-3 的小球（ρ = 1，不发光）位于原点，外面套一个 r = 1e3 的发光包围球（Le = 1，ρ = 0）；相机在 (0, −4e-3, 0)。D = 1 时，如果没有自交，小球的弹射光线会打到包围球（第 2 次交互，计入 Le = 1），得到 1；如果自交，就打到小球自己（Le = 0），得到 0。
  - 14d：球心 (1e4, 0, 0)，r = 2.5，正好卡在 `E_PRECISION` 的边界上（2⁻¹²·(1e4 + 2.5) = 2.442）；相机在原点，vfov = 0.01。
- **断言**：每个子场景都有 ∀p ∈ M_obj：|I − 1| ≤ 2.38e-6（同 G08）；∀p ∈ M_env：I == 1。
- **规则**：如果 14d 失败，就收紧 `E_PRECISION`，不放宽 τ。
- **来源**：Wächter & Binder 2019（Ray Tracing Gems 第 6 章）；Haines et al. 2019（Ray Tracing Gems 第 7 章）。
- **能杀死**：固定 ε 的偏移（在尺度的一端必然失败）、朴素二次方程（在 14b / 14d 失败）、相机相对坐标变换写错。

### G15 `validator_negative_controls`
- **方法**：只在测试构建中可用的 `--fault`，通过 WGSL `override` 常量实现，默认关闭。NaN 和 Inf 通过 u32 视图直接写入位模式 0x7FC00000 / 0x7F800000，因此任何浮点运算都无法把它们"假设掉"。
  - 15a：G08 + `nan@pixel(17,9).c1` → V-NaN 恰好报告 {(17, 9, 1, nan)}，退出码 = E_NONFINITE。
  - 15b：G08 + `inf@pixel(0,0).c0` → 恰好报告该点。
  - 15c：G17 + `nan@body(ball).v.z@step100` → 第一次出现的位置恰好是 (ball, 100, v.z)。
  - 15d：G08 不注入故障 → 报告为空，退出码 0。
  - 15e：G08 + `bsdf_gain=1.001` → V-Furnace 判红，V-Energy 判红（每个样本 1.001 > B·(1 + τ)）。
- **断言**：报告集合与期望集合完全相等；退出码相等。
- **容忍度**：0。
- **能杀死**：指数掩码写错、只扫第一帧、只扫 R 通道、校验器永远返回 pass。

### G16 `physics_extremes`
- **公共**：g = (0, 0, −9.81)（16b 除外）。各子场景都满足 `E_PRECISION`、`E_PRECISION_DT`。
  - 16a：dt = 1e-3，1000 步（T = 1 s）。
    - b_far：球心 (9000, 9000, 9000)，r = 4，v₀ = 0。
    - b_light：m = 1e-6 kg，位于 (1, 1, 1)，r = 0.01，v₀ = (1, 2, 3)；b_light_twin：同样的初始状态，m = 1 kg。
    - b_heavy：m = 1e6 kg，位于 (−9000, 0, 0)，r = 4。
  - 16b：g = 0，dt = 1e-3，1000 步；b_fast：v₀ = (1e4, −1e4, 1e4)。
  - 16c：dt = 1e-5（schema 下界），10000 步；b_slow：位于 (1, 1, 1)，v₀ = 0。
- **闭式解**（半隐式 Euler，f64）：x̂_n = x₀ + n·dt·v₀ + dt²·g·n(n+1)/2；v̂_n = v₀ + n·dt·g。
- **断言**
  - A1：所有记录步的非有限值个数 = 0。
  - A2：|x_n − x̂_n| ≤ τ_x(n)，其中 τ_x(n) = n·q + n·ulp(V·dt) + n²·dt·ulp(V)。
  - A3：|v_n − v̂_n| ≤ τ_v(n)，其中 τ_v(n) = 2n·ulp(V)。
  - A4：KE_n − KE_0 − W_n ≤ m·(V·τ_v + |g|·τ_x)，W_n 为重力做的功（动能有界）。
  - A5：b_light 与 b_light_twin 的轨迹逐位相等（质量不得进入无约束积分）。
- **数值**
  - 16a：τ_x(1000) = 9.55e-4 m，τ_v = 1.91e-3 m/s，下落 4.905 m。
  - 16b：实现统一用上面的一般公式，V = |v₀| = 1.73e4 m/s 时 τ_x = 1.96 m、τ_v = 3.9 m/s，比原先按"速度恒定"推的 9.54e-4 m 宽得多（实现修订）。实测误差为 0：dt·v = 10 m 在 f32 与定点中都精确。这个子场景因此主要检验有限性与定点进位，不检验精度。
  - 16c：τ_x = 6.19e-5 m，下落 0.049 m。
- **容忍度来源**：每步对 v 有两次舍入（fl(dx) 和 ·(1/dt)），误差逐步相加，得到 τ_v；对 x 有一次定点量化、一次 dx 舍入，再加上速度误差的积分，得到 τ_x；舍入误差按 faithful rounding 取 1 ulp。
- **能杀死**：b_far 杀死"f32 世界坐标"（位置停滞：前约 50 步 dx < ulp(9000)/2 = 4.9e-4，位置完全不动，之后误差远大于 τ_x）；b_far 同时杀死"相减形式的速度"；A5 杀死"质量进入积分"。
- **拒绝侧**：b_fast 加重力、dt = 1e-5 的组合进入 G20，期望 `E_PRECISION_DT`。

## E. 物理解析解

### G17 `free_fall_analytic`
- **场景**：1 个 body，x₀ = 0，v₀ = 0，g = (0, 0, −9.81)，T = 2 s。分两次：dt = 2⁻⁶（128 步），以及 dt/2（256 步）。
- **断言**
  - A1：|z_n − ẑ_n| ≤ τ_x(n)，ẑ 为离散闭式解：dt 时 τ_x = 4.92e-4 m，dt/2 时 τ_x = 9.80e-4 m。
  - A2：离散化误差与理论一致：|(z_n − z(t_n)) − (−|g|·dt·t_n/2)| ≤ τ_x(n)（代数恒等式：ẑ_n − z(t_n) = g·dt·t_n/2）。
  - A3：Δt 减半时一阶收敛：e(dt)/e(dt/2) ∈ [1.96, 2.04]。这里 e(dt) = 0.15328 m、e(dt/2) = 0.07664 m，代入 A1 的 τ 得到区间 [1.968, 2.032]，再取整。
- **能杀死**：dx 中 `dt²·g` → `dt·g`、记录步差一、显式 Euler（误差的符号相反）。

### G18 `projectile_energy_drift`
- **场景**：x₀ = 0，v₀ = (10, 0, 10)，g = (0, 0, −9.81)，dt = 2⁻⁷，256 步（T = 2 s）。
- **定义**：单位质量能量 e = ½|v|² − g·x。半隐式 Euler 的精确离散性质：每步 Δe = −½|g|²dt²。
- **断言**
  - A1：|(e_n − e₀) − (−n·½|g|²dt²)| ≤ τ_E，其中预测漂移为 −0.75184 J/kg，τ_E = V·τ_v + |g|·τ_x = 0.0852 J/kg（V = 33.76，τ_v = 1.95e-3，τ_x = 1.96e-3）。
  - A2：∀n：KE_n − KE_0 − W_n ≤ τ_E·m（有界；在离散恒等式下它恒为负）。
- **能杀死**：显式 Euler（漂移变成 +0.752，差 1.5，远大于 τ_E）、重力加两次。

## F. 契约

### G19 `patch_semantics`
- **场景**：基础场景 S₀ = G01；直接手写的终态 S_direct。
- **断言**
  - A1：apply(S₀, [replace `/objects/ball_a/radius_m`, add `/objects/ball_new`, remove `/objects/ball_b`]) 的 scene_hash = hash(S_direct)，并且渲染与物理输出逐字节相等。
  - A2：被拒绝的 patch 不改变状态（hash 不变），错误恰好为 {code, op_index, path}：
    - `move /materials/m1 → /materials/m9` 会让引用悬空 → `E_PATCH_INVALID_RESULT` 包裹 `E_REF_MISSING`
    - `test` 失败 → `E_PATCH_TEST_FAILED`
    - `replace /materials/m1/base_color/0` 为 1.5 → `E_PATCH_INVALID_RESULT` 包裹 `E_RANGE`
    - 改 `/v` → `E_PATCH_FORBIDDEN_PATH`
    - base_scene_hash 不匹配 → `E_PATCH_BASE_MISMATCH`
    - remove 不存在的 id → `E_PATCH_PATH_NOT_FOUND`
  - A3：原子性：一个由 5 个操作组成的 patch，第 4 个操作失败，结果与什么都没做逐字节相等。
  - A4：只改渲染相关字段的 patch（改 base_color）不改变 `state/*.bin` 的任何字节。
  - A5：json-patch-tests 的 `tests.json` 和 `spec_tests.json` 全部通过（外部裁判）。
- **容忍度**：0。
- **能杀死**：原地应用（A3）、不做结果校验（A2）、按下标而不是按 key 解析路径。

### G20 `schema_contract_corpus`
- **断言**
  - A1（MT1）：schema lint 的违规数 = 0。
  - A2：G01–G19 的全部场景都通过校验。
  - A3：下列拒绝语料逐条得到期望的 {code, path}：

| # | 输入 | 期望 code | path |
|---|---|---|---|
| 1 | `radius_m: 0` | E_RANGE | /objects/a/radius_m |
| 2 | `base_color: [1.01, 0, 0]` | E_RANGE | /materials/m/base_color/0 |
| 3 | `dt_s: 0` | E_RANGE | /physics/dt_s |
| 4 | `spp: 0` | E_RANGE | /render/spp |
| 5 | `spp: 1.5` | E_TYPE | /render/spp |
| 6 | `radius_m: "1"` | E_TYPE | /objects/a/radius_m |
| 7 | 拼错的 `radius` | E_UNKNOWN_PROPERTY | /objects/a |
| 8 | 缺少 `material` | E_REQUIRED | /objects/a |
| 9 | `radius_m: 1e999` | E_NONFINITE | /objects/a/radius_m |
| 10 | 坐标 `-1e999` | E_NONFINITE | /objects/a/center_m/0 |
| 11 | 重复 key `radius_m` | E_DUPLICATE_KEY | /objects/a/radius_m |
| 12 | id `Ball` | E_PATTERN | /objects |
| 13 | id `a/b` | E_PATTERN | /objects |
| 14 | 33 个字符的 id | E_PATTERN | /objects |
| 15 | material 指向不存在的 id | E_REF_MISSING | /objects/a/material |
| 16 | position == look_at | E_CAMERA_DEGENERATE | /camera |
| 17 | up 与视线平行 | E_CAMERA_DEGENERATE | /camera |
| 18 | 平面 `normal: [0,0,0]` | E_ZERO_VECTOR | /objects/p/normal |
| 19 | `environment.up: [0,0,1e-4]` | E_ZERO_VECTOR | /environment/up |
| 20 | r = 1e-3，\|c\| = 9e3 | E_PRECISION | /objects/a |
| 21 | emissive 5，颜色 [0,0,0] | E_COLOR_LUMINANCE | /materials/m |
| 22 | 环境 1 cd/m²，颜色 [0,0,0] | E_COLOR_LUMINANCE | /environment |
| 23 | 4096² × 65536 spp × 257 | E_BUDGET | /render |
| 24 | 两个 FNV-1a32 相同的 id（碰撞对离线搜索得到） | E_ID_HASH_COLLISION | /objects |
| 25 | `v: 2` | E_ENUM | /v |
| 26 | `seed: -1` | E_RANGE | /seed |
| 27 | `seed: 4294967296` | E_RANGE | /seed |
| 28 | 有 render、没有 camera | E_RENDER_REQUIRES | （根，JSON Pointer 为 ""） |
| 29 | render 和 physics 都没有 | E_EMPTY_RUN | （根） |
| 30 | 平面带 `body` | E_UNKNOWN_PROPERTY（按 `shape` 判别分支） | /objects/p |
| 31 | `shape: "cube"` | E_VARIANT | /objects/a/shape |
| 32 | v₀ = 1e4·(1, −1, 1)，有重力，dt = 1e-5 | E_PRECISION_DT | /objects/b/body |
| 33 | `center_m: [0, 0]` | E_ARITY | /objects/a/center_m |
| 34 | 4097 个对象 | E_TOO_MANY | /objects |
| 35 | 字面量 `NaN` | E_JSON_SYNTAX | — |
| 36 | `meta.name` 含控制字符 | E_PATTERN | /meta/name |
| 37 | 顶层键 `__proto__`（实现修订，新增） | E_UNKNOWN_PROPERTY | （根） |

  - A4：用自写的按 schema 采样生成器（流 4）生成 10⁴ 个实例，全部通过 schema；语义检查只返回结构化错误码；运行时崩溃率 = 0（除结构化错误以外的任何异常都算失败）。这一条也是"扰动输入后的失败率"的度量。
- **注意**：第 30 条需要按 `shape` 判别 oneOf 的分支来报错（ajv 的 `discriminator` 选项，或者自写一个错误映射器），否则 ajv 会把每个分支的错误都报出来。
- **能杀死**：去掉重复 key 检测、去掉 `E_PRECISION`、JCS 数字格式化出错、错误码映射出错。
