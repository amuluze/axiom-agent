//! computer 工具宿主会话：macOS 电脑控制——Accessibility 观测（语义树快照）
//! 加合成输入注入（CGEvent / AX 动作）与屏幕捕获。对齐 zcode / codex 的
//! Computer Use 形态：a11y 优先语义动作（不移动真指针、不抢焦点），坐标/键盘
//! 是回退路径；观察一次 → 动作一次 → 验证。
//!
//! 安全边界（全部 Rust 权威强制，schema 层校验只是前置过滤）：
//! - 双权限前提：辅助功能（AXIsProcessTrusted，AX 观测与 CGEvent 注入的
//!   前提）+ 屏幕录制（CGPreflightScreenCaptureAccess，截图前提）；未授权
//!   时动作 fail-closed 并给出中文指引；
//! - 会话级门 + 应用 allowlist：控制类动作（点击/输入/按键/滚屏/打开应用）
//!   携带 sessionId，按目标 app 鉴权——命中 allowlist（`~/.axiom/computer/
//!   allowed_apps.json`，0600，Rust 独占）或 (sessionId, pid) 会话授权即放行，
//!   否则弹原生 NSAlert 三选一（仅本会话 / 始终允许 / 拒绝）。观察类动作
//!   （列 app / 快照 / 截图）不设门。目标 app 解析：element 动作经快照注册
//!   表、坐标动作经 AXUIElementCopyElementAtPosition 命中元素归属、键盘
//!   动作经 kAXFocusedApplication——不存在「无归属」的全局注入；
//! - kill switch：`stop` 清空全部会话授权（allowlist 不动），下一个控制动作
//!   重新走确认；
//! - 不执行 shell、不读文件：输入注入是事件通道（与终端手势门同一威胁模型
//!   面：受陷渲染进程无法伪造原生对话框里的用户手势）。
//!
//! 与 browser 工具的分工：browser 是隔离 profile 的无凭据导航通道（localhost
//! dev server 验证），computer 是真用户桌面的可见操作通道（爆炸半径大得多，
//! 因此有 allowlist 门控而 browser 没有）。二者刻意不共享鉴权。
//!
//! 实现注记：AX/CGEvent/CGWindowList 全部手写 extern "C" FFI（对齐 power.rs
//! 风格，不引新 crate）；NSWorkspace/NSRunningApplication（枚举运行 app）与
//! NSAlert（会话门 sheet）走 objc2-app-kit 绑定，需主线程（run_on_main）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_void, CStr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use base64::Engine as _;
use tauri::{AppHandle, Manager as _, State};

const MAX_TEXT_INPUT_CHARS: usize = 20_000;
const MAX_TREE_CHARS: usize = 200 * 1024;
/// AX 树遍历上限：节点数与深度双上限，防病态深树拖垮快照。
const MAX_TREE_NODES: usize = 4000;
const MAX_TREE_DEPTH: usize = 12;
// 坐标动作必须能命中归属 app（AX hit-test），无 AX 区域拒绝——这是门控的
// 结构性前提：不存在未经鉴权的全局事件注入。

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

// ---------------------------------------------------------------------------
// 请求 / 响应契约（TS 侧 platform/computerSession.ts 逐字镜像）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputerAccessKind {
    Accessibility,
    ScreenRecording,
}

