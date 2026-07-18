// 统一拍照：原生(iOS/Android) 走 Capacitor 原生相机，Web 走 <input type=file>。
import { Capacitor } from '@capacitor/core'

// 原生拍照，返回 dataURL；用户取消返回 null。
export async function capturePhotoNative(): Promise<string | null> {
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
  try {
    const perm = await Camera.checkPermissions()
    if (perm.camera !== 'granted') {
      const req = await Camera.requestPermissions({ permissions: ['camera'] })
      if (req.camera !== 'granted') return null
    }
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Camera,
      quality: 70,
      correctOrientation: true,
    })
    return photo.dataUrl ?? null
  } catch {
    // 用户取消或出错
    return null
  }
}

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform()
}
