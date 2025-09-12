# 🎭 汤姆猫语音变换器 (Tom Cat Voice Transformer)

基于OpenAI Whisper和TTS引擎的语音变换应用，实现类似汤姆猫的语音变换功能。

## 功能特性

### 1. 语音输入
- 支持实时录音输入
- 使用OpenAI Whisper进行高精度语音识别
- 支持中文语音识别

### 2. 语音变换模式
- **汤姆猫模式**: 高音调、快语速的可爱声音
- **光头强模式**: 低音调、慢语速的憨厚声音  
- **小孩模式**: 超高音调、快语速的童声
- **机器人模式**: 低音调、慢语速的机械声音
- **普通模式**: 原始语音输出

### 3. 语音输出
- 文本转语音(TTS)合成
- 实时音效处理和变换
- 自动播放变换后的语音

### 4. 模式管理
- 动态切换语音模式
- 语音播报当前模式："记住当前语音模式为xxx"
- 列出所有可用模式

## 安装说明

### 系统要求
- Python 3.7+
- Linux/macOS/Windows
- 音频输入/输出设备

### 安装步骤

1. **安装系统依赖** (Linux)
```bash
sudo apt-get update
sudo apt-get install portaudio19-dev python3-pyaudio ffmpeg
```

2. **安装Python依赖**
```bash
pip install -r requirements.txt
```

或者使用提供的安装脚本:
```bash
./install.sh
```

### 依赖包说明
- `openai-whisper`: OpenAI语音识别模型
- `pyaudio`: 音频录制和播放
- `pydub`: 音频处理和格式转换
- `pyttsx3`: 文本转语音引擎
- `numpy`, `scipy`: 数值计算和信号处理

## 使用方法

### 启动程序
```bash
python3 voice_transformer.py
```

### 交互命令
- `record` 或 `r`: 开始录音并进行语音变换
- `mode <模式名>`: 切换语音模式
  - 可用模式: `normal`, `tomcat`, `baldstrong`, `child`, `robot`
- `list` 或 `l`: 显示所有可用的语音模式
- `help` 或 `h`: 显示帮助信息
- `quit` 或 `q`: 退出程序

### 使用示例
```
请输入命令 > mode tomcat
语音模式已切换为: 汤姆猫
记住当前语音模式为汤姆猫

请输入命令 > record
开始录音，持续5秒...
请说话...
录音完成！
正在识别语音...
识别结果: 你好，我是汤姆猫
正在使用汤姆猫模式播放...
语音变换完成！
```

## 技术实现

### 核心组件
1. **语音录制**: 使用PyAudio实现实时音频录制
2. **语音识别**: 集成OpenAI Whisper模型进行语音转文本
3. **语音合成**: 使用pyttsx3进行文本转语音
4. **音效处理**: 通过调整音调、语速和滤波实现不同角色声音

### 语音变换原理
- **音调变化**: 通过调整音频采样率实现音调升降
- **语速控制**: 使用pydub的speedup功能调整播放速度
- **滤波效果**: 应用不同频率的滤波器模拟不同音色

### 文件结构
```
weber-hello-world/
├── voice_transformer.py    # 主程序文件
├── requirements.txt        # Python依赖
├── install.sh             # 安装脚本
├── README_VOICE.md        # 语音变换器说明文档
└── README.md              # 项目主文档
```

## 开发扩展

### 添加新的语音模式
在`voice_modes`字典中添加新模式:
```python
"newmode": {
    "name": "新模式名称", 
    "pitch_shift": 音调偏移(-10到10), 
    "speed": 语速倍数(0.5到2.0), 
    "filter_freq": 滤波频率
}
```

### 自定义音效处理
修改`apply_voice_effects`方法来实现更复杂的音频处理效果。

## 注意事项

1. **首次运行**: Whisper模型会自动下载，需要网络连接
2. **音频设备**: 确保系统有可用的麦克风和扬声器
3. **权限问题**: 某些系统可能需要音频设备访问权限
4. **性能要求**: 语音识别和处理需要一定的计算资源

## 故障排除

### 常见问题
1. **PyAudio安装失败**: 安装portaudio开发包
2. **没有音频设备**: 检查系统音频设置
3. **Whisper加载缓慢**: 首次下载模型需要时间
4. **语音播放失败**: 检查音频输出设备

## 许可证

MIT License - 欢迎贡献和改进！