#[derive(Debug, Deserialize)]
// 枚举级 rename_all 改判别值，rename_all_fields 改字段（tabId/imageBase64 等），
// 与 browser_session 的请求枚举同一约定。
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ComputerCommandRequest {
    Status,
    RequestAccess { kind: ComputerAccessKind },
    ListApps,
    /// 打开（并激活）应用。门控目标即被打开的应用（bundleId 优先，否则 name）。
    OpenApp {
        session_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        bundle_id: Option<String>,
    },
    ListWindows {
        #[serde(default)]
        pid: Option<i32>,
    },
    AppState {
        #[serde(default)]
        pid: Option<i32>,
        #[serde(default)]
        bundle_id: Option<String>,
        #[serde(default)]
        include_screenshot: bool,
    },
    Screenshot {
        #[serde(default)]
        pid: Option<i32>,
    },
    ClickElement {
        session_id: String,
        state_token: String,
        element_id: u64,
    },
    SetValue {
        session_id: String,
        state_token: String,
        element_id: u64,
        text: String,
    },
    ClickAt {
        session_id: String,
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<String>,
        #[serde(default)]
        clicks: Option<u32>,
    },
    ScrollAt {
        session_id: String,
        x: f64,
        y: f64,
        #[serde(default)]
        delta_x: Option<f64>,
        #[serde(default)]
        delta_y: Option<f64>,
    },
    TypeText {
        session_id: String,
        text: String,
        #[serde(default)]
        state_token: Option<String>,
        #[serde(default)]
        element_id: Option<u64>,
    },
    PressKey {
        session_id: String,
        key: String,
        #[serde(default)]
        modifiers: Option<Vec<String>>,
        #[serde(default)]
        state_token: Option<String>,
        #[serde(default)]
        element_id: Option<u64>,
    },
    /// kill switch：session_id 缺省 = 清空全部会话授权。
    Stop {
        #[serde(default)]
        session_id: Option<String>,
    },
    AllowApp { bundle_id: String, name: String },
    UnallowApp { bundle_id: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAppInfo {
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub name: String,
    pub frontmost: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWindowInfo {
    pub window_id: u64,
    pub title: String,
    pub focused: bool,
    pub bounds: [f64; 4],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenshot {
    pub image_base64: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub resized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerGrantInfo {
    pub session_id: String,
    pub pid: i32,
    pub app_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAllowedApp {
    pub bundle_id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ComputerCommandResponse {
    Status {
        accessibility: bool,
        screen_recording: bool,
        grants: Vec<ComputerGrantInfo>,
        allowlist: Vec<ComputerAllowedApp>,
    },
    Apps { apps: Vec<ComputerAppInfo> },
    AppOpened { app: ComputerAppInfo },
    Windows { windows: Vec<ComputerWindowInfo> },
    State {
        state_token: String,
        app: ComputerAppInfo,
        tree: String,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        screenshot: Option<ComputerScreenshot>,
    },
    Screenshot(ComputerScreenshot),
    Done,
}

// ---------------------------------------------------------------------------
// macOS FFI（ApplicationServices / CoreGraphics / CoreFoundation）
// Boolean 返回值按 unsigned char 声明（u8），bool 仅用于 C _Bool 的
// CGPreflight/CGRequest——把非 0/1 值读成 bool 是 UB。
// ---------------------------------------------------------------------------

type CFStringRef = *const c_void;
type CFArrayRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFDictionaryMutRef = *mut c_void;
type CFBooleanRef = *const c_void;
/// AXUIElement / AXValue / CGEvent / CGImage / CFData 均 CF 类型，指针语义。
type CFTypeRef = *const c_void;
type AXUIElementRef = *mut c_void;
type AXError = i32;
type CGEventRef = *mut c_void;
type CGImageRef = *const c_void;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

/// CGEventType（只列鼠标事件类型；键盘/滚轮由 CGEventCreate* API 自带）。
const CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;
const CG_EVENT_LEFT_MOUSE_UP: u32 = 2;
const CG_EVENT_RIGHT_MOUSE_DOWN: u32 = 3;
const CG_EVENT_RIGHT_MOUSE_UP: u32 = 4;
/// kCGMouseEventClickCount。
const CG_FIELD_MOUSE_CLICK_COUNT: u32 = 1;
/// CGScrollEventUnit：kCGScrollEventUnitPixel。
const CG_SCROLL_UNIT_PIXEL: u32 = 1;
/// CGEventTapLocation：kCGHIDEventTap（会话级合成事件注入点）。
const CG_TAP_HID: u32 = 0;
/// CGWindowListOption：kCGWindowListOptionOnScreenOnly。
const CG_WINDOW_LIST_ON_SCREEN: u32 = 1;
/// kCGWindowImageDefault。
const CG_WINDOW_IMAGE_DEFAULT: u32 = 0;
/// CGEventFlags 修饰键位（kCGEventFlagMask*）。
const CG_FLAG_CMD: u64 = 1 << 8;
const CG_FLAG_SHIFT: u64 = 1 << 9;
const CG_FLAG_ALT: u64 = 1 << 11;
const CG_FLAG_CTRL: u64 = 1 << 12;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        alloc: CFTypeRef,
        c_str: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFArrayGetCount(array: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: isize) -> CFTypeRef;
    fn CFBooleanGetValue(boolean: CFBooleanRef) -> u8;
    fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
    fn CFDataGetLength(data: CFTypeRef) -> isize;
    fn CFStringGetLength(the_string: CFStringRef) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: isize,
        encoding: u32,
    ) -> u8;
    fn CFDictionaryCreate(
        allocator: CFTypeRef,
        keys: *mut CFTypeRef,
        values: *mut CFTypeRef,
        num_values: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFDictionaryMutRef;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut *mut c_void,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXUIElementCopyElementAtPosition(
        system_wide: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXUIElementCopyActionNames(
        element: AXUIElementRef,
        names: *mut CFArrayRef,
    ) -> AXError;
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
}

/// AXValueType：kAXValueCGPointType=1 / CGSize=2 / CGRect=3。
const AX_VALUE_CGPOINT: u32 = 1;
const AX_VALUE_CGSIZE: u32 = 2;

/// AXError 关键值（错误消息区分用）。
const AX_ERROR_SUCCESS: AXError = 0;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateMouseEvent(
        source: CFTypeRef,
        mouse_type: u32,
        position: CGPoint,
        button: u32,
    ) -> CGEventRef;
    fn CGEventCreateScrollWheelEvent2(
        source: CFTypeRef,
        units: u32,
        wheel_count: u32,
        wheel1: f64,
        wheel2: f64,
        wheel3: f64,
    ) -> CGEventRef;
    fn CGEventCreateKeyboardEvent(
        source: CFTypeRef,
        virtual_key: u16,
        key_down: bool,
    ) -> CGEventRef;
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: isize, string: *const u16);
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGEventPostToPid(pid: i32, event: CGEventRef);
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGWindowListCreateImage(
        screen_bounds: CGRect,
        list_option: u32,
        window_id: u32,
        image_option: u32,
    ) -> CGImageRef;
    fn CGImageGetWidth(image: CGImageRef) -> isize;
    fn CGImageGetHeight(image: CGImageRef) -> isize;
    fn CGImageGetBitsPerPixel(image: CGImageRef) -> isize;
    fn CGImageGetBytesPerRow(image: CGImageRef) -> isize;
    fn CGImageGetDataProvider(image: CGImageRef) -> CFTypeRef;
    fn CGDataProviderCopyData(provider: CFTypeRef) -> CFTypeRef;
    /// 10.15+ 的屏幕录制权限预检（bool 是 C _Bool，可安全映射）。
    fn CGPreflightScreenCaptureAccess() -> bool;
}

// ---------------------------------------------------------------------------
// CF 助手（RAII 释放；本模块内所有 CF 对象的所有权边界都在同一线程局部）
// ---------------------------------------------------------------------------

/// CFString 生命周期守卫：Drop 时 CFRelease。
struct ScopedCFString(CFStringRef);

impl ScopedCFString {
    fn new(text: &str) -> Self {
        let mut bytes = text.as_bytes().to_vec();
        bytes.push(0);
        let raw = unsafe {
            CFStringCreateWithCString(
                std::ptr::null(),
                bytes.as_ptr() as *const c_char,
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        ScopedCFString(raw)
    }

    fn as_ref(&self) -> CFStringRef {
        self.0
    }
}

impl Drop for ScopedCFString {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

/// AXUIElement 的 retain/release 包装：快照注册表跨命令存元素引用必须显式
/// 持有（AXCopy 出的对象归调用方）。
#[derive(Clone)]
struct RetainedAxElement(AXUIElementRef);

impl RetainedAxElement {
    fn retain(raw: AXUIElementRef) -> Option<Self> {
        if raw.is_null() {
            return None;
        }
        unsafe { CFRetain(raw) };
        Some(RetainedAxElement(raw))
    }
}

// AXUIElement 是 CF 对象（内部带锁），跨线程移动安全；指针本身需要显式
// 声明 Send 才能进入 ComputerSessionState（async command 的 State 约束）。
unsafe impl Send for RetainedAxElement {}

impl Drop for RetainedAxElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) }
        }
    }
}

fn cfstring_to_string(cf: CFStringRef) -> Option<String> {
    if cf.is_null() {
        return None;
    }
    unsafe {
        let length = CFStringGetLength(cf);
        if length <= 0 {
            return Some(String::new());
        }
        let capacity = CFStringGetMaximumSizeForEncoding(length, K_CF_STRING_ENCODING_UTF8) + 1;
        let mut buffer = vec![0u8; capacity.max(8) as usize];
        if CFStringGetCString(
            cf,
            buffer.as_mut_ptr() as *mut c_char,
            buffer.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
        ) == 0
        {
            return None;
        }
        let cstr = CStr::from_ptr(buffer.as_ptr() as *const c_char);
        Some(cstr.to_string_lossy().into_owned())
    }
}

fn cfboolean_to_bool(value: CFTypeRef) -> Option<bool> {
    if value.is_null() {
        return None;
    }
    Some(unsafe { CFBooleanGetValue(value as CFBooleanRef) } != 0)
}

/// CFArray 拆包：逐项取指针（调用方决定如何解释每项）。
fn cf_array_items(array: CFArrayRef) -> Vec<CFTypeRef> {
    if array.is_null() {
        return Vec::new();
    }
    unsafe {
        let count = CFArrayGetCount(array);
        (0..count)
            .map(|index| CFArrayGetValueAtIndex(array, index))
            .collect()
    }
}

/// 读 AX 属性并释放返回的 CF 对象（调用方拿到 String/f64 等值语义副本）。
fn ax_string_attribute(element: AXUIElementRef, attribute: &str) -> Option<String> {
    let key = ScopedCFString::new(attribute);
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(element, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return None;
    }
    let text = cfstring_to_string(raw as CFStringRef);
    unsafe { CFRelease(raw as CFTypeRef) };
    text
}

fn ax_bool_attribute(element: AXUIElementRef, attribute: &str) -> Option<bool> {
    let key = ScopedCFString::new(attribute);
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(element, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return None;
    }
    let value = cfboolean_to_bool(raw);
    unsafe { CFRelease(raw as CFTypeRef) };
    value
}

/// AX 位置/尺寸属性（AXValue 包装的 CGPoint/CGSize）。
fn ax_point_attribute(element: AXUIElementRef, attribute: &str) -> Option<CGPoint> {
    let key = ScopedCFString::new(attribute);
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(element, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return None;
    }
    let mut point = CGPoint { x: 0.0, y: 0.0 };
    let ok = unsafe { AXValueGetValue(raw as CFTypeRef, AX_VALUE_CGPOINT, &mut point as *mut CGPoint as *mut c_void) };
    unsafe { CFRelease(raw as CFTypeRef) };
    (ok != 0).then_some(point)
}

fn ax_size_attribute(element: AXUIElementRef, attribute: &str) -> Option<CGSize> {
    let key = ScopedCFString::new(attribute);
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(element, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return None;
    }
    let mut size = CGSize { width: 0.0, height: 0.0 };
    let ok = unsafe { AXValueGetValue(raw as CFTypeRef, AX_VALUE_CGSIZE, &mut size as *mut CGSize as *mut c_void) };
    unsafe { CFRelease(raw as CFTypeRef) };
    (ok != 0).then_some(size)
}

/// 读 AX 子元素数组：返回 retain 过的元素列表（注册表可直接接管）。
fn ax_children_elements(element: AXUIElementRef) -> Vec<RetainedAxElement> {
    let key = ScopedCFString::new("AXChildren");
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(element, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return Vec::new();
    }
    let children = cf_array_items(raw as CFArrayRef)
        .into_iter()
        .filter_map(|item| RetainedAxElement::retain(item as AXUIElementRef))
        .collect();
    unsafe { CFRelease(raw as CFTypeRef) };
    children
}

/// 系统级 AX 元素（懒初始化单例；AXUIElementCreateSystemWide 归调用方所有，
/// 进程生命周期内持有即可）。
fn system_wide_element() -> AXUIElementRef {
    // 指针以 usize 存（static 要求 Send+Sync）；进程生命周期内持有不释放。
    static INSTANCE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let pointer = *INSTANCE.get_or_init(|| unsafe { AXUIElementCreateSystemWide() } as usize);
    pointer as AXUIElementRef
}

/// 辅助功能权限探测（只读）。
/// options 必须是合法 CFDictionary：传 NULL 在 macOS 26 的 HIServices 内部
/// 会对 options 直接 CFGetTypeID 解引用（老系统容忍 NULL，新系统段错误，
/// 崩溃报告 Thread 7 实锤）——构造显式 prompt=false 的字典。
/// 注意：不再经 AXIsProcessTrustedWithOptions(prompt=true) 弹授权引导（弹窗
/// 状态机不可预测：每进程会话只弹一次、拒绝后不再弹），「去授权」按钮走系统
/// 设置深链（open_system_settings_for_kind）。
fn accessibility_trusted() -> bool {
    unsafe {
        let key = ScopedCFString::new("AXTrustedCheckOptionPrompt");
        let dict = CFDictionaryCreate(
            std::ptr::null(),
            [key.as_ref() as CFTypeRef].as_mut_ptr(),
            [kCFBooleanFalse].as_mut_ptr(),
            1,
            (&raw const kCFTypeDictionaryKeyCallBacks).cast(),
            (&raw const kCFTypeDictionaryValueCallBacks).cast(),
        );
        if dict.is_null() {
            // fail-closed：字典构造失败按无权限处理，绝不回退到 NULL options。
            return false;
        }
        let trusted = AXIsProcessTrustedWithOptions(dict as CFDictionaryRef) != 0;
        CFRelease(dict as CFTypeRef);
        trusted
    }
}

// CFBoolean 单例是真正的指针全局；而 kCFTypeDictionary*CallBacks 是**结构体**
// 全局（C 里传 &kCFType...）——按指针声明会把结构体首字段（函数指针）当地址
// 传给 CFDictionaryCreate，产出损坏字典（真机 SIGSEGV 的第二根因）。必须以
// 结构体类型声明后取地址。
#[repr(C)]
#[derive(Clone, Copy)]
struct CFDictionaryCallBacks {
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
    equal: *const c_void,
    hash: *const c_void,
}

extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    static kCFBooleanFalse: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: CFDictionaryCallBacks;
    static kCFTypeDictionaryValueCallBacks: CFDictionaryCallBacks;
}

/// 屏幕录制权限（10.15+；无该 API 的系统按无权限处理，fail-closed）。
fn screen_recording_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

// ---------------------------------------------------------------------------
// 系统设置隐私面板深链（「去授权」引导）
// ---------------------------------------------------------------------------

const SYSTEM_SETTINGS_PRIVACY_URL_VENTURA: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";
const SYSTEM_SETTINGS_PRIVACY_URL_LEGACY: &str =
    "x-apple.systempreferences:com.apple.preference.security";

/// 隐私面板深链：macOS 13+ 新 schema 在前，旧 schema（macOS 12-）兜底。
/// 每个面板两条候选 URL，open 失败依次尝试（纯函数，单测锁定）。
fn system_settings_urls(kind: ComputerAccessKind) -> Vec<String> {
    let anchor = match kind {
        ComputerAccessKind::Accessibility => "Privacy_Accessibility",
        ComputerAccessKind::ScreenRecording => "Privacy_ScreenCapture",
    };
    vec![
        format!("{SYSTEM_SETTINGS_PRIVACY_URL_VENTURA}?{anchor}"),
        format!("{SYSTEM_SETTINGS_PRIVACY_URL_LEGACY}?{anchor}"),
    ]
}

/// 打开系统设置隐私面板：候选 URL 逐条尝试，全部失败给手动指引。
async fn open_system_settings_for_kind(kind: &ComputerAccessKind) -> Result<(), String> {
    for url in system_settings_urls(*kind) {
        let status = tokio::process::Command::new("/usr/bin/open")
            .arg(&url)
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        if matches!(status, Ok(status) if status.success()) {
            return Ok(());
        }
    }
    Err("无法打开系统设置：请手动前往 系统设置 → 隐私与安全性 → 辅助功能/屏幕录制 中授权 Axiom".into())
}



// ---------------------------------------------------------------------------
// AX 树快照（FFI 遍历 → 纯数据 → 纯函数格式化，格式化可单测）
// ---------------------------------------------------------------------------

/// 快照节点（扁平 + parent 索引，遍历产出；格式化纯函数消费）。
#[derive(Debug, Clone, PartialEq)]
struct AxNodeData {
    eid: u64,
    role: String,
    name: String,
    value: String,
    /// None = 未知；Some(false) = 禁用（Some(true) 不注记，与 browser 快照同约）。
    enabled: Option<bool>,
    focused: bool,
    parent: Option<u64>,
}

/// 角色归一（与 browser_session::ax_role_display 同思路但独立实现：
/// macOS AX 角色是 PascalCase，如 AXButton/button/AXTextField/staticText）。
fn ax_role_display(role: &str, name: &str) -> Option<String> {
    let canonical = role
        .trim_start_matches("AX")
        .to_ascii_lowercase();
    match canonical.as_str() {
        "" => None,
        "generic" | "group" | "unknown" => {
            if name.is_empty() {
                None
            } else {
                Some("group".into())
            }
        }
        "statictext" | "text" => {
            if name.is_empty() {
                None
            } else {
                Some("text".into())
            }
        }
        "textfield" | "searchfield" | "textarea" | "combobox" => Some("textbox".into()),
        "securetextfield" => Some("passwordbox".into()),
        "axwebarea" | "webarea" => Some("webarea".into()),
        other => Some(other.to_string()),
    }
}

/// 快照文本格式化（纯函数）：`[eid=N] role "name" [已禁用] = "value"`，
/// 缩进两级空格，text 角色输出裸文本行。超 MAX_TREE_CHARS 截断。
fn format_ax_nodes(nodes: &[AxNodeData]) -> (String, bool) {
    let by_eid: HashMap<u64, &AxNodeData> =
        nodes.iter().map(|node| (node.eid, node)).collect();
    let mut output = String::new();
    let mut truncated = false;
    for node in nodes {
        let Some(role) = ax_role_display(&node.role, &node.name) else {
            continue;
        };
        let depth = ancestor_depth(&by_eid, node);
        let indent = "  ".repeat(depth);
        if role == "text" {
            let text = if node.name.is_empty() {
                node.value.as_str()
            } else {
                node.name.as_str()
            };
            output.push_str(&format!("{indent}- \"{text}\"\n"));
        } else {
            let mut line = format!("{indent}- [eid={}] {role}", node.eid);
            if !node.name.is_empty() {
                line.push_str(&format!(" \"{}\"", node.name));
            }
            if node.enabled == Some(false) {
                line.push_str(" [已禁用]");
            }
            if node.focused {
                line.push_str(" [焦点中]");
            }
            let text_like = ["textbox", "passwordbox", "combobox"];
            if !node.value.is_empty()
                && text_like.iter().any(|candidate| role.eq_ignore_ascii_case(candidate))
            {
                line.push_str(&format!(" = \"{}\"", node.value));
            }
            output.push_str(&line);
            output.push('\n');
        }
        if output.len() > MAX_TREE_CHARS {
            truncated = true;
            output.push_str("\n[快照已截断：界面可访问性树超过 200 KiB 上限，请缩小观测范围]\n");
            break;
        }
    }
    (output, truncated)
}

/// 计算节点深度：沿 parent 链上溯（被剪的中间层不影响深度计算的简单近似）。
fn ancestor_depth(by_eid: &HashMap<u64, &AxNodeData>, node: &AxNodeData) -> usize {
    let mut depth = 0usize;
    let mut cursor = node.parent;
    let mut guard = 0usize;
    while let Some(parent_eid) = cursor {
        guard += 1;
        if guard > MAX_TREE_DEPTH {
            break;
        }
        depth += 1;
        cursor = by_eid.get(&parent_eid).and_then(|parent| parent.parent);
    }
    depth.min(MAX_TREE_DEPTH)
}

/// FFI 遍历：从 app 根元素收集 AxNodeData + eid → 元素注册表。
fn walk_ax_tree(
    root: AXUIElementRef,
    next_eid: &mut u64,
) -> (Vec<AxNodeData>, HashMap<u64, RetainedAxElement>) {
    let mut nodes = Vec::new();
    let mut registry: HashMap<u64, RetainedAxElement> = HashMap::new();
    // 显式栈 (元素, parent eid, 深度)；保留根元素引用供注册表外持有。
    let root_holder = RetainedAxElement::retain(root).filter(|holder| !holder.0.is_null());
    let Some(root_holder) = root_holder else {
        return (nodes, registry);
    };
    let mut stack: Vec<(RetainedAxElement, Option<u64>, usize)> =
        vec![(root_holder, None, 0)];
    while let Some((element, parent, depth)) = stack.pop() {
        if nodes.len() >= MAX_TREE_NODES || depth > MAX_TREE_DEPTH {
            continue;
        }
        let role = ax_string_attribute(element.0, "AXRole").unwrap_or_default();
        let title = ax_string_attribute(element.0, "AXTitle").unwrap_or_default();
        let description = ax_string_attribute(element.0, "AXDescription").unwrap_or_default();
        let value = ax_string_attribute(element.0, "AXValue").unwrap_or_default();
        let enabled = ax_bool_attribute(element.0, "AXEnabled");
        let focused = ax_bool_attribute(element.0, "AXFocused").unwrap_or(false);
        let name = if title.is_empty() { description } else { title };
        let eid = *next_eid;
        *next_eid += 1;
        nodes.push(AxNodeData {
            eid,
            role: role.clone(),
            name: name.clone(),
            value: value.clone(),
            enabled,
            focused,
            parent,
        });
        registry.insert(eid, element.clone());
        let children = ax_children_elements(element.0);
        // 反序压栈保证输出顺序与视觉顺序一致。
        for child in children.into_iter().rev() {
            stack.push((child, Some(eid), depth + 1));
        }
    }
    (nodes, registry)
}

// ---------------------------------------------------------------------------
// 会话状态 / 快照注册表 / allowlist
// ---------------------------------------------------------------------------

/// 每个 app 保留最近 N 代快照（元素注册表），旧代淘汰。
const KEPT_SNAPSHOT_GENERATIONS: usize = 2;

struct AppSnapshot {
    generation: u64,
    elements: HashMap<u64, RetainedAxElement>,
}

#[derive(Default)]
struct ComputerInner {
    /// (session_id, pid) → app 名（会话授权，进程内存，重启清空）。
    grants: HashMap<(String, i32), String>,
    /// pid → 最近快照代（保留 KEPT_SNAPSHOT_GENERATIONS 代）。
    snapshots: HashMap<i32, VecDeque<AppSnapshot>>,
    next_eid: u64,
}

/// 电脑控制会话状态：会话授权 + 快照注册表。allowlist 是磁盘文件，读写经
/// 独立函数（锁外序列化，读-改-写在调用方锁内完成结构判定）。
#[derive(Default)]
pub struct ComputerSessionState(StdMutex<Option<ComputerInner>>);

impl ComputerSessionState {
    fn with_inner<T>(
        &self,
        body: impl FnOnce(&mut ComputerInner) -> T,
    ) -> Result<T, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "computer state lock poisoned".to_string())?;
        let inner = guard.get_or_insert_with(ComputerInner::default);
        Ok(body(inner))
    }
}

