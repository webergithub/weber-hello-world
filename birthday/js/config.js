/* 十岁啦 · 设置 Settings — 改这里不需要懂代码，改完刷新网页即可。 */
window.TENUP_CONFIG = {
  /* 没在照片管理页填名字时用的称呼 */
  name: { zh: '小寿星', en: 'Birthday Girl' },

  /* 观看模式的节奏（毫秒） */
  watch: { photoMs: 4500, chapterMs: 12000 },

  /* 互动模式：用打开网页的这台电脑的摄像头，画面只在本机识别，不上传。 */
  camera: {
    /* 识别库和模型默认从网上加载。要完全离线：运行 tools/fetch-vendor.sh，然后把 local 改成 true。 */
    local: false,
    lib: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
    faceModel: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    handModel: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
    localLib: 'vendor/tasks-vision',
    localFaceModel: 'vendor/models/face_landmarker.task',
    localHandModel: 'vendor/models/gesture_recognizer.task',

    intervalMs: 110,   /* 多久识别一次 */
    holdMs: 800,       /* 动作要保持多久才算数，避免误触发 */
    cooldownMs: 4000,  /* 同一个动作触发后休息多久 */

    /* 每个动作的灵敏度，0–1，数字越小越容易触发。网址后面加 ?debug=1 可以看到实时分数来调。 */
    thresholds: { smile: 0.5, cry: 0.45, blow: 0.5, heart: 0.6, palms: 0.6, fist: 0.6, arms: 0.6 },

    /* 挥手翻页：一只手在 windowMs 毫秒内横向移动超过画面宽度的 distance 才算一次。
       孩子的手从她的右边挥到左边 = 下一张；反方向 = 上一张。想反过来就把 invert 改成 true。 */
    swipe: { distance: 0.22, windowMs: 600, cooldownMs: 1000, invert: false }
  }
};
