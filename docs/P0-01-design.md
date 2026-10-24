# P0-01 设计：场景契约 v1 · 确定性运行时 · 首批 20 个黄金场景

> 状态：**已确认（D1–D15 全部按默认），P0 已实现**。实现中对本设计的修订都在正文中标为「实现修订」，实现结果见 [`P0-02-implementation.md`](P0-02-implementation.md)。
> 本步交付三份文件：
> - [`schema/scene.schema.json`](../schema/scene.schema.json)：场景契约 v1 草案
> - 本文：确定性运行时的可验证设计与决策点
> - [`golden/p0/MANIFEST.md`](../golden/p0/MANIFEST.md)：20 个黄金场景及其断言

---

## ① 一句话目标与本次决策点

**目标**：把三条契约（场景、确定性、裁判）写成机器可判的形式，让 P0 的每一行代码在写出来之前就已经有断言等着它。

**决策点**（★ 为我的默认；回复形如 `D1A D2B …`，或"全部默认"）：

| # | 分歧点 | 选项 | 依据 / 影响 |
|---|---|---|---|
| **D1** | "逐字节相同"在跨机器时的范围 | **A★** 逐字节只在同一 *substrate 指纹*内保证（见 §3.2）。golden 在固定的参考基底上生成，本地和 CI 都在这个基底上跑，所以 PNG 一致；M6 的 Metal 只保证自身重跑一致，和 golden 用容差比较。<br>**B** 所有核函数改用定点整数，对任何合规 WebGPU 实现都逐字节一致；预计慢 3–10 倍，1000× 尺度差下定点动态范围不够，sin/exp/sqrt 全部要自写。<br>**C** 按 GPU 型号分别存 golden，CI 需要 GPU runner。 | WGSL 规范本身不保证跨实现的 f32 结果按位一致：§15.7.2 "No rounding mode is specified"（舍入可上可下）；§15.7.5 允许重结合（reassociate）和融合（fuse，如 FMA）；§15.7.4.1 中 `x/y` 为 2.5 ULP，`inverseSqrt` 2 ULP，`sin/cos` 在 [−π,π] 内绝对误差 2⁻¹¹；§15.7.2 还允许 flush-to-zero、忽略零的符号。所以 B 是唯一的规范级保证，A 是工程级保证。 |
| **D2** | 参考基底 | **A★** linux/arm64 容器 + Mesa lavapipe（软件 Vulkan）+ dawn.node；CI 用 GitHub 的 arm64 runner。和本机 M6 同架构，不需要模拟。<br>**B** linux/amd64 + lavapipe：预编译包齐全，但本机要靠 x86 模拟，慢，而且模拟层本身就是一个额外变量。<br>**C** SwiftShader 代替 lavapipe（需要自编带 SwiftShader 的 Dawn）。 | npm `webgpu`（dawn.node）的 README 列出 win64 / macOS-intel / macOS-arm / linux，没写明 linux-arm64；A 可能需要在镜像里从源码编一次 dawn.node（编完缓存进镜像）。**实测**：`webgpu@0.6.2` 自带 `dist/linux-arm64/dawn.node`，不需要自编。lavapipe 的 LLVM JIT 可能按宿主 CPU 特性（FMA / AVX-512 / SVE）生成不同代码，由 §3.2 的浮点行为探针在每次运行时检测。 |
| **D3** | CI 平台 | **A★** GitHub Actions（需要你建仓库）<br>**B** 先只做本地容器 CI（`npm run ci` 在容器里跑），之后再接远端<br>**C** 其他（GitLab 等） | 当前目录还不是 git 仓库，本机也没有 `gh`。 |
| **D4** | Schema 版本策略 | **A★** schema 等于当前能力：v1 只接受 P0 能执行的内容（球、平面、Lambert + 自发光），每个阶段升一次 v，附迁移与回滚。<br>**B** v1 一次性包含七参数材质，未实现的参数报 `E_UNSUPPORTED`。 | A 的好处：约束解码不可能生成运行时做不了的场景；迁移机制从 P1 起就会被真实使用，不会到 P4 才第一次跑。 |
| **D5** | 实体集合的形态 | **A★** 以 id 为键的对象：`/objects/ball_1/radius_m`。运行时按 key 的字节序遍历。<br>**B** 数组：`/objects/3/radius_m`。 | A：patch 路径稳定，与插入顺序无关；ddmin 最小化可以直接按实体删除。B：插入或删除会让后面所有路径漂移。 |
| **D6** | 光度单位 | **A★** 发光和环境用亮度 cd/m² + 线性 Rec.709 色度；内部 RGB 辐亮度 = L·color / Y(color)，Y = 0.2126R + 0.7152G + 0.0722B，因此像素值的 Y 分量就是 cd/m²。<br>**B** 辐射度 W/(sr·m²)。 | "m/kg/s/cd/m²" 我理解为 m、kg、s、cd、cd/m²。另外还需要 rad 和无量纲 1，已写进单位表（UCUM 代码）。 |
| **D7** | P0 自带多少渲染/物理 | **A★** P0 带一个最小路径追踪器（球 + 平面、双面 Lambert、BSDF 余弦采样，不做 NEE/MIS）和一个无约束 XPBD（只有重力）。<br>**B** P0 只用合成缓冲测试校验器，白炉留到 P1。 | 不选 A，白炉、能量、NaN 三个校验器就没有真实目标可测。P1 在 A 的基础上加 NEE、镜面、GGX、MIS。 |
| **D8** | RNG | **A★** Philox4x32-10：key = (seed, stream) 正好是 2×u32，counter 是 4×u32，并且有 Random123 的已知答案向量（KAT）作外部裁判。P0 内同时跑候选赛（Philox / Threefry2x32-20 / PCG4D），输出 Pareto 表。<br>**B** 直接用 PCG4D。 | PCG4D（Jarzynski & Olano 2020, JCGT 9(3)）更快，但 seed 只能异或折叠进输入，跨 seed 的独立性没有保证。 |
| **D9** | 收敛检验的判据 | **A★** 收敛检验固定用 independent 采样器，要求 slope ∈ [−0.55, −0.45]；以后加分层采样器时改判 slope ≤ −0.45。<br>**B** 一律只判 slope ≤ −0.45。 | 分层/QMC 采样的收敛比 1/√N 快，斜率会"不符"。 |
| **D10** | "超时降局部质量"与确定性的冲突 | **A★** 预算只用确定性的工作量单位（每个 tile 的 spp、bounce 上限）。墙钟只能在运行前用来选计划，选定的计划写进 manifest；按 manifest 重跑逐字节一致。<br>**B** 允许按墙钟截断，输出标记为 nondeterministic，不进 golden。 | 墙钟超时本身就是一个隐式随机源。 |
| **D11** | "故意改一行代码回归必红"怎么判 | **A★** 维护一份精选语义变异清单（§3.9），必须 100% 被杀；StrykerJS 随机变异的杀伤率只报告，不设门槛。<br>**B** 随机变异杀伤率设硬门槛（数值由你定）。 | "任意一行"做不到：注释、死代码、等价变异都杀不掉。 |
| **D12** | "显存"指标 | **A★** 记录自有分配器分配的 buffer/texture 字节数。这个值是确定性的，可以精确地按 10% 门控。<br>**B** 用平台工具测（不跨平台）。 | WebGPU 没有查询显存的 API。 |
| **D13** | PNG 编码器 | **A★** 自写：filter 0 + deflate stored 块 + CRC32/Adler32，约 80 行，零依赖，字节确定。<br>**B** 固定版本的纯 JS deflate（pako）。两者都进候选赛。 | DEFLATE（RFC 1951）不规定唯一编码，压缩输出的字节随 zlib 实现与版本变化，不能用 node 自带的 zlib。 |
| **D14** | 图像差异度量（跨基底比较、golden 重建报告） | **A★** ꟻLIP（Andersson et al. 2020, HPG）<br>**B** SSIM<br>**C** 最大 ΔE2000 | 在参考基底上，回归门控始终是逐字节哈希，感知度量只用于 L3 比较和"有意变更"的报告。 |
| **D15** | 物理的精度模型 | **A★** 世界位置用 i64 定点（量子 q = 2⁻³² m，两个 u32 带进位模拟），速度用 f32，渲染改用相机相对的 f32 坐标；再加语义检查 `E_PRECISION_DT`（已写进 schema）。<br>**B** 全部用 f32，坐标范围收窄到 \|x\| ≤ 1e3 m，同样加 `E_PRECISION_DT`。<br>**C** df64（双 f32 补偿求和）。 | 见 ④ 第 3 条。WGSL 整数运算是模 2³² 精确的（§6.2.3），所以 A 的位置累加跨基底按位一致，P2 里 Δx = x_i − x_j 也是精确的。C 不可行：§15.7.5 允许重结合，`(a−s)+b` 这类无误差变换可以被编译器化简掉。 |

