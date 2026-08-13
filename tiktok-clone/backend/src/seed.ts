import db from './db'
import { v4 as uuidv4 } from 'uuid'

// Public domain / freely usable sample videos
const SAMPLE_VIDEOS = [
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    cover: 'https://picsum.photos/seed/v1/400/700',
    title: '大兔子的日常冒险 🐰',
    author_name: 'BunnyLover',
    tags: ['动画', '可爱', '兔子'],
    duration: 60,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    cover: 'https://picsum.photos/seed/v2/400/700',
    title: '大象的梦境世界 🐘',
    author_name: 'DreamMaker',
    tags: ['艺术', '动画', '梦境'],
    duration: 45,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    cover: 'https://picsum.photos/seed/v3/400/700',
    title: '极速燃烧时刻 🔥',
    author_name: 'SpeedKing',
    tags: ['极限', '速度', '刺激'],
    duration: 15,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    cover: 'https://picsum.photos/seed/v4/400/700',
    title: '说走就走的旅行 ✈️',
    author_name: 'TravelVlog',
    tags: ['旅行', '风景', '生活'],
    duration: 20,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    cover: 'https://picsum.photos/seed/v5/400/700',
    title: '开心每一天 😄',
    author_name: 'HappyDays',
    tags: ['搞笑', '生活', '欢乐'],
    duration: 18,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    cover: 'https://picsum.photos/seed/v6/400/700',
    title: '激情兜风去 🚗',
    author_name: 'CarFreak',
    tags: ['汽车', '驾驶', '自由'],
    duration: 22,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
    cover: 'https://picsum.photos/seed/v7/400/700',
    title: '超燃特效大合集 💥',
    author_name: 'EffectMaster',
    tags: ['特效', '视觉', '震撼'],
    duration: 16,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    cover: 'https://picsum.photos/seed/v8/400/700',
    title: 'Sintel 史诗奇幻 ⚔️',
    author_name: 'EpicFilms',
    tags: ['奇幻', '史诗', '动画'],
    duration: 55,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
    cover: 'https://picsum.photos/seed/v9/400/700',
    title: '越野神车实测 🏔️',
    author_name: 'OffRoadPro',
    tags: ['越野', '汽车', '探险'],
    duration: 25,
  },
  {
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    cover: 'https://picsum.photos/seed/v10/400/700',
    title: '钢铁之泪 科幻短片 🤖',
    author_name: 'SciFiStudio',
    tags: ['科幻', '未来', '机器人'],
    duration: 50,
  },
]

function seed() {
  const existing = (db.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c
  if (existing > 0) { console.log('Already seeded'); return }

  const insert = db.prepare(`
    INSERT INTO videos (id, url, cover, title, author_id, author_name, author_avatar, tags, duration, likes, comments, shares)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const v of SAMPLE_VIDEOS) {
    const authorId = 'author_' + v.author_name.toLowerCase().replace(/\s+/g, '_')
    insert.run(
      uuidv4(), v.url, v.cover, v.title,
      authorId, v.author_name,
      `https://i.pravatar.cc/80?u=${authorId}`,
      JSON.stringify(v.tags), v.duration,
      Math.floor(Math.random() * 50000),
      Math.floor(Math.random() * 2000),
      Math.floor(Math.random() * 500),
    )
  }
  console.log(`Seeded ${SAMPLE_VIDEOS.length} videos`)
}

seed()
