#!/bin/bash

# 安装系统依赖
echo "安装系统依赖..."
sudo apt-get update
sudo apt-get install -y portaudio19-dev python3-pyaudio ffmpeg

# 安装Python依赖
echo "安装Python依赖..."
pip install -r requirements.txt

echo "安装完成！"
echo "运行程序: python3 voice_transformer.py"