**环境前置**（已完成）：Node 24.22.0 LTS（`.nvmrc`）、Colima + Docker CLI（arm64、vz 虚拟化）、`git init`。D3 选 A 还需要一个 GitHub 仓库，工作流已写在 `.github/workflows/p0.yml`。

---

## ② 测试先行

- **黄金场景**：20 个，见 [`golden/p0/MANIFEST.md`](../golden/p0/MANIFEST.md)。每条都写明断言的数学形式、容忍度、容忍度来源，以及它能杀死哪些变异。
- **契约级元测试**（不算黄金场景）：

| id | 断言 |
|---|---|
| MT1 schema lint | 解析 `$ref` 后，每个 `type:number` 节点都有 `x-unit` ∈ 单位表、下界（`minimum`/`exclusiveMinimum`）、上界；每个 integer 都有上下界；每个 object 都是 `additionalProperties:false` 或带 schema；每个 string 都有 const / enum / pattern / maxLength 之一。违规数 = 0。 |
| MT2 变异 | ∀ 精选变异 m：至少一个 golden 变红（§3.9）。在参考基底上以 `golden verify --require-hashes` 运行：哈希检查被跳过即判红。实现时发现一个改 JCS 数字格式的变异会顺带改变 substrate_id，使哈希检查被静默跳过，这条规则就是为它加的。 |
| MT3 性能 | 确定性工作量计数器（光线数、求交次数、物理步数、分配字节数）≤ 1.10 × 基线；ms/frame 的 5 次中位数 ≤ 1.10 × 同类 runner 的基线中位数，超出时自动复跑 2 次，仍超出才判红。 |
| MT4 本地 = CI | ∀ golden g、∀ 输出文件 f：sha256(本地参考基底) = sha256(CI)。实现：`expected.json` 在本地参考容器里由 `golden rebase` 生成并提交，CI 在同一镜像规格里跑 `golden verify --require-hashes`，任何一个文件哈希不同即红。 |
| MT5 阈值锁 | 所有 oracle 容忍度的哈希写在 `golden/p0/thresholds.lock`；改动容忍度而没有附带引用该场景 id 的 `docs/adr/*.md`，CI 判红。这条用来机器化执行"禁止用放大阈值代替修复"。 |
| MT6 迁移往返 | 每个 golden 走 migrate → rollback → migrate，scene_hash 不变（v2 出现后启用）。 |

