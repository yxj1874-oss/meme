# P0-02 实现交付：确定性运行时 + 校验器 + CI + 20 个黄金场景

> 设计见 [`P0-01-design.md`](P0-01-design.md)（D1–D15 全部按默认），黄金语料见 [`golden/p0/MANIFEST.md`](../golden/p0/MANIFEST.md)。
> 下文所有数字都来自参考基底（linux/arm64 容器，Mesa 25.0.7 lavapipe，LLVM 19.1.7，dawn.node 0.6.2，Node 24.22.0）上的实际运行。

## ① 目标与本次新出现的决策点

**目标**：把 P0-01 的三条契约落成可运行代码，并让 P0 验收的每一条都由机器判定。

新的分歧点（选择题，★ 为我的默认）：

| # | 分歧点 | 选项 |
|---|---|---|
| E1 | 三个变异只被输出哈希抓到、没有 oracle 抓到：`dim-block-reuse`（像素抖动与第一次弹射共用随机维度）、`no-parallel-guard`（去掉平面平行守卫）、`jcs-number-format` | **A★** 接受。三者都会让参考基底上的 golden 变红，满足"改一行必红"；`no-parallel-guard` 在 IEEE 语义的 lavapipe 上本就近似等价变异。<br>**B** 为前两者补专门的 oracle（需要新的统计型黄金场景，例如跨物体边缘的像素内相关性检验）。 |
| E2 | 机制 ① 的候选赛（P0-01 §3.11：C-RNG / C-Sphere / C-Offset / C-PNG / C-Diff）和 ꟻLIP（D14）在 P0 里**没有做** | **A★** 作为 P1 的第一项：P1 本来就要换积分器和 BSDF，候选赛在那里收益最大。<br>**B** P1 开工前先补完 P0 的候选赛。 |
| E3 | D11-A 里"StrykerJS 随机变异只报告"没有接入（会引入一组新依赖） | **A★** 暂不接入，精选变异已 100% 杀死。<br>**B** 接入，只报告杀伤率。 |

## ② 测试先行

- 20 个黄金场景、137 条断言结果，全部由 [`tools/gen_golden.ts`](../tools/gen_golden.ts) 从一份代码生成；CI 检查生成结果与提交文件一致。
- 41 条容忍度全部带推导与出处，锁在阈值锁里（P1 起 p0、p1 共用 [`golden/thresholds.lock`](../golden/thresholds.lock)）。
- 外部裁判：Random123 Philox KAT（6 条）、RFC 8785 附录 B（24 条数字样例 + §3.2.3 示例）、json-patch-tests（Apache 2.0，已入库 `test/vendor/`）、FNV-1a 规范测试向量、卡方分布临界值表。
- 元测试：MT1 schema lint、MT2 变异（27 条）、MT3 性能门、MT4 本地 = CI（哈希比较）、MT5 阈值锁。

## ③ 实现

| 模块 | 内容 |
|---|---|
| `src/core/` | 严格 JSON 解析（重复键、非有限数、`__proto__`）、ajv schema 校验与错误码映射（按判别式选 oneOf 分支）、语义检查、RFC 8785 JCS、RFC 6902 patch（原子、全量复验）、Philox4x32-10 |
| `src/kernels/` | `rng.wgsl`、`bsdf_lambert.wgsl`（渲染与 BSDF 探针共用）、`render_p0.wgsl`、`physics_p0.wgsl`（Q31.32 定点位置）、`probe_bsdf.wgsl`、`probe_fbh.wgsl`、`rng_check.wgsl` |
| `src/gpu/` | dawn.node 设备、字节计数分配器（`gpu_bytes_peak`）、substrate 指纹与 FBH |
| `src/runtime/` | 执行计划（pass / tile / 顺序 / 批次）、渲染与物理宿主代码、输出与 manifest |
| `src/io/` | 确定性 PNG（stored deflate）、PFM |
| `src/oracle/` | 三个校验器（V-NaN 按位扫描、V-Energy 逐样本上界、白炉经 `image_const`）、断言库、统计、探针、schema 采样器 |
| `src/tools/` | `determinism-check`、`golden verify / rebase`、`reduce`（ddmin 最小复现） |
| `tools/` | 确定性 lint（TS AST）、黄金语料生成器、阈值锁、变异测试、性能门 |
| `ci/` | 参考基底 Dockerfile（Debian snapshot 固定版本）、`run-in-ref.sh`、`mutants.json`、`perf-baseline.json` |
| `.github/workflows/p0.yml` | arm64 runner 上在同一镜像规格里跑 `npm run ci`、变异测试；失败时自动 `reduce --all-failing` 并上传产物 |

常用命令见 [`README.md`](../README.md)。

## ④ 会让本实现失败的极端输入