/// allowlist 文件路径：`~/.axiom/computer/allowed_apps.json`（0600）。
fn allowed_apps_path(data_root: &std::path::Path) -> PathBuf {
    data_root.join("computer").join("allowed_apps.json")
}

/// 读 allowlist：损坏/缺失 fail-safe 回退空表（与授权注册表同一自愈哲学：
/// 用户重新经设置页添加即可，不阻断其它动作）。
fn load_allowed_apps(data_root: &std::path::Path) -> Vec<ComputerAllowedApp> {
    let path = allowed_apps_path(data_root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_allowed_apps(data_root: &std::path::Path, apps: &[ComputerAllowedApp]) -> Result<(), String> {
    let path = allowed_apps_path(data_root);
    let dir = path.parent().ok_or("allowlist 路径异常")?;
    std::fs::create_dir_all(dir).map_err(|error| format!("创建电脑控制目录失败：{error}"))?;
    crate::storage_paths::set_directory_permissions(dir)?;
    let payload =
        serde_json::to_string_pretty(apps).map_err(|error| format!("序列化 allowlist 失败：{error}"))?;
    std::fs::write(&path, payload).map_err(|error| format!("写入 allowlist 失败：{error}"))?;
    crate::storage_paths::set_file_permissions(&path)?;
    Ok(())
}

/// 门控判定（纯函数，单测锁定）：Pass / NeedDialog / KillSwitch。
#[derive(Debug, Clone, PartialEq, Eq)]
enum GateDecision {
    /// allowlist 命中或已有会话授权。
    Pass { via_allowlist: bool },
    /// 需要原生对话框确认。
    NeedDialog,
}

fn gate_decision(
    allowlist: &[ComputerAllowedApp],
    grants: &HashMap<(String, i32), String>,
    session_id: &str,
    pid: i32,
    bundle_id: Option<&str>,
    name: &str,
) -> GateDecision {
    let bundle_hit = bundle_id.is_some_and(|bundle| {
        allowlist.iter().any(|app| app.bundle_id.eq_ignore_ascii_case(bundle))
    });
    if bundle_hit {
        return GateDecision::Pass { via_allowlist: true };
    }
    // 无 bundleId 的 app 以名字为 allowlist 键（设置页展示同名条目）。
    if bundle_id.is_none()
        && allowlist.iter().any(|app| app.name == name)
    {
        return GateDecision::Pass { via_allowlist: true };
    }
    if grants.contains_key(&(session_id.to_string(), pid)) {
        return GateDecision::Pass { via_allowlist: false };
    }
    GateDecision::NeedDialog
}

/// 原生确认结果。
enum GateDialogChoice {
    AllowSession,
    AllowAlways,
    Denied,
}

/// 会话门三选一 sheet：绑定主窗口（对齐 workspace_approval::confirm_interactive
/// 的 parent 理由——无 parent 的对话框不在常规 AX 树内，值守自动化无法驱动）。
async fn show_gate_dialog(
    app: &AppHandle,
    app_name: &str,
) -> Result<GateDialogChoice, String> {
    #[cfg(target_os = "macos")]
    {
                use objc2_app_kit::{NSAlert, NSWindow};
        use objc2_foundation::{MainThreadMarker, NSString};

        let title = format!("允许 Axiom 控制应用「{app_name}」？");
        let message = "该会话中的 Agent 将能在此应用内点击、输入与操作。";
        let app_handle = app.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel::<i64>();
        let sender_cell = Arc::new(StdMutex::new(Some(sender)));
        let sender_for_block = Arc::clone(&sender_cell);
        app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                if let Some(tx) = sender_cell.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(-1);
                }
                return;
            };
            let alert = NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str(&title));
            alert.setInformativeText(&NSString::from_str(message));
            alert.setAlertStyle(objc2_app_kit::NSAlertStyle::Warning);
            alert.addButtonWithTitle(&NSString::from_str("仅本会话允许"));
            alert.addButtonWithTitle(&NSString::from_str("始终允许"));
            alert.addButtonWithTitle(&NSString::from_str("拒绝"));
            let block = block2::RcBlock::new(move |response: isize| {
                if let Some(tx) = sender_for_block.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(response as i64);
                }
            });
            let parent = app_handle
                .get_webview_window("main")
                .and_then(|window| window.ns_window().ok());
            match parent {
                Some(raw) if !raw.is_null() => {
                    let ns_window: &NSWindow = unsafe { &*(raw.cast::<NSWindow>()) };
                    alert.beginSheetModalForWindow_completionHandler(
                        ns_window,
                        Some(&*block),
                    );
                    // sheet 模态会话期间由 AppKit 持有 alert；forget 避免 Retained
                    // 提前释放打断会话（每次确认一个对象，频率极低可接受）。
                    std::mem::forget(alert);
                }
                _ => {
                    // 无主窗口（异常形态）：runModal 同步等用户选择，保持
                    // fail-closed（不确认不放行）。
                    let response = alert.runModal() as i64;
                    if let Some(tx) = sender_cell.lock().ok().and_then(|mut slot| slot.take()) {
                        let _ = tx.send(response);
                    }
                }
            }
        })
        .map_err(|_| "会话确认对话框调度失败".to_string())?;
        let response = receiver
            .await
            .map_err(|_| "会话确认对话框意外关闭".to_string())?;
        if response < 0 {
            return Err("会话确认对话框无法展示".into());
        }
        // NSAlertFirstButtonReturn = 1000 起。
        Ok(match response {
            1000 => GateDialogChoice::AllowSession,
            1001 => GateDialogChoice::AllowAlways,
            _ => GateDialogChoice::Denied,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, app_name);
        Err("仅 macOS 支持电脑控制".into())
    }
}