- **容忍度政策**：容忍度只有三种来源。
  1. **0**：附带精确性论证（例如"每个样本精确等于 1.0，48 个 1.0 的和在 f32 中精确"）。
  2. **浮点误差界**：取 u = 2⁻²³（而不是 2⁻²⁴），因为 WGSL 不规定舍入方向，只能按 faithful rounding 估计；求和误差按 Higham《Accuracy and Stability of Numerical Algorithms》§4.2 的 γₙ。
  3. **抽样分布**：取 kσ，k = 4；同一场景内有多重检验时用 Bonferroni 修正到 k = 5。seed 固定在场景里，所以结果是确定的，不会 flaky。

---

## ③ 实现设计（不含代码）

### 3.1 场景契约

1. **严格解析**：用自写的 JSON tokenizer。重复 key 判 `E_DUPLICATE_KEY`（`JSON.parse` 会静默保留最后一个；RFC 8259 §4 只说名字 SHOULD 唯一）；非有限数判 `E_NONFINITE`（`JSON.parse("1e999")` 会得到 `Infinity`）。
2. **Schema 校验**：用 ajv（2020-12，strict 模式），`x-*` 注册为注解关键字。ajv 的错误按 `x-error-codes` 映射成 `{code, path, detail}`。
3. **语义检查**：执行 `x-semantic-checks`，这些是 JSON Schema 表达不了的跨字段规则，都在任何 GPU 工作之前完成。
4. **规范化与哈希**：展开默认值 → 去掉 `/meta` → RFC 8785 JCS → `scene_hash = sha256:…`。
5. **Patch**：信封 `{v, base_scene_hash, ops}`。在深拷贝上依次应用 RFC 6902 操作 → 对整个结果做 schema + 语义校验 → 全部通过才替换；任何一步失败，状态都不变。禁止改 `/v`。applier 自写，用 json-patch-tests（`tests.json` 与 `spec_tests.json`）作外部裁判。
6. **迁移**：每次升 v 都附 `migrate_vN_to_vN+1` 和 `rollback_vN+1_to_vN`。回滚要么无损，要么报 `E_ROLLBACK_LOSSY` 并列出会被丢弃的路径。
7. **约束解码兼容**：schema 只用 type / const / enum / properties / required / additionalProperties / propertyNames / 数值上下界 / minItems / maxItems / 以 const 判别的 oneOf / 本地 `$ref`。例外是顶层的 `anyOf`（render 与 physics 至少有一个）和 `dependentRequired`；部分解码器可能不支持它们，所以两者都有对应的语义检查兜底（`E_EMPTY_RUN`、`E_RENDER_REQUIRES`）。另外自写一个"按 schema 采样实例"的生成器（harness 流 4），既用来做 schema 的可靠性测试，也用于鲁棒性模糊测试。

### 3.2 确定性模型

| 级别 | 保证 | 怎么检查 |
|---|---|---|
| **L1** 同机重跑 | 逐字节一致（进程内两次、两个新进程各一次） | `--determinism-check` |
| **L2** 同一 substrate 指纹，跨机器 | 逐字节一致，这是 golden 的基础 | MT4 |
| **L3** 跨 substrate | 不保证逐字节一致；用数值 oracle + ꟻLIP | 报告，不做门控 |

