# DSH Water — Unity 内置管线 Cg 水面 Shader

面向 Unity **Built-in Render Pipeline（默认管线）** 的水面 Shader，使用 Cg/HLSL 编写。
目标效果是一张“低机位、阴天浓雾、城市运河”的参考图：平静但布满细碎风纹的水面、
被波纹拉长的建筑与桥梁倒影、暖色灯光反射，以及画面中央破碎的太阳高光带。

> 说明：本目录不是完整 Unity 工程，而是一个可直接复制进项目的 `Assets/Water` 资源包。
> 预览图来自 `preview/` 中的 WebGL2 算法移植（与 Cg 使用同一套波浪/反射/雾数学），
> **不是 Unity Editor 截图**；当前执行环境没有安装 Unity，详见最后的“验证与限制”。

---

## 1. 参考图里的水：先观察，再实现

| 观察点 | 参考图中的表现 | Shader 对应实现 |
| --- | --- | --- |
| 水体类型 | 城市运河，深水，不透明；没有海浪、白沫、岸边泡沫 | 深水底色 + 散射色，不做折射/泡沫 |
| 颜色 | 近处深橄榄绿/灰绿；远处被暖灰雾吞没 | `_DeepColor`、`_ScatterColor` + Unity 场景雾 |
| 波纹 | 长而细的风纹（沿风向拉长），叠加上厘米级毛细波；没有大浪 | 5 组长波 + 3 组细节波 + 各向异性 value noise；振幅约 5–16 cm |
| 反射 | 建筑、桥、灯柱在垂直方向被拉长；反射被波纹切碎；桥和灯是暖色 | 平面反射相机 + 屏幕空间采样 + 法线扰动 + 距离 mip 模糊 |
| 菲涅尔 | 近处看穿水面（暗），越接近地平线越像镜子（亮） | Schlick 菲涅尔，F0 = 0.04，掠射角反射增强 |
| 太阳高光 | 画面中央偏下有一条破碎的暖白/金色高光带，被雾柔化 | 宽高光 + 窄 sparkle + 噪声遮罩；配合后处理 Bloom 更接近参考 |
| 雾 | 很重的暖灰雾，水面和建筑在远处一起化掉 | 直接使用 Unity 的 `UNITY_APPLY_FOG`，与场景雾自动一致 |
| 灯光 | 桥灯和窗户的橙色反光在水面拉成长条 | 平面反射渲染发光体 + 反射模糊/扰动 |

参考图是 1920×1009、低机位、约 50–60° FOV。Shader 本身不绑定场景，以上是调参依据。

---

## 2. 目录结构

```text
unity-water-shader/
├── Assets/
│   └── Water/
│       ├── Shaders/
│       │   └── DSHWater.shader          # 主 Shader（Cg，内置管线，ForwardBase）
│       ├── Scripts/
│       │   └── PlanarReflection.cs      # 镜像反射相机 + 斜裁剪 + mip RT
│       └── Editor/
│           └── WaterDemoBuilder.cs      # Tools > DSH Water > Create Demo Scene
├── preview/
│   ├── index.html                       # WebGL2 算法预览（验证用，不是 Unity）
│   └── preview.js                       # 同一套水波/反射/雾公式的 GLSL 移植
├── docs/images/
│   ├── water-before.jpg                 # Before：同场景平板水面，无 Shader
│   ├── water-after.jpg                  # After：应用本 Shader 的算法预览
│   └── water-detail.jpg                 # 水面细节裁切
└── README.md
```

---

## 3. 快速使用

### 3.1 复制资源

把 `Assets/Water` 整个目录复制到你的 Unity 工程 `Assets/` 下。建议：

- Unity **2019.4 LTS 或更高**；
- **Built-in Render Pipeline**（不是 URP/HDRP）；
- 线性色彩空间（Linear）更接近参考图；Gamma 也可以，颜色需要自行微调。

### 3.2 创建水面

1. 新建一个 **Plane**（或任意水平网格），放在场景中，Y 轴朝上；
2. 新建 Material，Shader 选择 **DSH/Water**；
3. 把 Material 赋给水面 Renderer；
4. 把水面 GameObject 的 Layer 设为 **Water（第 4 层）**；
5. 给水面 GameObject 添加 **PlanarReflection** 组件；
6. 场景 Lighting 中开启 **Fog**（建议 Exponential Squared，密度约 `0.012–0.018`，颜色偏暖灰）；
7. 场景中放一盏 **Directional Light** 作为太阳。