/// 控制类动作的统一门：命中 allowlist/会话授权直接放行，否则弹原生确认。
/// 「始终允许」在锁外写文件前先在锁内登记（先授权再持久化，与工作区授权
/// 注册表同一 fail-closed 顺序），持久化失败不影响本次会话授权。
async fn authorize_app(
    app: &AppHandle,
    state: &ComputerSessionState,
    data_root: &std::path::Path,
    session_id: &str,
    pid: i32,
    name: &str,
    bundle_id: Option<&str>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("缺少会话标识：控制动作必须由会话内工具发起".into());
    }
    let decision = state.with_inner(|inner| {
        gate_decision(&load_allowed_apps(data_root), &inner.grants, session_id, pid, bundle_id, name)
    })?;
    if let GateDecision::Pass { .. } = decision {
        return Ok(());
    }
    let choice = show_gate_dialog(app, name).await?;
    match choice {
        GateDialogChoice::AllowSession => {
            state.with_inner(|inner| {
                inner.grants.insert((session_id.to_string(), pid), name.to_string());
            })?;
            Ok(())
        }
        GateDialogChoice::AllowAlways => {
            state.with_inner(|inner| {
                inner.grants.insert((session_id.to_string(), pid), name.to_string());
            })?;
            if let Some(bundle) = bundle_id {
                let mut allowlist = load_allowed_apps(data_root);
                if !allowlist.iter().any(|entry| entry.bundle_id.eq_ignore_ascii_case(bundle)) {
                    allowlist.push(ComputerAllowedApp {
                        bundle_id: bundle.to_string(),
                        name: name.to_string(),
                    });
                    save_allowed_apps(data_root, &allowlist)?;
                }
            }
            Ok(())
        }
        GateDialogChoice::Denied => Err(format!(
            "用户拒绝了在「{name}」上的电脑控制：停止在该应用上的操作，向用户说明后再继续"
        )),
    }
}

/// 直接登记会话授权（不经对话框）：仅用于「用户已确认打开该应用」的启动链路。
fn insert_grant(state: &ComputerSessionState, session_id: &str, pid: i32, name: &str) {
    let _ = state.with_inner(|inner| {
        inner.grants.insert((session_id.to_string(), pid), name.to_string());
    });
}

/// 注册快照：分配代际号、登记元素注册表、淘汰旧代。返回 stateToken（pid:gen）。
fn store_snapshot(
    state: &ComputerSessionState,
    pid: i32,
    registry: HashMap<u64, RetainedAxElement>,
) -> Result<String, String> {
    state.with_inner(|inner| {
        let generation = inner.next_eid;
        inner.next_eid += 1;
        let queue = inner.snapshots.entry(pid).or_default();
        queue.push_back(AppSnapshot {
            generation,
            elements: registry,
        });
        while queue.len() > KEPT_SNAPSHOT_GENERATIONS {
            queue.pop_front();
        }
        format!("{pid}:{generation}")
    })
}

/// 取快照元素：stateToken（pid:generation）匹配最新代才有效；代际过期报
/// 「重新 state」引导（与浏览器工具的「ref 过期重新 snapshot」同款纪律）。
fn take_snapshot_element(
    state: &ComputerSessionState,
    state_token: &str,
    element_id: u64,
) -> Result<(RetainedAxElement, i32), String> {
    let (pid, generation) = parse_state_token(state_token)?;
    state
        .with_inner(|inner| {
            inner
                .snapshots
                .get(&pid)
                .and_then(|queue| queue.back())
                .and_then(|snapshot| {
                    (snapshot.generation == generation)
                        .then(|| snapshot.elements.get(&element_id).cloned())
                        .flatten()
                })
                .map(|element| (element, pid))
        })?
        .ok_or_else(|| {
            "快照已过期或元素不存在：请重新执行 state 获取最新快照后再操作".to_string()
        })
}

fn parse_state_token(token: &str) -> Result<(i32, u64), String> {
    let (pid, generation) = token
        .split_once(':')
        .ok_or("stateToken 格式错误（应为 pid:generation）")?;
    let pid: i32 = pid.parse().map_err(|_| "stateToken 的 pid 非法")?;
    let generation: u64 = generation.parse().map_err(|_| "stateToken 的 generation 非法")?;
    Ok((pid, generation))
}

// ---------------------------------------------------------------------------
// App 管理（NSWorkspace 主线程封装 + /usr/bin/open 直启）
// ---------------------------------------------------------------------------

/// 主线程执行 AppKit 调用（NSWorkspace/NSAlert 都是 MainThreadOnly）。
async fn run_on_main<T: Send + 'static>(
    app: &AppHandle,
    body: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(body());
    })
    .map_err(|error| format!("主线程调度失败：{error}"))?;
    receiver
        .await
        .map_err(|_| "主线程任务意外终止".to_string())
}

/// 枚举运行中的常规应用（NSWorkspace，主线程）。
async fn list_running_apps(app: &AppHandle) -> Result<Vec<ComputerAppInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        run_on_main(app, || {
            use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};

            let workspace = NSWorkspace::sharedWorkspace();
            workspace.runningApplications()
                .iter()
                .filter(|running| running.activationPolicy() == NSApplicationActivationPolicy::Regular)
                .map(|running| {
                    ComputerAppInfo {
                        pid: running.processIdentifier(),
                        bundle_id: running.bundleIdentifier().map(|bundle| bundle.to_string()),
                        name: running
                            .localizedName()
                            .map(|name| name.to_string())
                            .unwrap_or_else(|| "未知应用".into()),
                        frontmost: running.isActive(),
                    }
                })
                .collect()
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("仅 macOS 支持电脑控制".into())
    }
}