**确定性键**：K = (code_hash, scene_hash, plan_hash, substrate_id)，seed 在场景里，已包含在 scene_hash 中。

- `code_hash`：对 `src/**/*.{ts,wgsl}` 和 `package-lock.json` 按路径排序后取 SHA-256。
- `plan_hash`：执行计划（tile、pass、预算）的 JCS 哈希。按 G03，plan 不应改变输出，但它仍然记录在键里。
- `substrate_id`：对以下内容的 JCS 取 SHA-256：`GPUAdapterInfo`（vendor / architecture / device / description）、后端、dawn.node 版本、`process.versions.{node,v8}`、OS/arch、镜像规格（`ci/Dockerfile` 的 sha256）、`LP_*`/`GALLIVM_*`/`MESA_*` 环境变量（`LP_NUM_THREADS` 除外），以及 FBH。
  **实现修订**：
  - CPU 型号与特性位仍记录在指纹里，但**不进** `substrate_id`。否则本机 M6 与 GitHub arm64 runner 永远是不同基底，"本地 = CI" 的逐字节比较根本不会发生；lavapipe 的结果应只依赖 ISA 与 JIT，若真依赖 CPU 型号，FBH 会变并指出来。
  - 用镜像规格哈希代替镜像 digest：同一份 Dockerfile 在两台机器上构建出的 digest 不同（层时间戳），但 apt 源已固定到 Debian snapshot，内容等价。
  - 实测 FBH：M6 Metal 上 `a*b+c` 100% 是融合结果（FMA），lavapipe 上 100% 是分开舍入的结果，两者对同一段 WGSL 给出不同的位，D1 的前提得到证实。
- **FBH（浮点行为探针）**：一个 WGSL 核函数，对 2¹⁶ 组 Philox 生成的输入执行固定的一组运算：`a*b+c`（检测融合）、`(a+b)+c` 与 `a+(b+c)`（检测重结合）、`x/y`、`inverseSqrt`、`sqrt`、`exp2`、`log2`、`sin`、`cos`、`pow`、`normalize`、次正规数的输入输出（检测 FTZ）、−0；结果按 `bitcast<u32>` 取 SHA-256，并导出几个标志位（检测到融合 / FTZ 等）。
  **诚实说明**：FBH 相等是必要条件，不是充分条件，因为编译器的融合决定依赖代码上下文。FBH 的作用是把一次失败归类为"基底漂移"还是"代码回归"；真正的仲裁永远是 golden 哈希。FBH 的输入来自专用随机流 6（`substrate_probe`，固定 key），不占用场景或测试工具的流。

### 3.3 非确定性来源 → 规则 → 怎么被抓住

| # | 来源 | 规则 | 强制手段 |
|---|---|---|---|
| N1 | 隐式随机：`Math.random`、`Date`、`performance.now`、`crypto`、`process.hrtime` | 在 `src/core`、`src/gpu`、`src/kernels`、`src/io`、`src/oracle` 中禁用；计时只允许出现在 `src/perf`，结果只写进 `manifest.perf` | ESLint `no-restricted-globals` / `no-restricted-properties` + import 边界；G01 |
| N2 | 遍历顺序：JSON key 插入序、Map/Set 插入序、`for…in` | 实体集合一律经 `canonicalEntries()`（UTF-8 字节序）遍历 | G02：打乱 key 顺序、改写数字形式后，输出逐字节一致 |
| N3 | 未初始化内存 | WGSL 的 function / private / workgroup 变量零初始化（§7.3）；WebGPU 资源创建时零初始化；TypedArray 零初始化；池化分配器复用前必须清零 | G06、G07；变异"池化不清零" |
| N4 | 浮点归约顺序 | 每个像素由一个 invocation 负责，按样本序号累加；工作组归约用固定形状的树；WGSL 本来就没有浮点原子，禁止用 CAS 循环模拟浮点加；需要散射累加时用 i32 定点 `atomicAdd`（整数加法满足结合律，与顺序无关） | WGSL lint：核函数里出现 `atomicCompareExchangeWeak` 必须带 `// det-ok:` 说明；G03 |
| N5 | 原子计数器分配槽位（append buffer） | 只允许后接确定性的稳定排序（基数排序），或者改用前缀和压缩 | G03 的调度置换；P0 核函数不使用 |
| N6 | tile 大小、pass 划分、dispatch 拆分、tile 顺序 | 输出不得依赖其中任何一个 | G03：同一场景 5 种执行计划逐字节一致；harness 用流 5 置换 workgroup→tile 的映射 |
| N7 | 从适配器 limits 推导 workgroup 大小 | workgroup 大小是 WGSL 里的常量；dispatch 尺寸只由场景决定 | grep 规则；G01 |
| N8 | 浮点实现差异（舍入方向、融合、FTZ、超越函数精度） | 用 L2 的 substrate 指纹隔离；在 L3 上不可能保证 | FBH；manifest 记录 `substrate_id` |
| N9 | Finite Math Assumption：运行时溢出、Inf、NaN 的结果是"不确定值"（§15.7.2），不一定是 NaN | 不依赖 NaN 自然传播。每个除法、开方、归一化之前都有显式守卫（分母小于阈值就走定义好的分支）；非有限值在 CPU 上读回后按位扫描（检查指数位）；能量上界检查兜住"不是 NaN 的垃圾值" | G13、G15、G16 |
| N10 | CPU 侧超越函数（V8 的 `Math.tan` 等） | 只用于设置阶段（如相机基）；Node/V8 版本写进 `substrate_id` | `substrate_id` |
| N11 | 像素均值的除法 | 在 CPU 上计算 `f32(f64(Σ)/spp)`：IEEE 正确舍入，确定；GPU 上不做除法 | G07 要求结果精确等于 1.0 |
| N12 | 编码器 | PNG 自写（不写 tIME/tEXt 块，不依赖压缩器）；PFM 小端；JSON 用 JCS | G01 的文件级哈希 |
| N13 | 异步完成顺序 | `mapAsync` 的结果按索引写入；禁止 `Promise.race` 和按完成顺序拼接 | ESLint；G03 |
| N14 | 语义缓存 | 缓存键 = 完整的确定性键 K；有缓存后 `--determinism-check` 必须绕过它（否则就是自证）。P0 没有结果缓存，这条规则在缓存落地时生效 | 缓存落地时的单元测试 |
| N15 | 墙钟预算 | 见 D10 | `manifest.plan` |
| N16 | 实体身份进入 RNG 计数器 | 用 `idhash32(id)`（FNV-1a 32），不用排名，这样增删一个实体不会改变其他实体的随机数；哈希碰撞直接拒绝（`E_ID_HASH_COLLISION`） | G20 #24 检查碰撞拒绝。P0 尚未使用流 3，"增删实体不改变其他实体随机数"的局部性测试随流 3 在 P2 落地 |
| N17 | manifest 里混入计时 | manifest 分为 `deterministic` 和 `perf` 两段，只有 `deterministic` 段参与比较 | G01 |

