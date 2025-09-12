# weber-hello-world

## 🎭 汤姆猫语音变换器 (Tom Cat Voice Transformer)

基于OpenAI Whisper和TTS引擎的语音变换应用，实现类似汤姆猫的语音变换功能。

### 主要功能

1. **语音输入** - 支持实时录音和语音识别
2. **语音变换** - 多种角色声音模式：
   - 汤姆猫 (Tom Cat) - 高音调可爱声音
   - 光头强 (Bald Strong) - 低音调憨厚声音
   - 小孩 (Child) - 超高音调童声
   - 机器人 (Robot) - 低音调机械声
   - 普通 (Normal) - 原始语音
3. **语音输出** - TTS合成和音效处理
4. **模式管理** - 动态切换和语音播报："记住当前语音模式为xxx"

### 快速开始

#### 运行演示版 (推荐)
```bash
python3 voice_transformer_demo.py
```

#### 运行完整版 (需要额外依赖)
```bash
# 安装依赖
sudo apt-get install portaudio19-dev python3-pyaudio ffmpeg espeak
pip install -r requirements.txt

# 运行程序
python3 voice_transformer.py
```

#### 运行测试
```bash
python3 test_voice_transformer.py
```

### 使用说明

程序启动后可使用以下命令：
- `demo` 或 `d` - 开始语音变换演示
- `mode <模式名>` - 切换语音模式 (tomcat, baldstrong, child, robot, normal)
- `list` 或 `l` - 显示所有可用模式
- `test` 或 `t` - 测试所有模式 (仅演示版)
- `quit` 或 `q` - 退出程序

### 技术特性

- 🎤 实时音频录制和处理
- 🤖 OpenAI Whisper语音识别
- 🔊 文本转语音合成
- 🎵 实时音调和语速调整
- 🎛️ 音频滤波和效果处理
- 🌐 中文语音识别支持

详细文档请参考 [README_VOICE.md](README_VOICE.md)

tiantianchijiu
