export type Language = 'zh' | 'en';

export const LANGUAGE_STORAGE_KEY = 'inside-language';

const ENGLISH_TRANSLATIONS: Readonly<Record<string, string>> = {
  '切换为英语': 'Switch to English',
  '切换为中文': 'Switch to Chinese',
  'INSIDE — 屏幕之内': 'INSIDE — Beyond the screen',
  '倾斜手机，看画面停留在视线里，再退入屏幕深处。一个可以亲手体验的空间视觉实验。': 'Tilt your phone, keep the image in view, then let it recede into the screen. An interactive spatial visual experiment.',

  '手动模拟': 'Manual simulation',
  '模拟 iPhone Duo 翻盖效果': 'iPhone Duo flip simulation',
  '等待授权': 'Waiting for permission',
  '等待体感': 'Waiting for motion',
  '体感已连接': 'Motion connected',
  '未获授权': 'Not authorized',
  '需要 HTTPS': 'HTTPS required',
  '连接未完成': 'Connection incomplete',

  'INSIDE 首页': 'INSIDE home',
  '空间效果预览': 'Spatial effect preview',
  '雪山日落锁屏演示，包含原图的时间与天气信息': 'Snowy mountain sunset lock screen demo with the original time and weather information',
  '随手机倾斜反向旋转、下沉并逐渐失焦的雪山画面': 'Snowy mountain scene that counter-rotates, recedes, and gradually blurs as the phone tilts',
  '可旋转的 iPhone 17 Pro Max 三维模型，屏幕实时呈现倾斜效果': 'Rotatable iPhone 17 Pro Max 3D model with the tilt effect rendered live on screen',
  '打开效果调节': 'Open effect controls',
  '调节': 'Controls',
  '退出沉浸体验': 'Exit immersive preview',
  '关闭效果调节': 'Close effect controls',
  '效果调节': 'Effect controls',
  'iPhone 预览': 'iPhone preview',
  '重新校准正面': 'Recalibrate front view',
  '重新连接体感': 'Reconnect motion sensing',
  '启用手机体感': 'Enable motion sensing',
  '切换到手动模拟': 'Switch to manual simulation',
  '微调空间': 'Fine tuning',
  '重置效果参数': 'Reset effect parameters',
  '关闭参数面板': 'Close settings panel',
  '还原': 'Reset',

  '拉伸补偿': 'Stretch correction',
  '远侧收缩': 'Perspective',
  '远端压暗': 'Edge dimming',
  '开始失焦': 'Blur onset',
  '透视距离': 'View distance',
  '失焦程度': 'Blur',
  '空间效果': 'Spatial effect',
  '空间效果开关': 'Spatial effect toggle',
  '使用说明': 'Instructions',
  '拖动模型可左右自由旋转，上下俯仰限 ±10°，点击「回到正面」复位。': 'Drag the model to rotate freely left and right. Pitch is limited to ±10°. Click “Reset to front” to reset.',
  '在 iPhone Safari 中启用体感并允许访问。正对屏幕校准后，保持头部不动，缓慢左右转动手机。双击画面显示或隐藏控件。': 'Enable motion sensing in iPhone Safari and allow access. Calibrate while facing the screen, keep your head still, and slowly turn the phone left or right. Double-tap the screen to show or hide controls.',
  '拉伸补偿调节横向展开，远侧收缩调节近大远小。透视距离填写眼睛到屏幕的距离；失焦程度越高，模糊区域越暗。': 'Stretch correction controls horizontal expansion; Perspective controls near-far scaling. Enter the distance from your eyes to the screen under View distance; higher Blur makes blurred areas darker.',
  '拉伸补偿调节横向展开，透视距离填写眼睛到屏幕的距离。远端压暗控制模糊区域的明暗：0% 不压暗，100% 为原有强度，200% 加强压暗。它不改变图片透视或模糊程度；固定边缘保持明亮。': 'Stretch correction controls horizontal expansion. Set View distance to the distance from your eyes to the screen. Edge dimming controls the darkness of blurred areas: 0% disables it, 100% keeps the original strength, and 200% increases it. Perspective and blur stay the same; the hinged edge stays bright.',
  'iPhone 全屏体验': 'Full-screen iPhone experience',
  '用 Safari 打开本页，点击「分享」→「添加到主屏幕」→「添加」。如出现「作为 Web App 打开」，请保持开启。随后回到手机桌面，点击新添加的 INSIDE 图标，即可在没有 Safari 地址栏和工具栏的界面中体验。进入后双击画面显示控件，再启用体感。': 'Open this page in Safari, tap “Share” → “Add to Home Screen” → “Add”. If “Open as Web App” appears, leave it enabled. Return to the Home Screen and tap the new INSIDE icon to use the experience without Safari’s address or toolbar. Double-tap the screen to show controls, then enable motion sensing.',
  '打开 iPhone 预览，或使用相机扫描二维码': 'Open the iPhone preview, or scan the QR code with your camera',
  'iPhone 预览二维码': 'iPhone preview QR code',
  '相机扫码': 'Scan with camera',
  '在 Safari 中打开': 'Open in Safari',

  '手动模拟与实时读数': 'Manual simulation and live readings',
  '旋转': 'Rotation',
  '暂停演示': 'Pause demo',
  '播放演示': 'Play demo',
  '左右倾斜': 'Rotation',
  '拖动查看机身': 'Drag to view device',
  '回到正面': 'Reset to front',
  '左侧固定': 'Left hinge',
  '右侧固定': 'Right hinge',
  '正对屏幕后启用体感': 'Face the screen, then enable motion sensing',
  '手动体验': 'Try manually',
  '校准正面': 'Calibrate front',
  '启用体感': 'Enable motion sensing',
  'Design by Artgineer，打开小红书主页': 'Design by Artgineer, open Xiaohongshu profile',
  '小红书': 'Xiaohongshu',
  '实时屏幕改编': 'Live screen adaptation',
  '· 实时屏幕改编': '· Live screen adaptation',
  '当前使用基础模糊预览。': 'Using basic blur preview.',

  '当前设备不支持 WebGL，已切换基础模糊。': 'WebGL is not supported on this device. Switched to basic blur.',
  '3D 模型暂时不可用，已显示基础外框。': 'The 3D model is temporarily unavailable. Showing the basic frame.',

  '正对手机，启用后缓慢转动手腕。': 'Face the phone, then slowly turn your wrist after enabling motion sensing.',
  '体感已连接 · 当前姿态已校准': 'Motion sensing connected · Current pose calibrated',
  '已将当前握持姿态设为正面。': 'Current holding pose set as front.',
  '请保持手机正对自己，等待方向数据。': 'Keep the phone facing you and wait for orientation data.',
  '屏幕方向已改变，正在重新校准。': 'Screen orientation changed; recalibrating.',
  '拖动画面或调整角度，模拟转动手机。': 'Drag the screen or adjust the angle to simulate turning the phone.',
  '体感需要受信任的 HTTPS 地址。当前可继续手动体验；连接方法见下方说明。': 'Motion sensing requires a trusted HTTPS address. You can continue manually; see the instructions below for connection steps.',
  '这个浏览器不支持方向传感器，可拖动画面手动体验。': 'This browser does not support orientation sensors. Drag the screen to try manually.',
  '请在浏览器弹窗中允许访问方向传感器。': 'Allow orientation sensor access in the browser prompt.',
  '方向访问未获允许。可继续手动体验，或在 Safari 网站设置中允许后重试。': 'Orientation access was not allowed. You can continue manually, or allow it in Safari website settings and try again.',
  '保持手机正对自己，正在等待方向数据…': 'Keep the phone facing you while waiting for orientation data…',
  '尚未收到方向数据。请用 iPhone Safari 检查权限，或切换手动体验。': 'No orientation data received. Check permissions in iPhone Safari or switch to manual mode.',
  '无法访问方向传感器，请检查 Safari 权限与 HTTPS 证书后重试。': 'Unable to access orientation sensors. Check Safari permissions and the HTTPS certificate, then try again.',
};

export function readLanguage(): Language {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function translate(text: string, language: Language): string {
  if (language === 'zh') return text;
  return ENGLISH_TRANSLATIONS[text] ?? text;
}