### 3.4 执行管线

```
scene.json ─► 严格解析 ─► schema ─► 语义检查 ─► 规范化 + scene_hash
plan（运行选项）─► plan_hash
                    │
                    ▼
上传：按 id 字节序排名得到 buffer 下标；所有渲染坐标为相机相对 f32（D15-A）
        │
        ├─► 物理：N 步固定 dt；WGSL compute；XPBD delta 形式
        │        dx = dt·v + dt²·g（f32）；x += Q(dx)（i64 定点）；v = dx·(1/dt)
        │        每 k 步读回一次快照
        │
        └─► 渲染（P0 只渲染第 0 步）：每像素一个 invocation
                 for s in 0..spp：rng = Philox(key=(seed,0), ctr=(px,py,s,dim))
                 累加 Σx、Σx²（f32）；id AOV 来自像素中心光线
        │
        ▼ 按索引读回
CPU：按位扫描非有限值 → 均值 f32(Σ/spp) → 校验器 → 曝光 + sRGB OETF（f64）
     → PNG / PFM → JCS 指标 → manifest
```

物理驱动渲染属于 P3，P0 只渲染初始状态。

### 3.5 输出与 manifest

```
out/
  image.linear.pfm      线性 RGB f32，小端
  image.png             8-bit sRGB（RGB，无 alpha）：q = floor(255·OETF(clamp(L/display_white,0,1)) + 0.5)，OETF 按 IEC 61966-2-1
  aov.id.u32            像素中心光线首次命中的对象排名，未命中为 0xFFFFFFFF
  aov.m2.pfm            Σx² / spp，用于方差估计
  state/step_NNNNNN.bin 按 id 排名的 {x(定点), v(f32)} 原始字节
  state/step_NNNNNN.json 同一快照的 JCS（"可反射为可检索 JSON"）
  metrics.json
  manifest.json
```

```json
{
  "v": 1,
  "key": { "code_hash": "sha256:…", "scene_hash": "sha256:…", "plan_hash": "sha256:…", "substrate_id": "sha256:…" },
  "deterministic": {
    "outputs": { "image.png": "sha256:…", "image.linear.pfm": "sha256:…" },
    "metrics": { "image": { "mean": [0, 0, 0], "max": [0, 0, 0], "nonfinite": 0 }, "physics": { "ke": [], "e_total": [] } },
    "work": { "rays": 0, "isect_tests": 0, "physics_steps": 0, "gpu_bytes_peak": 0 },
    "validators": [ { "name": "nan", "pass": true } ]
  },
  "perf": { "render_ms_median": 0, "physics_ms_per_step_median": 0, "runs": 5 },
  "substrate": { "adapter": {}, "fbh": "sha256:…", "flags": { "fusion_detected": false, "ftz_detected": false } }
}
```