> 反射脚本会自动把 Water 层从反射相机中排除，所以水面不会自己反射自己。
> 水面需要保持水平（`transform.up` 朝上）；当前脚本针对水平镜面做了相机翻转，倾斜水面不保证正确。

### 3.3 一键生成参考氛围的 Demo 场景

菜单：**Tools > DSH Water > Create Demo Scene**

会创建 `Assets/Water/Demo/WaterDemo.unity`，包含：

- 暖灰雾 + Procedural Skybox + 低角度太阳；
- 运河两岸的块状建筑、桥、桥墩、灯柱、暖色窗户；
- 使用 `DSH/Water` + `PlanarReflection` 的水面；
- 与预览图一致的相机机位和色调。

> 会新建场景并覆盖 `Assets/Water/Demo/WaterDemo.unity`；当前场景的未保存修改会先弹出保存提示。

### 3.4 可选：Bloom

参考图的高光有明显柔光。建议使用 Unity 后处理 Bloom（Post Processing Stack v2 或自建），
阈值放在 1.0 左右，强度 0.3–0.8。Shader 自身不包含 Bloom，避免绑定特定后处理方案。

---

## 4. 实现要点

### 4.1 程序化波浪

不依赖法线贴图，完全在 Shader 内生成，方便直接复制使用。

- **基础层**：5 组方向性正弦波，波长从约 11 m 到 1 m，振幅由 `_WaveHeight` 统一缩放；
- **风纹层**：`ValueNoise` 在“沿风向拉长、垂直风向压缩”的 UV 上采样，形成参考图里长条状的纹理；
- **细节层**：3 组短波（波长约 0.6–0.2 m）+ 高频 `ValueNoise`，只用于太阳高光，不参与反射扰动；
- **解析法线**：方向波直接对相位求导累加 `dh/dp`，避免对每组波做有限差分；
  `ValueNoise` 部分用 3 次采样近似梯度；
- **抗闪烁**：按距离和屏幕像素足迹（`fwidth`/`dFdx`）衰减高频细节，并在 260 m 内逐渐压平法线。

把“反射法线”和“高光法线”分开，是这张参考图的关键：

- 反射法线只包含长波和风纹 → 倒影保持可读、不会被碎成噪点；
- 高光法线叠加毛细波 → 太阳高光形成细碎的金色闪光，而不是一整块镜面。

### 4.2 平面反射

`PlanarReflection.cs`：

1. 以水面平面为镜面，计算反射矩阵，把主相机的 view 矩阵镜像；
2. 用 `Camera.CalculateObliqueMatrix` 做斜近裁剪，避免水下几何穿到反射里；
3. 渲染到带 mipmap 的 `RenderTexture`（默认 0.75 屏幕分辨率，可调）；
4. Shader 用屏幕 UV 采样，按法线扰动 UV，并按距离提高 mip 级别实现“远处反射更糊”。

`GL.invertCulling` 用于修正镜像后的三角形绕序。

### 4.3 菲涅尔、水色与太阳高光

- Schlick 菲涅尔：`F = F0 + (1-F0)(1-N·V)^5`，掠射角反射接近 1；
- 水色 = 深水色与散射色按视角混合，再乘一个很弱的太阳漫反射；
- 高光 = 宽高光（power 42）+ 窄 sparkle（power 120，可调）+ 噪声遮罩；
- 最后叠加 Unity 场景雾，使水面和建筑在远处自然融合。

### 4.4 雾

使用 `#pragma multi_compile_fog` / `UNITY_TRANSFER_FOG` / `UNITY_APPLY_FOG`。
这样水面的雾色、密度和模式完全跟随 Lighting 面板，不需要在材质上重复配置；
反射相机渲染时也会带上同样的雾，因此水面会得到“物体→水面”和“水面→眼睛”两段雾，
远处倒影会自然变淡。

---

