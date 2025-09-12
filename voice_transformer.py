#!/usr/bin/env python3
"""
Voice Transformer - Tom Cat-like voice transformation using Whisper TTS
汤姆猫语音变换器 - 使用Whisper TTS引擎实现语音变换功能
"""

import whisper
import pyaudio
import wave
import numpy as np
import pyttsx3
import os
import tempfile
from pydub import AudioSegment
from pydub.effects import speedup, pitch
from scipy.signal import butter, lfilter
import threading
import time

class VoiceTransformer:
    def __init__(self):
        """初始化语音变换器"""
        self.whisper_model = None
        self.tts_engine = None
        self.current_mode = "normal"
        self.voice_modes = {
            "normal": {"name": "普通模式", "pitch_shift": 0, "speed": 1.0, "filter_freq": None},
            "tomcat": {"name": "汤姆猫", "pitch_shift": 5, "speed": 1.2, "filter_freq": 3000},
            "baldstrong": {"name": "光头强", "pitch_shift": -3, "speed": 0.9, "filter_freq": 2000},
            "child": {"name": "小孩", "pitch_shift": 7, "speed": 1.3, "filter_freq": 4000},
            "robot": {"name": "机器人", "pitch_shift": -5, "speed": 0.8, "filter_freq": 1500}
        }
        self.setup_models()
    
    def setup_models(self):
        """设置语音识别和TTS模型"""
        print("正在加载Whisper模型...")
        try:
            self.whisper_model = whisper.load_model("base")
            print("Whisper模型加载成功！")
        except Exception as e:
            print(f"Whisper模型加载失败: {e}")
            return False
        
        print("正在初始化TTS引擎...")
        try:
            self.tts_engine = pyttsx3.init()
            # 设置语音参数
            self.tts_engine.setProperty('rate', 150)  # 语速
            self.tts_engine.setProperty('volume', 0.9)  # 音量
            print("TTS引擎初始化成功！")
        except Exception as e:
            print(f"TTS引擎初始化失败: {e}")
            return False
        
        return True
    
    def record_audio(self, duration=5, sample_rate=16000):
        """录制音频"""
        chunk = 1024
        format = pyaudio.paInt16
        channels = 1
        
        print(f"开始录音，持续{duration}秒...")
        print("请说话...")
        
        p = pyaudio.PyAudio()
        
        try:
            stream = p.open(format=format,
                          channels=channels,
                          rate=sample_rate,
                          input=True,
                          frames_per_buffer=chunk)
            
            frames = []
            for i in range(0, int(sample_rate / chunk * duration)):
                data = stream.read(chunk)
                frames.append(data)
            
            stream.stop_stream()
            stream.close()
            p.terminate()
            
            print("录音完成！")
            
            # 保存为临时wav文件
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
            wf = wave.open(temp_file.name, 'wb')
            wf.setnchannels(channels)
            wf.setsampwidth(p.get_sample_size(format))
            wf.setframerate(sample_rate)
            wf.writeframes(b''.join(frames))
            wf.close()
            
            return temp_file.name
        
        except Exception as e:
            print(f"录音失败: {e}")
            p.terminate()
            return None
    
    def transcribe_audio(self, audio_file):
        """使用Whisper转录音频"""
        try:
            print("正在识别语音...")
            result = self.whisper_model.transcribe(audio_file, language="zh")
            text = result["text"].strip()
            print(f"识别结果: {text}")
            return text
        except Exception as e:
            print(f"语音识别失败: {e}")
            return None
    
    def apply_voice_effects(self, audio_segment, mode_config):
        """应用语音效果"""
        try:
            # 音调变化
            if mode_config["pitch_shift"] != 0:
                # 简单的音调变化实现
                new_sample_rate = int(audio_segment.frame_rate * (1 + mode_config["pitch_shift"] * 0.1))
                audio_segment = audio_segment._spawn(audio_segment.raw_data, 
                                                   overrides={"frame_rate": new_sample_rate})
                audio_segment = audio_segment.set_frame_rate(audio_segment.frame_rate)
            
            # 速度变化
            if mode_config["speed"] != 1.0:
                audio_segment = speedup(audio_segment, playback_speed=mode_config["speed"])
            
            return audio_segment
        except Exception as e:
            print(f"音效处理失败: {e}")
            return audio_segment
    
    def text_to_speech(self, text, mode="normal"):
        """文本转语音并应用效果"""
        try:
            mode_config = self.voice_modes.get(mode, self.voice_modes["normal"])
            
            # 生成基础语音
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
            self.tts_engine.save_to_file(text, temp_file.name)
            self.tts_engine.runAndWait()
            
            # 加载音频并应用效果
            audio = AudioSegment.from_wav(temp_file.name)
            processed_audio = self.apply_voice_effects(audio, mode_config)
            
            # 保存处理后的音频
            output_file = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
            processed_audio.export(output_file.name, format="wav")
            
            # 清理临时文件
            os.unlink(temp_file.name)
            
            return output_file.name
        except Exception as e:
            print(f"语音合成失败: {e}")
            return None
    
    def play_audio(self, audio_file):
        """播放音频文件"""
        try:
            from playsound import playsound
            playsound(audio_file)
        except Exception as e:
            print(f"音频播放失败: {e}")
    
    def set_voice_mode(self, mode):
        """设置语音模式"""
        if mode in self.voice_modes:
            self.current_mode = mode
            mode_name = self.voice_modes[mode]["name"]
            print(f"语音模式已切换为: {mode_name}")
            
            # 语音播报模式切换
            announcement = f"记住当前语音模式为{mode_name}"
            print(announcement)
            
            # 用当前模式播报
            audio_file = self.text_to_speech(announcement, mode)
            if audio_file:
                self.play_audio(audio_file)
                os.unlink(audio_file)
        else:
            print(f"未知的语音模式: {mode}")
    
    def list_voice_modes(self):
        """列出所有可用的语音模式"""
        print("\n可用的语音模式:")
        for key, config in self.voice_modes.items():
            current = " (当前)" if key == self.current_mode else ""
            print(f"  {key}: {config['name']}{current}")
        print()
    
    def transform_voice(self, duration=5):
        """完整的语音变换流程"""
        try:
            # 1. 录制音频
            audio_file = self.record_audio(duration)
            if not audio_file:
                return False
            
            # 2. 语音识别
            text = self.transcribe_audio(audio_file)
            if not text:
                os.unlink(audio_file)
                return False
            
            # 3. 语音合成和变换
            output_file = self.text_to_speech(text, self.current_mode)
            if not output_file:
                os.unlink(audio_file)
                return False
            
            # 4. 播放结果
            print(f"正在使用{self.voice_modes[self.current_mode]['name']}模式播放...")
            self.play_audio(output_file)
            
            # 清理临时文件
            os.unlink(audio_file)
            os.unlink(output_file)
            
            return True
        
        except Exception as e:
            print(f"语音变换失败: {e}")
            return False