### 3.6 共用 buffer 布局（物理读写，渲染只读）

```
struct Body {            // 48 B，按 id 字节序排名索引
  xq_lo : vec3<u32>,     // 定点位置低 32 位
  flags : u32,
  xq_hi : vec3<i32>,     // 定点位置高 32 位（有符号）
  inv_mass : f32,        // 静态体为 0
  v : vec3<f32>,
  _pad : u32,
}
```

物理驱动渲染（P3）时，渲染每帧先算一次 `(xq − cam_q)`：这是精确的整数差，再转成 f32，于是近处物体的精度与它离世界原点多远无关，这一点也顺带改善了 1000× 尺度差的情况。P0 只渲染第 0 步，所有球心（包括带 body 的）直接取 JSON 的 f64 减相机位置，在 CPU 上用 f64 完成后再转 f32。（这条布局随 D15 选择而定；选 B 时 `x` 退回 `vec3<f32>`，32 B。）

### 3.7 `--determinism-check`

1. 起两个新的子进程，相同的 plan；子进程 A 带 `--repeat-in-process` 在进程内再跑第二次（用来抓缓存或全局状态泄漏）。
2. 执行计划不变性不放在 `--determinism-check` 里，由 G03 的 5 种计划逐字节比较覆盖（实现修订）。
3. 逐个比较 `manifest.deterministic` 的 JCS 字节和每个输出文件的字节。
4. 不一致时：定位第一个不同的字节，映射回语义坐标（像素 x, y, 通道 / 物体 id、步、字段 / JSON Pointer），写出 `nondet_report.json` 和差异热力图（|A−B|，对数色标），退出码 3。
5. 全部一致才退出 0。

### 3.8 三个校验器

- **V-NaN**：在 CPU 上逐位扫描每个 f32 输出（图像、m2、每个记录步的状态）：指数位全为 1 即为非有限。报告前 K 个出现位置及其语义坐标；同时检查 id AOV 的取值都在合法 id ∪ {NONE} 之内。
- **V-Furnace**：给定掩码（由 id AOV 得到，并腐蚀 e 个像素）和期望值（常数或具名解析函数），逐像素检查 \|I − E\| ≤ τ；报告最大误差、位置和误差热力图。
- **V-Energy**：
  (a) 图像：对 P0 积分器（余弦采样下每次弹射的权重恰好是 ρ），单个样本的路径值有上界 `B_c = L_env,max,c + Le_max,c · Σ_{k=0}^{D} ρ_max,c^k`。它对每个样本成立，所以对像素均值也成立，再乘上舍入因子 (1 + (spp + 5D)·2⁻²³)。
  (b) BSDF：方向反照率 ≤ 1（G12）。
  (c) 物理：KE_n − KE_0 − W_n ≤ τ_E，其中 W_n 是重力做的功。

### 3.9 Oracle DSL 与精选变异

`golden/p0/<gid>/oracle.json`（确认后生成）：

```json
{
  "scene": "scene.json",
  "runs": [ { "name": "a", "plan": { "tile": 16, "pass_spp": 16 } } ],
  "assert": [
    { "id": "A1", "kind": "image_const", "target": "a:image.linear.pfm",
      "mask": { "id_in": ["ball"], "erode_px": 1 }, "expect": 1.0,
      "tol": { "rel": 2.4e-6,
               "derivation": "(spp-1 + 5*D) * 2^-23, D=1, spp=16",
               "source": "Higham 2002 §4.2; WGSL §15.7.4 faithful rounding" } }
  ]
}
```

断言种类：`bytes_equal`、`hash_equal_across_runs`、`image_const`、`image_fn`（具名解析解）、`image_bound`、`channels_equal`、`stat_mean`（kσ，σ 由 m2 估计）、`loglog_slope`、`rmse_calibration`、`chi2`、`bsdf_probe`、`traj_closed_form`（具名闭式解）、`energy_drift`、`nonfinite_set`、`reject`（code + path）、`patch_result`。每个 `tol` 都必须带 `derivation` 和 `source`（由 MT5 lint 检查）。闭式解是具名的 TS 函数（`enclosure_series`、`split_sky_tilted_plane`、`semi_implicit_euler_ballistic` …），每个函数的文档注释写明推导和出处，不使用字符串表达式求值。

**精选变异清单**（D11-A，每条至少被一个 golden 杀死）。实现见 [`ci/mutants.json`](../ci/mutants.json)，共 27 条，与下表大体一致；"相减形式的速度 + f32 位置"在定点位置方案下无法用一行改出，换成了实现中真实踩过的 `fixed-point-floor`（`trunc` → `floor`）。