## 5. 主要参数

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `_DeepColor` | `#1B2620` | 深水底色（近处、垂直视角） |
| `_ScatterColor` | `#2E3A2E` | 散射/浑浊色 |
| `_ReflectionTint` | `#D2CDC0` | 倒影色调（偏暖灰） |
| `_ReflectionStrength` | 1.0 | 反射总强度 |
| `_ReflectionDistortion` | 0.20 | 法线对屏幕 UV 的扰动强度；越大倒影越碎 |
| `_ReflectionBlur` | 2.4 | 远处反射的 mip 模糊 |
| `_FresnelBias` / `_FresnelPower` | 0.04 / 5 | 菲涅尔 F0 与曲线 |
| `_WaveHeight` | 0.16 | 波高（米）；参考图约 5–16 cm |
| `_WaveScale` | 1.0 | 波长缩放；越大波纹越密 |
| `_WaveSpeed` | 0.80 | 动画速度 |
| `_NormalStrength` | 0.90 | 法线强度（影响反射扰动） |
| `_WindDirection` | `(0.85, 0, 0.5)` | 风向（XZ） |
| `_SpecularIntensity` | 1.20 | 宽高光强度 |
| `_SparkleIntensity` / `_SparklePower` | 2.60 / 120 | 细碎太阳闪光强度/锐度 |
| `_SpecularColor` | `#FFE6B8` | 高光颜色（暖白） |

调参建议：

- 想更“镜面”：提高 `_ReflectionStrength`、降低 `_ReflectionDistortion` 和 `_ReflectionBlur`；
- 想更“粗糙/有风”：提高 `_WaveHeight`、`_NormalStrength`、`_ReflectionDistortion`；
- 想更“油/浑浊”：提高 `_ScatterColor` 和 `_ScatterStrength`；
- 太阳高光太散：降低 `_SpecularIntensity`，提高 `_SparklePower`；反之亦然。

---

## 6. 预览（WebGL2，仅用于验证）

`preview/` 是一个零依赖的 WebGL2 页面，把 Cg 里的波浪、反射采样、菲涅尔、
太阳高光和距离雾逐行移植到 GLSL，用来在没有 Unity 的环境里检查观感。

运行：

```bash
cd unity-water-shader/preview
python3 -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/
```

- `?mode=after`：应用水面 Shader（默认）；
- `?mode=before`：同一场景，平板深色水面（对照组，无反射/波浪）；
- `?capture=1`：隐藏 UI，便于截图。

`docs/images/water-before.jpg` 与 `water-after.jpg` 是同一相机、同一场景、
同一固定时间（12 s）下用无头 Chromium 抓取的对比图；`water-detail.jpg` 是后者的水面细节裁切。

> 预览页面只是**算法可读性验证**，不是 Unity 运行时。它没有使用 Unity 的
> 光照/后处理链，因此颜色与 Unity 实际结果会有差异；以 `Assets/Water` 为准。

---

## 7. 验证与限制（请务必读）

已做：

- Cg Shader 与 C# 脚本逐行静态检查（无 Unity 环境，见下）；
- WebGL2 移植版本的编译与渲染验证（Chrome + SwiftShader，1280×673）；
- Before/After 同参数对比图；
- 反射方向、UV 对齐、雾叠加方式在预览中按与 Unity 相同的数学实现。

未做 / 限制：

- **当前执行环境没有安装 Unity，无法在 Unity Editor 中实际编译/渲染/截图**。
  因此 `DSHWater.shader` 和 `PlanarReflection.cs` 仍需在 Unity 2019.4+/2021.3+ 中导入确认；
  如果出现平台相关的编译或渲染差异，以实际 Unity 结果为准调参。
- 仅支持 **Built-in Render Pipeline**；URP/HDRP 需要改写 Renderer Feature/Shader Graph。
- 仅支持**水平**水面；倾斜水面需要替换反射脚本中的欧拉角翻转逻辑。
- 水面为不透明深水，不做折射、深度染色、岸边泡沫、白沫；参考图中这些特征也不明显。
- 多个不同高度的水面请各用一份材质 + 一个 `PlanarReflection`；共享材质时后渲染的反射会覆盖前者。
- 预览场景是风格化重建，不是参考图的原场景；参考图来自用户对话，未提交到仓库。

如果 Unity 中需要我继续修到“打开即用”，请把 Unity 版本和报错/截图发我，我可以按实际结果继续调。
