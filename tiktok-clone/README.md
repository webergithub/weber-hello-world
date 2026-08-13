# TikTok Clone — MVP 骨架

短视频 App 完整骨架：竖屏 Feed + 行为埋点 + 推荐算法服务。

## 架构

```
frontend/      React + Vite  竖屏视频Feed，触摸/滚轮翻页
backend/       Node.js + Express + SQLite  视频元数据、Feed API、行为事件
recommender/   Python FastAPI  完播率加权打分 + UserCF 推荐
```

## 快速启动（开发模式）

```bash
# 1. 后端
cd backend && npm install && npm run seed && npm run dev

# 2. 推荐服务
cd recommender && pip install -r requirements.txt && uvicorn main:app --reload --port 8000

# 3. 前端
cd frontend && npm install && npm run dev
# → http://localhost:5174
```

## Docker 一键启动

```bash
docker-compose up --build
# → http://localhost:5174
```

## 推荐算法说明

### 当前（Phase 1）：规则打分
```
score = 完播率 × 0.4 + 点赞率 × 0.3 + 流行度(log) × 0.2 + 标签偏好 × 0.1
```
- 冷启动：新用户看热门内容；新视频给 0.5 基础分
- 未看过的视频优先于已看过的

### Phase 2（待实现）：双塔召回
- 用 EasyRec 训练 Two-Tower 模型
- FAISS 向量检索替换当前全量打分
- 用户向量实时更新到 Redis

## API 文档

| 接口 | 说明 |
|---|---|
| `GET /api/feed?userId=&page=&limit=` | 获取推荐 Feed |
| `GET /api/videos` | 全量视频列表 |
| `POST /api/events` | 上报行为（watch/like/share/comment/skip） |
| `POST /api/videos/:id/like` | 点赞 |
| `GET /api/health` | 健康检查 |
| `POST http://localhost:8000/rank` | 推荐服务打分排序 |
| `POST http://localhost:8000/event` | 推荐服务行为上报 |

## 下一步演进

- [ ] 用户登录 / JWT 鉴权
- [ ] 视频上传（FFmpeg 转码 + OSS 存储）
- [ ] 评论系统
- [ ] 关注 / 粉丝
- [ ] EasyRec 双塔模型接入
- [ ] Milvus 向量检索
- [ ] Kafka 实时行为流