| 模块 | 变异 | 预期变红 |
|---|---|---|
| rng | Philox 轮数 10 → 9 | G04 |
| rng | 乘子 `0xD2511F53` 改动一位 | G04 |
| rng | `u >> 8` → `u >> 9` | G04、G05 |
| rng | seed 不进 key | G05（雪崩） |
| sampling | 第 b 次弹射复用 dim_block 0 | G05 / G11 |
| sampling | 样本序号不进计数器 | G11 |
| bsdf | 余弦采样改成均匀半球采样，但权重仍取 ρ | G10、G12 |
| bsdf | pdf 少除 π | G12 |
| integrator | 去掉光线起点偏移 | G08、G14 |
| integrator | 球内求交选错根 | G09 |
| integrator | 第一次命中不计自发光 | G09（D=0） |
| integrator | bounce 循环 `<` → `<=` | G09 |
| integrator | 去掉平行光线守卫 | G13 |
| canonical | `canonicalEntries` → `Object.keys` | G02 |
| canonical | JCS 数字格式化改用 `toFixed` | G02、G20 |
| accumulate | 先按 pass 求和再相加 | G03 |
| physics | dx 中 `dt²·g` → `dt·g` | G17 |
| physics | 速度改成相减形式 v = (x_new − x_old)/dt，并且位置用 f32 | G16 |
| io | PNG CRC 多项式改一位 | 单元测试（独立解码器） + G01 |
| patch | 不做深拷贝，原地应用 | G19 |
| parse | 去掉重复 key 检测 | G20 |
| semantic | 去掉 `E_PRECISION` | G20 |
| nan | 指数掩码 `0x7f800000` → `0x7f000000` | G15 |

### 3.10 CI 与自愈（P0 最小版）

所有 job 都在参考基底容器中执行：

1. **lint**：ESLint 规则（N1、N13）、WGSL grep 规则、MT1、MT5，以及 `src/` 中 TODO/FIXME 计数 = 0。
2. **unit**：严格解析器；JCS 对 RFC 8785 测试向量；patch 对 json-patch-tests；Philox 对 Random123 KAT；PNG 用独立解码器做往返校验。
3. **golden**：跑 20 个场景，与 `golden/p0/*/expected.sha256` 逐字节比较，并执行 oracle。
4. **determinism**：对 G01、G03、G16 执行 `--determinism-check`。
5. **perf**：MT3。
6. **mutation**：MT2，可以并行。

**失败时的产物**：失败的 scene.json、oracle 报告、差异热力图、首个分歧位置、日志、substrate 指纹。然后执行 `meme reduce`：按 ddmin（Zeller & Hildebrandt 2002, IEEE TSE 28(2)）依次缩减 (a) objects/materials 的实体 key，(b) 数值字段（截短位数、回到默认值），(c) 分辨率和 spp（减半）。判定条件是"同一个断言 id 仍然失败"，输出 `min_repro.scene.json` 和对应的 oracle 子集。整个缩减过程是确定的：候选顺序按 key 字节序，不用随机数。

### 3.11 P0 内的候选赛（机制 ①）

| 候选集 | 候选 | 评分基准 |
|---|---|---|
| C-RNG | Philox4x32-10 / Threefry2x32-20 / PCG4D | G04、G05；参考基底与 Metal 上的 ns/样本；代码行数 |
| C-Sphere | 朴素二次方程 / Ray Tracing Gems 第 7 章的稳健形式（Haines et al. 2019）/ 几何投影形式 | G13、G14；模糊测试失败率（流 4 随机生成尺度和方向） |
| C-Offset | 固定 ε / 按尺度的相对 ε / Ray Tracing Gems 第 6 章的整数 ulp 偏移（Wächter & Binder 2019） | G08、G14 上的自交率 |
| C-PNG | stored / 自写固定 Huffman / 固定版本 pako | 字节数、ms、代码行数、依赖数（三者都必须通过确定性检查） |
| C-Diff | ꟻLIP / SSIM / 最大 ΔE2000 | 对注入的 1 像素 bug 和微小偏差的检出率，对比同 spp 下纯 MC 噪声的误报率 |

每个候选集输出 `candidates/<set>/REPORT.md`：误差 / 方差 / ms / 鲁棒性（扰动输入后的失败率）/ 代码行数；保留 Pareto 前沿，其余归档并写明淘汰原因。

### 3.12 目录结构（确认后创建）

```
schema/       scene.schema.json
src/core/     parse, validate, semantic, canonical, hash, patch, migrate, rng
src/gpu/      device, substrate, fbh, allocator（字节计数）
src/kernels/  rng.wgsl, render_p0.wgsl, physics_p0.wgsl, probe_bsdf.wgsl, probe_fbh.wgsl
src/io/       png, pfm, jcs
src/oracle/   validators/{nan,furnace,energy}, stats, closed_forms, runner
src/tools/    determinism-check, reduce, golden, mutate
src/perf/     计时（唯一允许读墙钟的地方）
golden/p0/    <gid>/{scene.json, oracle.json, expected/}
candidates/
ci/           Dockerfile（参考基底）, mutants.json, workflow
docs/
```

