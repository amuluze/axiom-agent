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

/**
 * UTF-8 字符串 → base64：设计稿写回通道用（`write_design_document` 以 base64
 * 传输 1.4MB 级 JSON）。先 TextEncoder 编码再分块 btoa——`btoa` 只收
 * latin1，直接塞 UTF-16 码元会丢字符；分块是避免 `String.fromCharCode`
 * 展开大数组触发调用栈上限。
 */
export const encodeUtf8ToBase64 = (input: string): string => {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
