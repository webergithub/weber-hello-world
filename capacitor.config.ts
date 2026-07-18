import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.trailmate.app',
  appName: 'TrailMate 出游助手',
  webDir: 'dist',
  backgroundColor: '#0b1120',
  plugins: {
    Geolocation: {
      // iOS 后台持续定位（跟车）需在 Info.plist 里配置 UIBackgroundModes
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0f766e',
    },
    Keyboard: {
      resize: 'body',
    },
  },
  // 本地联调：把注释打开并填入电脑局域网 IP，可在真机上热加载调试
  // server: { url: 'http://192.168.1.100:5173', cleartext: true },
}

export default config