def main():
    """主函数"""
    print("=" * 50)
    print("🎭 汤姆猫语音变换器")
    print("Tom Cat Voice Transformer")
    print("=" * 50)
    
    transformer = VoiceTransformer()
    
    if not transformer.whisper_model or not transformer.tts_engine:
        print("初始化失败，程序退出")
        return
    
    print("\n使用说明:")
    print("1. 输入 'record' 或 'r' - 开始录音并变换语音")
    print("2. 输入 'mode <模式名>' - 切换语音模式")
    print("3. 输入 'list' 或 'l' - 显示所有语音模式")
    print("4. 输入 'quit' 或 'q' - 退出程序")
    print()
    
    transformer.list_voice_modes()
    
    while True:
        try:
            command = input("请输入命令 > ").strip().lower()
            
            if command in ['quit', 'q', 'exit']:
                print("再见！")
                break
            
            elif command in ['record', 'r']:
                print("\n开始语音变换...")
                transformer.transform_voice()
                print("语音变换完成！\n")
            
            elif command in ['list', 'l']:
                transformer.list_voice_modes()
            
            elif command.startswith('mode '):
                mode = command[5:].strip()
                transformer.set_voice_mode(mode)
            
            elif command == 'help' or command == 'h':
                print("\n可用命令:")
                print("  record/r - 录音并变换")
                print("  mode <模式> - 切换模式")
                print("  list/l - 列出模式")
                print("  quit/q - 退出")
                print()
            
            else:
                print("未知命令，输入 'help' 查看帮助")
        
        except KeyboardInterrupt:
            print("\n\n程序被用户中断")
            break
        except Exception as e:
            print(f"发生错误: {e}")

if __name__ == "__main__":
    main()