/// 打开并激活应用：`/usr/bin/open -a/-b`（直接 exec、env_clear，不经 shell；
/// open 本身会激活目标应用）。返回启动/激活后的运行信息。
async fn open_app_process(
    name: Option<&str>,
    bundle_id: Option<&str>,
) -> Result<(), String> {
    let mut command = tokio::process::Command::new("/usr/bin/open");
    if let Some(bundle) = bundle_id {
        command.args(["-b", bundle]);
    } else if let Some(name) = name {
        command.args(["-a", name]);
    } else {
        return Err("必须提供应用名或 bundleId".into());
    }
    command.env_clear();
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map_err(|error| format!("打开应用失败：{error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "打开应用失败：应用可能未安装或被系统策略阻止".to_string())
}

/// 等待 app 出现在运行列表（open 异步拉起），按 bundle 优先、名字回退匹配。
async fn wait_app_running(
    app: &AppHandle,
    bundle_id: Option<&str>,
    name: &str,
) -> Result<ComputerAppInfo, String> {
    for _ in 0..20 {
        let apps = list_running_apps(app).await?;
        if let Some(found) = apps.iter().find(|info| {
            bundle_id
                .map(|bundle| {
                    info.bundle_id
                        .as_deref()
                        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(bundle))
                })
                .unwrap_or(false)
                || (bundle_id.is_none() && info.name == name)
        }) {
            return Ok(found.clone());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(format!("应用「{name}」启动超时：未出现在运行列表中"))
}

/// 读焦点应用元素 + pid（同步段：CF 裸指针局部不跨 await，async fn 的
/// future Send 约束不允许裸指针存活到 await 点之后）。
fn read_focused_app_element() -> Result<(RetainedAxElement, i32), String> {
    let system_wide = system_wide_element();
    if system_wide.is_null() {
        return Err("无法创建系统级辅助功能元素".into());
    }
    let key = ScopedCFString::new("AXFocusedApplication");
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(system_wide, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return Err("无法定位焦点应用（检查 辅助功能 权限）".into());
    }
    let element = RetainedAxElement::retain(raw as AXUIElementRef)
        .ok_or("焦点应用元素无效")?;
    unsafe { CFRelease(raw as CFTypeRef) };
    let mut pid: i32 = -1;
    if unsafe { AXUIElementGetPid(element.0, &mut pid) } != AX_ERROR_SUCCESS || pid <= 0 {
        return Err("无法读取焦点应用 pid".into());
    }
    Ok((element, pid))
}

/// 解析 AX 焦点应用元素 + 应用身份（name 取 AXTitle；bundle 经运行列表查）。
async fn focused_app(app: &AppHandle) -> Result<(RetainedAxElement, ComputerAppInfo), String> {
    let (element, pid) = read_focused_app_element()?;
    let name = ax_string_attribute(element.0, "AXTitle").unwrap_or_else(|| "未知应用".into());
    let apps = list_running_apps(app).await?;
    let bundle_id = apps
        .iter()
        .find(|info| info.pid == pid)
        .and_then(|info| info.bundle_id.clone());
    let frontmost = apps
        .iter()
        .find(|info| info.pid == pid)
        .map(|info| info.frontmost)
        .unwrap_or(true);
    Ok((
        element,
        ComputerAppInfo {
            pid,
            bundle_id,
            name,
            frontmost,
        },
    ))
}

/// 按 pid 取 app 元素 + 身份。
/// 创建 app 级元素（同步段：同上，裸指针不跨 await）。
fn create_app_element(pid: i32) -> Result<RetainedAxElement, String> {
    let raw = unsafe { AXUIElementCreateApplication(pid) };
    if raw.is_null() {
        return Err("无法创建应用辅助功能元素".into());
    }
    let element = RetainedAxElement::retain(raw).ok_or("应用元素无效")?;
    unsafe { CFRelease(raw as CFTypeRef) };
    Ok(element)
}

async fn app_element_for_pid(
    app: &AppHandle,
    pid: i32,
) -> Result<(RetainedAxElement, ComputerAppInfo), String> {
    let element = create_app_element(pid)?;
    let name = ax_string_attribute(element.0, "AXTitle").unwrap_or_else(|| "未知应用".into());
    let apps = list_running_apps(app).await?;
    let known = apps.iter().find(|info| info.pid == pid);
    Ok((
        element,
        ComputerAppInfo {
            pid,
            bundle_id: known.and_then(|info| info.bundle_id.clone()),
            name: known
                .map(|info| info.name.clone())
                .unwrap_or(name),
            frontmost: known.map(|info| info.frontmost).unwrap_or(false),
        },
    ))
}

// ---------------------------------------------------------------------------
// 输入注入（element 语义动作优先；坐标/键盘为回退）
// ---------------------------------------------------------------------------

/// 元素是否支持某动作（AXUIElementCopyActionNames）。
fn element_has_action(element: AXUIElementRef, action: &str) -> bool {
    let mut names: CFArrayRef = std::ptr::null();
    let error = unsafe { AXUIElementCopyActionNames(element, &mut names) };
    if error != AX_ERROR_SUCCESS || names.is_null() {
        return false;
    }
    let actions = cf_array_items(names)
        .into_iter()
        .filter_map(|item| cfstring_to_string(item as CFStringRef))
        .collect::<Vec<_>>();
    unsafe { CFRelease(names as CFTypeRef) };
    actions.iter().any(|candidate| candidate == action)
}

/// element 语义点击（AXPress）：不移动真指针、不抢焦点（a11y 优先路径）。
fn element_press(element: AXUIElementRef) -> Result<(), String> {
    if !element_has_action(element, "AXPress") {
        return Err(
            "该元素不支持点击动作：改用 set_value（可编辑元素）或 click_at（坐标回退）".into(),
        );
    }
    let action = ScopedCFString::new("AXPress");
    let error = unsafe { AXUIElementPerformAction(element, action.as_ref()) };
    if error == AX_ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("元素点击失败（AX error {error}）：请重新 state 后重试"))
    }
}

/// element 语义设值：先 AXFocus（部分控件要求聚焦才接受输入）再设 AXValue。
fn element_set_value(element: AXUIElementRef, text: &str) -> Result<(), String> {
    let focus_key = ScopedCFString::new("AXFocused");
    unsafe {
        AXUIElementSetAttributeValue(
            element,
            focus_key.as_ref(),
            kCFBooleanTrue,
        );
    }
    let value_key = ScopedCFString::new("AXValue");
    let text_holder = ScopedCFString::new(text);
    let error = unsafe {
        AXUIElementSetAttributeValue(element, value_key.as_ref(), text_holder.as_ref())
    };
    if error == AX_ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "设置元素值失败（AX error {error}）：元素可能不可编辑，重新 state 确认目标"
        ))
    }
}

/// AXFocus 元素（键盘动作前的定位）。
fn element_focus(element: AXUIElementRef) -> Result<(), String> {
    let focus_key = ScopedCFString::new("AXFocused");
    let error = unsafe {
        AXUIElementSetAttributeValue(element, focus_key.as_ref(), kCFBooleanTrue)
    };
    if error == AX_ERROR_SUCCESS {
        Ok(())
    } else {
        Err("聚焦元素失败：元素可能不可聚焦，重新 state 确认目标".into())
    }
}

/// 坐标 → 归属 app 元素（AX hit-test）。门控的结构性前提：所有坐标动作先经
/// 此命中确定目标 app，不存在未经鉴权的全局注入。
fn element_at_position(x: f64, y: f64) -> Result<(RetainedAxElement, i32), String> {
    let system_wide = system_wide_element();
    if system_wide.is_null() {
        return Err("无法创建系统级辅助功能元素".into());
    }
    let mut raw: AXUIElementRef = std::ptr::null_mut();
    let error =
        unsafe { AXUIElementCopyElementAtPosition(system_wide, x as f32, y as f32, &mut raw) };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return Err(
            "该坐标无法定位归属元素（无辅助功能信息）：改用 state 快照的 element 动作".into(),
        );
    }
    let element = RetainedAxElement::retain(raw).ok_or("命中元素无效")?;
    let mut pid: i32 = -1;
    if unsafe { AXUIElementGetPid(element.0, &mut pid) } != AX_ERROR_SUCCESS || pid <= 0 {
        return Err("无法读取命中元素的归属应用".into());
    }
    Ok((element, pid))
}

/// 鼠标事件合成并投递到目标 app（CGEventPostToPid：不移动真指针）。
fn post_mouse_events_to_pid(
    pid: i32,
    x: f64,
    y: f64,
    button: u32,
    down_type: u32,
    up_type: u32,
    clicks: u32,
) -> Result<(), String> {
    let point = CGPoint { x, y };
    for (event_type, is_down) in [(down_type, true), (up_type, false)] {
        let event = unsafe { CGEventCreateMouseEvent(std::ptr::null(), event_type, point, button) };
        if event.is_null() {
            return Err("合成鼠标事件失败".into());
        }
        unsafe {
            if is_down {
                CGEventSetIntegerValueField(event, CG_FIELD_MOUSE_CLICK_COUNT, clicks as i64);
            }
            CGEventPostToPid(pid, event);
            CFRelease(event as CFTypeRef);
        }
    }
    Ok(())
}

/// 滚轮事件合成（wheel1=纵向、wheel2=横向，像素单位）投递到目标 app。
fn post_scroll_events_to_pid(
    pid: i32,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), String> {
    let event = unsafe {
        CGEventCreateScrollWheelEvent2(
            std::ptr::null(),
            CG_SCROLL_UNIT_PIXEL,
            2,
            delta_y,
            delta_x,
            0.0,
        )
    };
    if event.is_null() {
        return Err("合成滚轮事件失败".into());
    }
    unsafe {
        CGEventPostToPid(pid, event);
        CFRelease(event as CFTypeRef);
    }
    Ok(())
}

/// 键名 → 虚拟键码（Carbon kVK 常量硬编码）。单字符返回 None（走 Unicode 注入）。
fn named_key_virtual_code(name: &str) -> Option<u16> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => 36,
        "tab" => 48,
        "escape" | "esc" => 53,
        "backspace" | "delete" => 51,
        "forwarddelete" | "delete_forward" => 117,
        "space" => 49,
        "arrowup" => 126,
        "arrowdown" => 125,
        "arrowleft" => 123,
        "arrowright" => 124,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "help" => 114,
        "f1" => 122,
        "f2" => 120,
        "f3" => 99,
        "f4" => 118,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f8" => 100,
        "f9" => 101,
        "f10" => 109,
        "f11" => 103,
        "f12" => 111,
        _ => return None,
    })
}

/// 修饰键名 → (CGEventFlags 位, 修饰键虚拟键码)。
fn modifier_definition(name: &str) -> Option<(u64, u16)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "cmd" | "command" | "meta" | "super" => (CG_FLAG_CMD, 55),
        "ctrl" | "control" => (CG_FLAG_CTRL, 59),
        "alt" | "option" => (CG_FLAG_ALT, 58),
        "shift" => (CG_FLAG_SHIFT, 56),
        _ => return None,
    })
}

/// 组合修饰键（修饰键按下 → 主键 down/up → 反序抬起，投递到前台 tap）。
fn post_key_chord(virtual_key: u16, modifiers: &[(u64, u16)]) -> Result<(), String> {
    let mut held: Vec<CGEventRef> = Vec::new();
    for (_, vk) in modifiers {
        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), *vk, true) };
        if event.is_null() {
            return Err("合成修饰键事件失败".into());
        }
        unsafe { CGEventPost(CG_TAP_HID, event) };
        held.push(event);
    }
    let flags = modifiers.iter().map(|(flag, _)| *flag).fold(0u64, |acc, flag| acc | flag);
    for key_down in [true, false] {
        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), virtual_key, key_down) };
        if event.is_null() {
            return Err("合成键盘事件失败".into());
        }
        unsafe {
            CGEventSetFlags(event, flags);
            CGEventPost(CG_TAP_HID, event);
            CFRelease(event as CFTypeRef);
        }
    }
    // 反序抬起修饰键（keyUp + flags 清空）。
    for (_, vk) in modifiers.iter().rev() {
        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), *vk, false) };
        if event.is_null() {
            continue;
        }
        unsafe {
            CGEventSetFlags(event, 0);
            CGEventPost(CG_TAP_HID, event);
            CFRelease(event as CFTypeRef);
        }
    }
    for event in held {
        unsafe { CFRelease(event as CFTypeRef) };
    }
    Ok(())
}

