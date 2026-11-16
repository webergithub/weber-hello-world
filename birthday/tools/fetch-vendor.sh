#!/bin/sh
# 把摄像头识别用到的库和模型下载到 vendor/，这样网站可以完全离线运行（约 30 MB）。
# Downloads the vision library and models into vendor/ so the site runs with no internet (about 30 MB).
# 用法 Usage:  sh tools/fetch-vendor.sh    然后把 js/config.js 里的 camera.local 改成 true
set -e
cd "$(dirname "$0")/.."
mkdir -p vendor/tasks-vision vendor/models vendor/.tmp
( cd vendor/.tmp && npm pack @mediapipe/tasks-vision@0.10.14 --silent && tar xzf mediapipe-tasks-vision-0.10.14.tgz )
cp vendor/.tmp/package/vision_bundle.mjs vendor/tasks-vision/
cp -r vendor/.tmp/package/wasm vendor/tasks-vision/
rm -rf vendor/.tmp
curl -fL -o vendor/models/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
curl -fL -o vendor/models/gesture_recognizer.task https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task
echo "完成 Done → vendor/"