| 输入 | 状态 |
|---|---|
| 尺度差 10⁶（1e-3 m 小球套在 1e3 m 发光球壳里）、`E_PRECISION` 边界上的远处球 | 已兜住：G14 四个子场景在 max_bounces = 1 的白炉下误差为 0（任何一次自交都会让样本变 0） |
| 与平面完全平行的光线（0/0）、恰好相切的球 | 已兜住：G13 有限、能量有界、ID 合法 |
| f32 停滞（大坐标、大速度、小 dt） | 已兜住：定点位置 + `E_PRECISION_DT`；G16 的远处物体位置误差 7.7e-5 m（容忍度 9.5e-4 m） |
| 实现中新发现：dawn.node 的 GPU 实例被垃圾回收后设备段错误 | 已修：`Gpu` 持有实例引用 |
| 实现中新发现：WGSL 拒绝常量表达式中的 NaN（§15.7.2） | 已修：故障注入的 NaN 位模式从 uniform 传入 |
| 实现中新发现：定点位置用 `floor` 拆分负的小步长时，小数部分按 ulp(1) 舍入（−1e-6 m 的步长每步损失约 6e-8 m） | 已修：改用 `trunc`，并作为变异 `fixed-point-floor` 由 G16 守住 |

## ⑤ 验收布尔清单（参考基底实测）

| 判据 | 结果 |
|---|---|
| ∀ golden：oracle 全过 | ✅ 20/20 |
| ∀ golden、∀ 输出文件：哈希 = `expected.json`（`--require-hashes`） | ✅ 20/20（本地参考容器） |
| 本地与 CI 逐字节相同（MT4） | ✅ GitHub `ubuntu-24.04-arm` 上 substrate_id 与本机参考容器相同；17 个有输出的 golden 的全部文件哈希与本地录制值一致（[run 40122906861](https://github.com/yxj1874-oss/meme/actions/runs/40122906861)） |
| `--determinism-check` 在 G01、G03、G16 上退出码 0 | ✅ |
| ∀ 精选变异：∃ golden 变红（MT2） | ✅ 27/27，其中 3 条只被哈希抓到（见 E1） |
| G15 负对照全部按预期变红 | ✅ 6/6 |
| MT1 schema lint 违规 = 0 | ✅ |
| MT5 阈值锁未变或附 ADR | ✅ 41 条锁定、0 变更 |
| 性能门（MT3） | ✅ 工作量计数器基线已记录（G01：1 595 301 条光线段，690 112 B）；墙钟改为与父提交同机 A/B。负对照：把 head 的渲染做两遍，G01 比值 ×1.85 判红 |
| golden 数量 ≥ 20 | ✅ 20 |
| `src/` 中 TODO/FIXME = 0 | ✅（lint 检查） |
| 单元测试 | ✅ 33/33 |

## ⑥ 黄金场景与指标

- 20 个场景、36 个场景文件、37 条拒绝语料，见 MANIFEST。
- 代表性实测：G10 平面均值 0.37522（理论 0.375，4σ 界 1.69e-3）；G11 收敛斜率 −0.5026、校准 0.97–1.01；G12 卡方 p = 0.70 / 0.07；G17 Δt 减半误差比 1.9990；G18 能量漂移 −0.751868 J/kg（离散理论值 −0.751845）；G20 模糊 10⁴ 个场景、0 崩溃。
- FBH：Metal 上 `a*b+c` 100% 融合，lavapipe 上 100% 分开舍入。
- 最小复现演示：`pass-local-sum` 变异下 G03 失败，`meme reduce g03` 用 28 次评估把场景从 7 物体 / 7 材质缩到 1 / 1，spp 64 → 32，弹射 4 → 1，物理步 256 → 1。

## 未做与限制

- 第一次 CI（run 40122906861）只在性能门上失败：存储的墙钟基线是在 M6 上测的，GitHub runner 慢 2.56 倍，而工作量计数器完全一致。已改为同机 A/B（见 P0-01 的 MT3）；同一份代码在本机容器里 A/B 的比值落在 0.94–1.05。
- 机制 ① 候选赛与 ꟻLIP 未做（E2）；golden 失败时报告给出数值与位置，但没有生成差异热力图（热力图只在 `determinism-check` 失败时生成）。
- StrykerJS 未接入（E3）。
- 随机流 3 的局部性测试推迟到 P2（P0 尚未使用流 3）。
- G16b 用的一般误差界较宽（τ_x = 1.96 m，实测 0），见 MANIFEST。
- 墙钟 10% 的限值离噪声不远：同一份代码在本机容器里 A/B 比值为 0.94–1.05。失败前会自动重测两次；若 CI 上仍出现误报，需要单独讨论（不能靠放宽限值解决）。
- 仓库的第一个提交没有父提交，A/B 在那次运行里会跳过并在日志里注明。
