/**
 * base64 → 字节：Rust 侧 PTY 输出（`Vec<u8>`）经 JSON 事件投递时编码为
 * base64 字符串（数字数组形态每字节 ~4-5 字符，base64 约 ~1.37x，与 browser
 * 截图载荷同一编码）。`atob` 在 WebView 与 Node 16+ 均为全局，逐字符
 * charCodeAt 拷贝是当前最快的免依赖解码路径。
 */
export const decodeBase64ToBytes = (input: string): Uint8Array => {
  const binary = atob(input)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
