# CityTwin · 照片级真实3D城市原型（里程碑1）

用 Google **Photorealistic 3D Tiles**（和 Google Earth 同源的真实3D城市）做底图，
先验证「真实城市能加载 + 漫游」。技术栈：three 0.185 + 3d-tiles-renderer 0.5（已打包进 `citytwin3d.bundle.js`，无需联网装依赖）。

## 前置：Google Maps API key（免费额度足够）

1. https://console.cloud.google.com/ 新建项目；
2. APIs & Services → Library → 启用 **Map Tiles API**；
3. Credentials → 创建 API key。

## 运行（必须用 http(s)，不能 file:// 直接双击）

Google 3D Tiles 走 fetch，file:// 会被 CORS 挡。任选其一：

```bash
# 本地起服务
cd photoreal && python3 -m http.server 8090   # → http://localhost:8090
```

或部署到你服务器（如 /home/ubuntu/website/citytwin-3d/），浏览器打开后：
填入 key → 选城市 → 「加载真实3D城市」→ 滚轮拉近到街道。

## 说明

- key 只存本地浏览器 localStorage，不上传；
- 这是**里程碑1**：只做真实底图加载 + 鼠标漫游。跑通后再叠加藏猫猫玩法（角色行走、藏点、交通等）。
