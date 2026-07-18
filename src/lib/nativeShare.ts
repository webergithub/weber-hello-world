// 统一分享：原生走系统分享面板，Web 走 navigator.share / 复制到剪贴板。
import { Capacitor } from '@capacitor/core'

export async function shareText(title: string, text: string): Promise<'shared' | 'copied' | 'failed'> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Share } = await import('@capacitor/share')
      await Share.share({ title, text, dialogTitle: title })
      return 'shared'
    } catch {
      return 'failed'
    }
  }
  // Web
  try {
    if (navigator.share) {
      await navigator.share({ title, text })
      return 'shared'
    }
  } catch {
    // 用户取消或不支持，落到复制
  }
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
