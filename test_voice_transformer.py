#!/usr/bin/env python3
"""
Test script for Voice Transformer
测试语音变换器功能的脚本
"""

import sys
import os

# Add the current directory to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_voice_transformer_demo():
    """测试演示版语音变换器"""
    print("测试语音变换器演示版...")
    
    try:
        from voice_transformer_demo import VoiceTransformerDemo
        
        # 创建变换器实例
        transformer = VoiceTransformerDemo()
        
        print("✅ 成功导入和初始化VoiceTransformerDemo")
        
        # 测试模式列表
        print("\n测试语音模式列表:")
        transformer.list_voice_modes()
        
        # 测试模式切换
        print("\n测试模式切换:")
        for mode in ['tomcat', 'baldstrong', 'child', 'robot', 'normal']:
            print(f"\n切换到 {mode} 模式:")
            transformer.set_voice_mode(mode)
            
            # 测试语音变换
            print(f"测试 {mode} 模式的语音变换:")
            success = transformer.transform_voice()
            if success:
                print(f"✅ {mode} 模式测试成功")
            else:
                print(f"❌ {mode} 模式测试失败")
        
        print("\n✅ 所有基本功能测试完成")
        return True
        
    except ImportError as e:
        print(f"❌ 导入失败: {e}")
        return False
    except Exception as e:
        print(f"❌ 测试过程中出错: {e}")
        return False

def test_voice_transformer_full():
    """测试完整版语音变换器"""
    print("\n测试完整版语音变换器...")
    
    try:
        from voice_transformer import VoiceTransformer
        
        # 尝试创建变换器实例
        transformer = VoiceTransformer()
        
        if transformer.whisper_model and transformer.tts_engine:
            print("✅ 完整版语音变换器初始化成功")
            print("✅ Whisper模型加载成功")
            print("✅ TTS引擎初始化成功")
            return True
        else:
            print("⚠️ 完整版语音变换器部分功能不可用")
            return False
            
    except ImportError as e:
        print(f"⚠️ 完整版暂不可用 (缺少依赖): {e}")
        return False
    except Exception as e:
        print(f"⚠️ 完整版初始化失败: {e}")
        return False

def main():
    """主测试函数"""
    print("=" * 60)
    print("🧪 汤姆猫语音变换器测试套件")
    print("Tom Cat Voice Transformer Test Suite")
    print("=" * 60)
    
    # 测试演示版
    demo_success = test_voice_transformer_demo()
    
    # 测试完整版
    full_success = test_voice_transformer_full()
    
    print("\n" + "=" * 60)
    print("📊 测试结果总结:")
    print(f"演示版功能: {'✅ 正常' if demo_success else '❌ 异常'}")
    print(f"完整版功能: {'✅ 正常' if full_success else '⚠️ 不可用'}")
    
    if demo_success:
        print("\n🎉 基本功能测试通过！")
        print("💡 提示: 演示版可以正常使用")
        if not full_success:
            print("💡 提示: 要使用完整版功能，请安装所有依赖:")
            print("   sudo apt-get install portaudio19-dev python3-pyaudio ffmpeg espeak")
            print("   pip install openai-whisper pyaudio playsound keyboard")
    else:
        print("\n❌ 基本功能测试失败")
        
    print("=" * 60)

if __name__ == "__main__":
    main()