---

## ④ 三个会让本设计失败的极端输入

1. **尺度差 10⁶**：r = 1e-3 m 和 r = 1e3 m 的球在同一场景里，距离 3e3 m。失败方式是自交（acne）和二次方程的灾难性抵消。
   **兜住了吗？** 设计上是：`E_PRECISION` 拒绝 f32 表示不了的组合（r ≥ 2⁻¹² · (\|c\| + r)）；C-Sphere / C-Offset 候选赛；相机相对坐标；G08 和 G14 用 max_bounces = 1 的白炉做精确的自交检测——任何一次自交都会让那个样本变成 0，误差至少 1/spp，远大于 τ。G14(d) 把一个球放在 `E_PRECISION` 的边界上：如果在边界上白炉失败，就收紧这条检查，而不是放宽容忍度。

2. **与平面完全平行的光线、恰好相切的球**：例如相机在 z = 0 平面上沿 +x 看（0/0），或者判别式恰好为 0。在 WGSL 里除零得到的不是 NaN，而是"不确定值"（§15.7.2），所以 NaN 扫描可能看不到这些垃圾值。
   **兜住了吗？** 是：显式守卫 \|dir·n\| < 2⁻²⁰ 判为未命中（已写进 schema 的描述）；判别式 < 0 判为未命中，= 0 取单根；CPU 按位扫描，再加能量上界——任何超过 B_c 的垃圾值都必然被抓到。对应 G13。

3. **f32 停滞（大坐标 / 大速度 + 小 dt）**，有两种：
   - **位置停滞**：\|dx\| < ulp(\|x\|)/2 时位置不再变化。例如 \|x\| = 1e4 m（ulp = 2⁻¹⁰ ≈ 9.8e-4 m）、dt = 1e-5 s 时，一个静止起步的物体要等速度超过 49 m/s 才开始移动。
   - **速度停滞**：\|g\|·dt < ulp(\|v\|)/2 时重力被舍入掉。例如 \|v\| = 1e4 m/s、dt = 1e-5 s 时，g·dt = 9.8e-5 < 4.9e-4。
   另外，Macklin 2016 Alg.1 原式 v = (x_new − x_old)/dt 在 \|x\| = 1e4、dt = 1e-5 时，速度误差约为 ulp(1e4)/dt ≈ 98 m/s。
   这些都是 f32 的可表示性极限，不是 bug；把容忍度放宽到能通过它们，正是被禁止的"用放大阈值代替修复"。
   **兜住了吗？** 按 D15-A 设计上是：位置用 i64 定点，消除位置停滞，同时让 Δx 精确；速度用 delta 形式 v = dx·(1/dt)，dx 是小量，不做大数相减（这一点偏离了 Macklin 2016 Alg.1 原文，理由即此）；速度停滞由 `E_PRECISION_DT` 在生成阶段拒绝（每步速度增量 ≥ 128 ulp(V)）。G16 同时包含"通过检查的极端情形"（用推导出的紧容忍度）和"被拒绝的极端情形"（放进 G20 的拒绝语料）。

**本阶段不涉及、已登记到后续阶段的极端输入**：质量 ≈ 0。P0 的无约束积分与质量无关，质量只进入能量报告；到 P2 有接触时 inv_mass = 1e6 才是风险，届时用 compliance 下限兜住。粗糙度 = 0、光源贴面：P0 没有 GGX，也没有面光源采样，这两条列入 P1 设计。

---

## ⑤ 验收布尔清单

**P0-01（本步，设计）**
- [ ] `scene.schema.json` 是合法 JSON，能在 ajv 2020-12 strict 模式下编译（`x-*` 已注册）
- [ ] MT1 schema lint 的违规数 = 0
- [ ] 20 条 golden 每条都有：断言数学式、容忍度、容忍度来源、能杀死的变异
- [ ] D1–D15 已由你选定

**P0 整体（实现后判定）**
- [ ] ∀ golden g：sha256(本地参考基底, g) = sha256(CI, g)，所有输出文件
- [ ] ∀ golden g：oracle(g) = pass
- [ ] `--determinism-check` 在 G01、G03、G16 上退出码 = 0
- [ ] ∀ 精选变异 m：∃ golden 变红
- [ ] G15 的所有负对照按预期变红
- [ ] MT1 违规数 = 0；`thresholds.lock` 未变，或附带了 ADR
- [ ] G01 在参考基底上的性能基线（ms/frame、gpu_bytes_peak）已记录
- [ ] golden 数量 ≥ 20
- [ ] `src/` 中 TODO/FIXME 数量 = 0

---

## ⑥ 新增黄金场景与指标

见 [`golden/p0/MANIFEST.md`](../golden/p0/MANIFEST.md)。指标：每个场景的 `manifest.deterministic`（输出哈希、图像统计、能量序列、工作量计数器、校验器结果）+ `manifest.perf`。