/// Unicode 文本按键注入：CGEventKeyboardSetUnicodeString 单事件最多约 20 个
/// UTF-16 码元，超出必须分块；块边界不得落在代理对中间（CJK 增补平面字符
/// 会被拆成坏字符）。纯函数，单测锁定。
fn chunk_utf16(text: &str) -> Vec<Vec<u16>> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < units.len() {
        let mut end = (start + 20).min(units.len());
        // 块尾是高代理且后面还有低代理：块尾前移一位，避免拆开代理对。
        if end < units.len() && (0xD800..=0xDBFF).contains(&units[end - 1]) {
            end -= 1;
        }
        if end <= start {
            // 只剩单个高代理（encode_utf16 不会产生）：原样收块防死循环。
            end = start + 1;
        }
        chunks.push(units[start..end].to_vec());
        start = end;
    }
    chunks
}

fn post_unicode_text(text: &str) -> Result<(), String> {
    for chunk in chunk_utf16(text) {
        for key_down in [true, false] {
            let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, key_down) };
            if event.is_null() {
                return Err("合成文本输入事件失败".into());
            }
            unsafe {
                CGEventKeyboardSetUnicodeString(
                    event,
                    chunk.len() as isize,
                    chunk.as_ptr(),
                );
                CGEventPost(CG_TAP_HID, event);
                CFRelease(event as CFTypeRef);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 屏幕捕获（CGWindowListCreateImage；macOS 14+ 弃用告警已知，SCK 迁移列为后续）
// ---------------------------------------------------------------------------

/// 捕获指定矩形（全局显示坐标）→ PNG + 尺寸（4 MiB 上限降采样，复用 browser
/// 的守卫）。色彩：CGWindowList 默认 ARGB 字节序（PremultipliedFirst/32Big）。
fn capture_screen_rect(rect: CGRect) -> Result<ComputerScreenshot, String> {
    if !screen_recording_granted() {
        return Err("缺少屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕录制 中允许 Axiom".into());
    }
    let image = unsafe {
        CGWindowListCreateImage(rect, CG_WINDOW_LIST_ON_SCREEN, 0, CG_WINDOW_IMAGE_DEFAULT)
    };
    if image.is_null() {
        return Err("屏幕捕获失败：目标区域可能不可见".into());
    }
    let result = decode_cg_image_to_png(image);
    unsafe { CFRelease(image as CFTypeRef) };
    let (png, width, height, resized) = result?;
    Ok(ComputerScreenshot {
        image_base64: base64::engine::general_purpose::STANDARD.encode(png),
        mime_type: "image/png".into(),
        width,
        height,
        resized,
    })
}

fn decode_cg_image_to_png(image: CGImageRef) -> Result<(Vec<u8>, u32, u32, bool), String> {
    let (width, height, bpp, bpr) = unsafe {
        (
            CGImageGetWidth(image),
            CGImageGetHeight(image),
            CGImageGetBitsPerPixel(image),
            CGImageGetBytesPerRow(image),
        )
    };
    if width <= 0 || height <= 0 {
        return Err("捕获的图像尺寸无效".into());
    }
    if bpp != 32 {
        return Err(format!("不支持的像素格式（{bpp} bpp，期望 32）"));
    }
    let data = unsafe { CGDataProviderCopyData(CGImageGetDataProvider(image)) };
    if data.is_null() {
        return Err("读取图像数据失败".into());
    }
    let length = unsafe { CFDataGetLength(data) } as usize;
    let pointer = unsafe { CFDataGetBytePtr(data) };
    if pointer.is_null() || length < (bpr as usize) * (height as usize) {
        unsafe { CFRelease(data) };
        return Err("图像数据不完整".into());
    }
    let mut rgba = image::RgbaImage::new(width as u32, height as u32);
    for row in 0..height as usize {
        let line = unsafe { std::slice::from_raw_parts(pointer.add(row * bpr as usize), 4 * width as usize) };
        for column in 0..width as usize {
            // ARGB 字节序：A=line[4c]，R=line[4c+1]，G=line[4c+2]，B=line[4c+3]。
            rgba.put_pixel(
                column as u32,
                row as u32,
                image::Rgba([line[4 * column + 1], line[4 * column + 2], line[4 * column + 3], 255]),
            );
        }
    }
    unsafe { CFRelease(data) };
    let dynamic = image::DynamicImage::ImageRgba8(rgba);
    let mut buffer = std::io::Cursor::new(Vec::new());
    dynamic
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|error| format!("屏幕捕获编码失败：{error}"))?;
    crate::browser_session::ensure_screenshot_within_cap(buffer.into_inner())
}

/// app 焦点窗口的屏幕矩形（AXFocusedWindow 的 position+size）。
fn focused_window_rect(app_element: AXUIElementRef) -> Result<CGRect, String> {
    let key = ScopedCFString::new("AXFocusedWindow");
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(app_element, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return Err("无法定位应用焦点窗口".into());
    }
    let window = RetainedAxElement::retain(raw as AXUIElementRef).ok_or("焦点窗口元素无效")?;
    unsafe { CFRelease(raw as CFTypeRef) };
    let position = ax_point_attribute(window.0, "AXPosition");
    let size = ax_size_attribute(window.0, "AXSize");
    match (position, size) {
        (Some(origin), Some(size)) => Ok(CGRect { origin, size }),
        _ => Err("无法读取焦点窗口位置/尺寸".into()),
    }
}

/// 窗口列表（AXWindows：标题/焦点/边界；windowId 用 AX 哈希近似自增序号）。
fn list_app_windows(app_element: AXUIElementRef) -> Vec<ComputerWindowInfo> {
    let key = ScopedCFString::new("AXWindows");
    let mut raw: *mut c_void = std::ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyAttributeValue(app_element, key.as_ref(), &mut raw as *mut *mut c_void)
    };
    if error != AX_ERROR_SUCCESS || raw.is_null() {
        return Vec::new();
    }
    let windows = cf_array_items(raw as CFArrayRef)
        .into_iter()
        .filter_map(|item| RetainedAxElement::retain(item as AXUIElementRef))
        .enumerate()
        .map(|(index, window)| {
            let title = ax_string_attribute(window.0, "AXTitle").unwrap_or_default();
            let focused = ax_bool_attribute(window.0, "AXFocused").unwrap_or(false);
            let position = ax_point_attribute(window.0, "AXPosition");
            let size = ax_size_attribute(window.0, "AXSize");
            ComputerWindowInfo {
                window_id: index as u64 + 1,
                title,
                focused,
                bounds: match (position, size) {
                    (Some(origin), Some(size)) => [origin.x, origin.y, size.width, size.height],
                    _ => [0.0, 0.0, 0.0, 0.0],
                },
            }
        })
        .collect();
    unsafe { CFRelease(raw as CFTypeRef) };
    windows
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

/// 控制类动作的公共前置：总开关 + 辅助功能权限 + 空会话标识。
fn control_guard(state: &ComputerSessionState, session_id: &str) -> Result<(), String> {
    if !accessibility_trusted() {
        return Err(
            "缺少辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能 中允许 Axiom".into(),
        );
    }
    if session_id.trim().is_empty() {
        return Err("缺少会话标识：控制动作必须由会话内工具发起".into());
    }
    let _ = state;
    Ok(())
}

#[tauri::command]
pub async fn computer_command(
    app: AppHandle,
    state: State<'_, ComputerSessionState>,
    request: ComputerCommandRequest,
) -> Result<ComputerCommandResponse, String> {
    let data_root = crate::storage_paths::axiom_data_root(&app)?;
    match request {
        ComputerCommandRequest::Status => {
            let grants = state.with_inner(|inner| {
                inner
                    .grants
                    .iter()
                    .map(|((session_id, pid), name)| ComputerGrantInfo {
                        session_id: session_id.clone(),
                        pid: *pid,
                        app_name: name.clone(),
                    })
                    .collect::<Vec<_>>()
            })?;
            Ok(ComputerCommandResponse::Status {
                accessibility: accessibility_trusted(),
                screen_recording: screen_recording_granted(),
                grants,
                allowlist: load_allowed_apps(&data_root),
            })
        }
        ComputerCommandRequest::RequestAccess { kind } => {
            // 权限请求直接打开系统设置隐私面板深链（对齐 codex 引导 UX）。
            // CGRequestScreenCaptureAccess / AXIsProcessTrustedWithOptions
            // (prompt=true) 的系统弹窗在 macOS 26 对 adhoc 应用不可靠（后台
            // tokio 线程调用静默失败、每进程会话只弹一次、拒绝后不再弹），
            // 深链行为确定且可在真机验证。
            open_system_settings_for_kind(&kind).await?;
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::ListApps => {
            if !accessibility_trusted() {
                return Err("缺少辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能 中允许 Axiom".into());
            }
            Ok(ComputerCommandResponse::Apps {
                apps: list_running_apps(&app).await?,
            })
        }
        ComputerCommandRequest::OpenApp { session_id, name, bundle_id } => {
            control_guard(&state, &session_id)?;
            let display_name = name.clone().unwrap_or_else(|| bundle_id.clone().unwrap_or_default());
            if display_name.is_empty() {
                return Err("必须提供应用名或 bundleId".into());
            }
            let apps = list_running_apps(&app).await?;
            let running = apps.into_iter().find(|info| {
                bundle_id.as_deref().is_some_and(|bundle| {
                    info.bundle_id.as_deref().is_some_and(|candidate| candidate.eq_ignore_ascii_case(bundle))
                }) || (bundle_id.is_none() && info.name == display_name)
            });
            let target = match running {
                // 已在跑：按真实 pid 过门（一次确认），再激活。
                Some(info) => {
                    authorize_app(&app, &state, &data_root, &session_id, info.pid, &info.name, info.bundle_id.as_deref()).await?;
                    info
                }
                // 未运行：先按「即将打开的应用」身份过门，启动等待 pid 后直接
                // 登记会话授权（不再二次确认——用户已确认打开该应用）。此路径
                // 下「始终允许」退化为会话授权（bundleId 未知时 allowlist 键不
                // 稳定，持久化交给设置页在应用识别后手动添加）。
                None => {
                    authorize_app(&app, &state, &data_root, &session_id, 0, &display_name, bundle_id.as_deref()).await?;
                    open_app_process(name.as_deref(), bundle_id.as_deref()).await?;
                    let launched = wait_app_running(&app, bundle_id.as_deref(), &display_name).await?;
                    insert_grant(&state, &session_id, launched.pid, &launched.name);
                    launched
                }
            };
            open_app_process(name.as_deref(), bundle_id.as_deref()).await?;
            Ok(ComputerCommandResponse::AppOpened { app: target })
        }
        ComputerCommandRequest::ListWindows { pid } => {
            let (element, _) = match pid {
                Some(pid) => app_element_for_pid(&app, pid).await?,
                None => focused_app(&app).await?,
            };
            Ok(ComputerCommandResponse::Windows {
                windows: list_app_windows(element.0),
            })
        }
        ComputerCommandRequest::AppState { pid, bundle_id, include_screenshot } => {
            if !accessibility_trusted() {
                return Err("缺少辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能 中允许 Axiom".into());
            }
            let (element, app_info) = if let Some(pid) = pid {
                app_element_for_pid(&app, pid).await?
            } else if let Some(bundle) = bundle_id.as_deref() {
                let apps = list_running_apps(&app).await?;
                let found = apps
                    .into_iter()
                    .find(|info| {
                        info.bundle_id.as_deref().is_some_and(|candidate| candidate.eq_ignore_ascii_case(bundle))
                    })
                    .ok_or_else(|| format!("未找到运行中的应用：{bundle}"))?;
                app_element_for_pid(&app, found.pid).await?
            } else {
                focused_app(&app).await?
            };
            // 预留 eid 区间（锁外遍历不持锁；代际号与 eid 共用同一单调计数器，
            // 预留保证 token 与 eid 不碰撞）。
            let mut next_eid = state.with_inner(|inner| {
                let base = inner.next_eid;
                inner.next_eid = base.saturating_add(MAX_TREE_NODES as u64 + 1);
                base
            })?;
            let (nodes, registry) = walk_ax_tree(element.0, &mut next_eid);
            let state_token = store_snapshot(&state, app_info.pid, registry)?;
            let (tree, truncated) = format_ax_nodes(&nodes);
            let screenshot = if include_screenshot {
                Some(capture_screen_rect(focused_window_rect(element.0)?)?)
            } else {
                None
            };
            Ok(ComputerCommandResponse::State {
                state_token,
                app: app_info,
                tree,
                truncated,
                screenshot,
            })
        }
        ComputerCommandRequest::Screenshot { pid } => {
            let rect = match pid {
                Some(pid) => {
                    let (element, _) = app_element_for_pid(&app, pid).await?;
                    focused_window_rect(element.0)?
                }
                None => unsafe { CGDisplayBounds(CGMainDisplayID()) },
            };
            Ok(ComputerCommandResponse::Screenshot(capture_screen_rect(rect)?))
        }
        ComputerCommandRequest::ClickElement { session_id, state_token, element_id } => {
            control_guard(&state, &session_id)?;
            let (element, pid) = take_snapshot_element(&state, &state_token, element_id)?;
            let (_, app_info) = app_element_for_pid(&app, pid).await?;
            authorize_app(&app, &state, &data_root, &session_id, pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
            element_press(element.0)?;
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::SetValue { session_id, state_token, element_id, text } => {
            if text.chars().count() > MAX_TEXT_INPUT_CHARS {
                return Err(format!("输入文本不得超过 {MAX_TEXT_INPUT_CHARS} 字符"));
            }
            control_guard(&state, &session_id)?;
            let (element, pid) = take_snapshot_element(&state, &state_token, element_id)?;
            let (_, app_info) = app_element_for_pid(&app, pid).await?;
            authorize_app(&app, &state, &data_root, &session_id, pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
            element_set_value(element.0, &text)?;
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::ClickAt { session_id, x, y, button, clicks } => {
            if !x.is_finite() || !y.is_finite() {
                return Err("点击坐标必须是有限数值".into());
            }
            control_guard(&state, &session_id)?;
            let (element, pid) = element_at_position(x, y)?;
            let (_, app_info) = app_element_for_pid(&app, pid).await?;
            authorize_app(&app, &state, &data_root, &session_id, pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
            // a11y 优先：命中元素支持 AXPress 就走语义路径（不移动指针）；
            // 否则向该 app 投递合成鼠标事件。
            if element_has_action(element.0, "AXPress") {
                element_press(element.0)?;
            } else {
                let is_right = button.as_deref() == Some("right");
                let clicks = clicks.unwrap_or(1).clamp(1, 3);
                let (down_type, up_type, cg_button) = if is_right {
                    (CG_EVENT_RIGHT_MOUSE_DOWN, CG_EVENT_RIGHT_MOUSE_UP, 1)
                } else {
                    (CG_EVENT_LEFT_MOUSE_DOWN, CG_EVENT_LEFT_MOUSE_UP, 0)
                };
                post_mouse_events_to_pid(pid, x, y, cg_button, down_type, up_type, clicks)?;
            }
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::ScrollAt { session_id, x, y, delta_x, delta_y } => {
            if !x.is_finite() || !y.is_finite() {
                return Err("滚动坐标必须是有限数值".into());
            }
            control_guard(&state, &session_id)?;
            let (_, pid) = element_at_position(x, y)?;
            let (_, app_info) = app_element_for_pid(&app, pid).await?;
            authorize_app(&app, &state, &data_root, &session_id, pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
            post_scroll_events_to_pid(
                pid,
                delta_x.unwrap_or(0.0).clamp(-4000.0, 4000.0),
                delta_y.unwrap_or(0.0).clamp(-4000.0, 4000.0),
            )?;
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::TypeText { session_id, text, state_token, element_id } => {
            if text.chars().count() > MAX_TEXT_INPUT_CHARS {
                return Err(format!("输入文本不得超过 {MAX_TEXT_INPUT_CHARS} 字符"));
            }
            control_guard(&state, &session_id)?;
            // 可选元素目标：先 AXFocus（语义定位），再注入键盘。
            if let (Some(token), Some(element_id)) = (state_token.as_deref(), element_id) {
                let (element, pid) = take_snapshot_element(&state, token, element_id)?;
                let (_, app_info) = app_element_for_pid(&app, pid).await?;
                authorize_app(&app, &state, &data_root, &session_id, pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
                element_focus(element.0)?;
            }
            // 键盘注入作用于前台应用：以 kAXFocusedApplication 为门控目标。
            let (focused, app_info) = focused_app(&app).await?;
            authorize_app(&app, &state, &data_root, &session_id, app_info.pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
            let _ = focused;
            post_unicode_text(&text)?;
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::PressKey { session_id, key, modifiers, state_token, element_id } => {
            if key.trim().is_empty() {
                return Err("按键名不能为空".into());
            }
            control_guard(&state, &session_id)?;
            let modifier_defs = modifiers
                .unwrap_or_default()
                .iter()
                .map(|name| {
                    modifier_definition(name).ok_or_else(|| {
                        format!("不支持的修饰键：{name}（支持 cmd/ctrl/alt/shift）")
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            if let (Some(token), Some(element_id)) = (state_token.as_deref(), element_id) {
                let (element, pid) = take_snapshot_element(&state, token, element_id)?;
                let (_, app_info) = app_element_for_pid(&app, pid).await?;
                authorize_app(&app, &state, &data_root, &session_id, pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
                element_focus(element.0)?;
            }
            let (_, app_info) = focused_app(&app).await?;
            authorize_app(&app, &state, &data_root, &session_id, app_info.pid, &app_info.name, app_info.bundle_id.as_deref()).await?;
            if let Some(virtual_key) = named_key_virtual_code(&key) {
                post_key_chord(virtual_key, &modifier_defs)?;
            } else {
                // 单字符（含 CJK）：走 Unicode 注入；带修饰键的组合仅对 ASCII
                // 字母有意义，此处直接拒绝避免歧义。
                if !modifier_defs.is_empty() {
                    return Err("单字符按键不支持修饰键组合；请用命名键（如 cmd+c 传 key=c 的完整命令语义）".into());
                }
                let mut chars = key.chars();
                match (chars.next(), chars.next()) {
                    (Some(ch), None) => post_unicode_text(&ch.to_string())?,
                    _ => {
                        return Err(format!(
                            "不支持的按键：{key}（支持 Enter/Tab/Escape/Backspace/Delete/Arrow*/Home/End/PageUp/PageDown/Space/F1-F12 或单个字符）"
                        ))
                    }
                }
            }
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::Stop { session_id } => {
            state.with_inner(|inner| match session_id.as_deref() {
                Some(session) if !session.trim().is_empty() => {
                    inner.grants.retain(|(granted, _), _| granted != session);
                }
                _ => {
                    inner.grants.clear();
                }
            })?;
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::AllowApp { bundle_id, name } => {
            let mut allowlist = load_allowed_apps(&data_root);
            if !allowlist.iter().any(|entry| entry.bundle_id.eq_ignore_ascii_case(&bundle_id)) {
                allowlist.push(ComputerAllowedApp { bundle_id, name });
                save_allowed_apps(&data_root, &allowlist)?;
            }
            Ok(ComputerCommandResponse::Done)
        }
        ComputerCommandRequest::UnallowApp { bundle_id } => {
            let mut allowlist = load_allowed_apps(&data_root);
            allowlist.retain(|entry| !entry.bundle_id.eq_ignore_ascii_case(&bundle_id));
            save_allowed_apps(&data_root, &allowlist)?;
            Ok(ComputerCommandResponse::Done)
        }
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn node(eid: u64, role: &str, name: &str, parent: Option<u64>) -> AxNodeData {
        AxNodeData {
            eid,
            role: role.into(),
            name: name.into(),
            value: String::new(),
            enabled: None,
            focused: false,
            parent,
        }
    }

    #[test]
    fn formats_ax_nodes_with_eid_anchors_and_states() {
        let mut disabled = node(3, "AXButton", "提交", Some(1));
        disabled.enabled = Some(false);
        let mut value_box = node(4, "AXTextField", "搜索", Some(1));
        value_box.value = "当前值".into();
        let mut focused = node(5, "AXCheckBox", "记住我", Some(1));
        focused.focused = true;
        let nodes = vec![
            node(1, "AXApplication", "备忘录", None),
            node(2, "AXStaticText", "标题文本", Some(1)),
            disabled,
            value_box,
            focused,
            node(6, "AXGroup", "", Some(1)), // 无名泛型被剪
        ];
        let (text, truncated) = format_ax_nodes(&nodes);
        assert!(!truncated);
        assert!(text.contains("[eid=1] application \"备忘录\""), "{text}");
        assert!(text.contains("- \"标题文本\""), "{text}");
        assert!(text.contains("[eid=3] button \"提交\" [已禁用]"), "{text}");
        assert!(text.contains("[eid=4] textbox \"搜索\" = \"当前值\""), "{text}");
        assert!(text.contains("[eid=5] checkbox \"记住我\" [焦点中]"), "{text}");
        // 无名泛型整行不出现。
        assert!(!text.contains("group"), "{text}");
    }

    #[test]
    fn format_ax_nodes_truncates_over_cap() {
        let mut nodes = vec![node(1, "AXApplication", "App", None)];
        for index in 0..6000 {
            nodes.push(node(index + 2, "AXStaticText", &format!("很长很长的静态文本行第{index}条，用于触发快照截断保护"), Some(1)));
        }
        let (text, truncated) = format_ax_nodes(&nodes);
        assert!(truncated);
        assert!(text.len() <= MAX_TREE_CHARS + 200, "len={}", text.len());
        assert!(text.contains("快照已截断"));
    }

    #[test]
    fn request_response_serde_round_trip() {
        let request: ComputerCommandRequest =
            serde_json::from_str(r#"{"action":"openApp","sessionId":"s1","name":"日历"}"#)
                .expect("deserialize openApp");
        match request {
            ComputerCommandRequest::OpenApp { session_id, name, bundle_id } => {
                assert_eq!(session_id, "s1");
                assert_eq!(name.as_deref(), Some("日历"));
                assert_eq!(bundle_id, None);
            }
            _ => panic!("wrong variant"),
        }
        let request: ComputerCommandRequest =
            serde_json::from_str(r#"{"action":"clickAt","sessionId":"s1","x":10.5,"y":20.0,"button":"right","clicks":2}"#)
                .expect("deserialize clickAt");
        match request {
            ComputerCommandRequest::ClickAt { x, y, button, clicks, .. } => {
                assert_eq!(x, 10.5);
                assert_eq!(y, 20.0);
                assert_eq!(button.as_deref(), Some("right"));
                assert_eq!(clicks, Some(2));
            }
            _ => panic!("wrong variant"),
        }
        let request: ComputerCommandRequest =
            serde_json::from_str(r#"{"action":"setValue","sessionId":"s1","stateToken":"123:7","elementId":45,"text":"hi"}"#)
                .expect("deserialize setValue");
        assert!(matches!(request, ComputerCommandRequest::SetValue { .. }));
        let request: ComputerCommandRequest =
            serde_json::from_str(r#"{"action":"pressKey","sessionId":"s1","key":"enter","modifiers":["cmd"]}"#)
                .expect("deserialize pressKey");
        assert!(matches!(request, ComputerCommandRequest::PressKey { .. }));

        let response = serde_json::to_value(ComputerCommandResponse::Status {
            accessibility: true,
            screen_recording: false,
            grants: vec![ComputerGrantInfo {
                session_id: "s1".into(),
                pid: 42,
                app_name: "备忘录".into(),
            }],
            allowlist: vec![ComputerAllowedApp {
                bundle_id: "com.apple.Notes".into(),
                name: "备忘录".into(),
            }],
        })
        .expect("serialize status");
        assert_eq!(response.get("type").and_then(|v| v.as_str()), Some("status"));
        assert_eq!(response.pointer("/grants/0/appName").and_then(|v| v.as_str()), Some("备忘录"));
        assert_eq!(response.pointer("/allowlist/0/bundleId").and_then(|v| v.as_str()), Some("com.apple.Notes"));
        let response = serde_json::to_value(ComputerCommandResponse::State {
            state_token: "123:7".into(),
            app: ComputerAppInfo {
                pid: 123,
                bundle_id: None,
                name: "App".into(),
                frontmost: true,
            },
            tree: "- [eid=1] application \"App\"".into(),
            truncated: false,
            screenshot: None,
        })
        .expect("serialize state");
        assert_eq!(response.get("type").and_then(|v| v.as_str()), Some("state"));
        assert!(response.get("screenshot").is_none(), "skip_serializing_if 生效");
    }

    #[test]
    fn key_and_modifier_matrix() {
        assert_eq!(named_key_virtual_code("Enter"), Some(36));
        assert_eq!(named_key_virtual_code("return"), Some(36));
        assert_eq!(named_key_virtual_code("ArrowDown"), Some(125));
        assert_eq!(named_key_virtual_code("F5"), Some(96));
        assert_eq!(named_key_virtual_code("Space"), Some(49));
        assert_eq!(named_key_virtual_code("a"), None, "单字符走 Unicode 注入");
        assert_eq!(named_key_virtual_code("ctrl+alt+del"), None);
        assert_eq!(modifier_definition("cmd"), Some((CG_FLAG_CMD, 55)));
        assert_eq!(modifier_definition("option"), Some((CG_FLAG_ALT, 58)));
        assert_eq!(modifier_definition("shift"), Some((CG_FLAG_SHIFT, 56)));
        assert_eq!(modifier_definition("win"), None);
    }

    #[test]
    fn chunk_utf16_splits_on_pair_boundaries() {
        assert!(chunk_utf16("").is_empty());
        assert_eq!(chunk_utf16("hello"), vec![vec![0x68, 0x65, 0x6C, 0x6C, 0x6F]]);
        // 25 个 ASCII：20 + 5。
        let chunks = chunk_utf16(&"a".repeat(25));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 20);
        assert_eq!(chunks[1].len(), 5);
        // 21 个 BMP CJK（每字 1 码元）：20 + 1。
        let chunks = chunk_utf16(&"中".repeat(21));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 20);
        // 第 20 个是高代理（增补平面字符 U+20000）：块尾前移，代理对完整落在第二块。
        let supplementary: String = "前".repeat(19);
        let text = format!("{supplementary}\u{20000}");
        let units: Vec<u16> = text.encode_utf16().collect();
        assert_eq!(units.len(), 21, "19 BMP + 2 码元代理对");
        let chunks = chunk_utf16(&text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 19);
        assert_eq!(chunks[1], vec![0xD840, 0xDC00]);
        // 全增补平面：每块 20 码元 = 10 字符，块内代理对完整。
        let text: String = (0..25).map(|i| char::from_u32(0x20000 + i).unwrap()).collect();
        for chunk in chunk_utf16(&text) {
            assert!(chunk.len() <= 20);
            assert_eq!(chunk.len() % 2, 0, "代理对不得拆开");
        }
    }

    #[test]
    fn gate_decision_matrix() {
        let allowlist = vec![
            ComputerAllowedApp { bundle_id: "com.apple.Notes".into(), name: "备忘录".into() },
            ComputerAllowedApp { bundle_id: "名字键".into(), name: "本地应用".into() },
        ];
        let mut grants: HashMap<(String, i32), String> = HashMap::new();
        grants.insert(("s1".into(), 100), "已授权应用".into());

        assert_eq!(
            gate_decision(&allowlist, &grants, "s1", 50, Some("com.apple.Notes"), "任意名"),
            GateDecision::Pass { via_allowlist: true }
        );
        assert_eq!(
            gate_decision(&allowlist, &grants, "s1", 100, None, "已授权应用"),
            GateDecision::Pass { via_allowlist: false }
        );
        // bundleId 不匹配时不得误用 allowlist 的名字键兜底（防伪造）。
        assert_eq!(
            gate_decision(&allowlist, &grants, "s2", 50, Some("com.other.App"), "备忘录"),
            GateDecision::NeedDialog
        );
        // 无 bundleId 的 app 以名字为键。
        assert_eq!(
            gate_decision(&allowlist, &grants, "s2", 60, None, "本地应用"),
            GateDecision::Pass { via_allowlist: true }
        );
        assert_eq!(
            gate_decision(&allowlist, &grants, "s2", 70, Some("com.unknown"), "陌生应用"),
            GateDecision::NeedDialog
        );
        // 会话授权与 allowlist 无关：另一会话同 pid 仍需确认。
        assert_eq!(
            gate_decision(&allowlist, &grants, "s2", 100, None, "已授权应用"),
            GateDecision::NeedDialog
        );
    }

    #[test]
    fn state_token_parse_and_stale_snapshot() {
        assert_eq!(parse_state_token("123:7"), Ok((123, 7)));
        assert!(parse_state_token("123").is_err());
        assert!(parse_state_token("abc:7").is_err());

        let state = ComputerSessionState::default();
        let token = store_snapshot(&state, 321, HashMap::new()).expect("store");
        assert_eq!(parse_state_token(&token), Ok((321, 0)), "计数器从 0 起");
        let second = store_snapshot(&state, 321, HashMap::new()).expect("store");
        assert_ne!(token, second, "代际号单调递增");
        // 空注册表：元素必不存在，错误消息引导重新 state。
        let missing = take_snapshot_element(&state, &second, 99);
        let error = match missing {
            Ok(_) => panic!("空注册表不应命中元素"),
            Err(error) => error,
        };
        assert!(error.contains("重新执行 state"), "{error}");
        let stale = take_snapshot_element(&state, &token, 1);
        assert!(stale.is_err());
    }

    /// 回归：AXIsProcessTrustedWithOptions 的 options 必须是合法字典。传 NULL
    /// 在 macOS 26 的 HIServices 内部直接 CFGetTypeID(NULL) 段错误（真机崩溃
    /// 报告 Thread 7）；本用例在开发机上真跑探测锁住该行为。
    #[test]
    fn accessibility_probe_does_not_crash() {
        let _ = accessibility_trusted();
    }

    /// 系统设置深链：每个隐私面板两条候选 URL（macOS 13+ 新 schema 在前，
    /// macOS 12- 旧 schema 兜底）。
    #[test]
    fn system_settings_urls_cover_both_panels() {
        let accessibility = system_settings_urls(ComputerAccessKind::Accessibility);
        assert_eq!(
            accessibility[0],
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"
        );
        assert_eq!(
            accessibility[1],
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        let screen = system_settings_urls(ComputerAccessKind::ScreenRecording);
        assert_eq!(
            screen[0],
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture"
        );
        assert_eq!(
            screen[1],
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
    }

    #[test]
    fn allowlist_file_round_trip() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        assert!(load_allowed_apps(root).is_empty());
        let apps = vec![ComputerAllowedApp {
            bundle_id: "com.example.app".into(),
            name: "示例".into(),
        }];
        save_allowed_apps(root, &apps).expect("save");
        let loaded = load_allowed_apps(root);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].bundle_id, "com.example.app");
        // 损坏载荷 fail-safe 回退空表。
        std::fs::write(allowed_apps_path(root), "{not-json").expect("corrupt");
        assert!(load_allowed_apps(root).is_empty());
    }
}
