//! Debug Dump 模块
//!
//! 当 Kiro API 返回 400 Bad Request 时，将发送给后端的完整请求体
//! 保存到 `debug/400BAD/` 目录，用于排查请求格式问题。
//! 当 Debug 开关打开时，成功的请求保存到 `debug/200OK/` 目录。

use tokio::fs;
use chrono::Local;
use std::sync::atomic::{AtomicBool, Ordering};

const BAD_REQUEST_DIR: &str = "debug/400BAD";
const OK_REQUEST_DIR: &str = "debug/200OK";

/// 全局 Debug 开关
static DEBUG_ENABLED: AtomicBool = AtomicBool::new(false);

/// 设置 Debug 开关状态
pub fn set_debug_enabled(enabled: bool) {
    DEBUG_ENABLED.store(enabled, Ordering::Relaxed);
    tracing::info!("[debug_dump] Debug 模式已{}", if enabled { "开启" } else { "关闭" });
}

/// 获取 Debug 开关状态
pub fn is_debug_enabled() -> bool {
    DEBUG_ENABLED.load(Ordering::Relaxed)
}

/// 确保指定目录存在
async fn ensure_dir(dir: &str) {
    let _ = fs::create_dir_all(dir).await;
}

/// 生成带时间戳的文件名前缀
fn timestamp_prefix() -> String {
    Local::now().format("%Y%m%d_%H%M%S_%3f").to_string()
}

/// 从请求体 JSON 中提取 tools 字段并计算序列化后的字节长度
///
/// tools 路径: conversationState.currentMessage.userInputMessage.userInputMessageContext.tools
pub fn calculate_tools_length(request_body: &str) -> usize {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(request_body) else {
        return 0;
    };
    let Some(tools) = v
        .get("conversationState")
        .and_then(|cs| cs.get("currentMessage"))
        .and_then(|cm| cm.get("userInputMessage"))
        .and_then(|uim| uim.get("userInputMessageContext"))
        .and_then(|ctx| ctx.get("tools"))
    else {
        return 0;
    };
    serde_json::to_string(tools).map(|s| s.len()).unwrap_or(0)
}

/// 保存 400 Bad Request 的请求体到 debug/400BAD 目录
pub async fn dump_bad_request(model: &str, request_body: &str, error_msg: &str) {
    ensure_dir(BAD_REQUEST_DIR).await;
    let ts = timestamp_prefix();
    let safe_model = model.replace('/', "_").replace('\\', "_");
    let filename = format!("{}/{}_{}_bad_request.json", BAD_REQUEST_DIR, ts, safe_model);

    // 美化 JSON
    let pretty_body = match serde_json::from_str::<serde_json::Value>(request_body) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| request_body.to_string()),
        Err(_) => request_body.to_string(),
    };

    // 计算 tools 字段长度
    let tools_len = calculate_tools_length(request_body);

    // 在末尾追加 tools 长度信息和错误信息
    let content = format!(
        "{}\n\n// --- debug info ---\n// tools_length: {} bytes\n// error: {}",
        pretty_body, tools_len, error_msg
    );

    match fs::write(&filename, &content).await {
        Ok(_) => tracing::info!("[debug_dump] 400 请求已保存: {}", filename),
        Err(e) => tracing::warn!("[debug_dump] 保存失败: {} - {}", filename, e),
    }
}

/// 保存 200 OK 的请求体到 debug/200OK 目录（仅在 Debug 开关打开时）
pub async fn dump_ok_request(model: &str, request_body: &str) {
    if !is_debug_enabled() {
        return;
    }

    ensure_dir(OK_REQUEST_DIR).await;
    let ts = timestamp_prefix();
    let safe_model = model.replace('/', "_").replace('\\', "_");
    let filename = format!("{}/{}_{}_ok_request.json", OK_REQUEST_DIR, ts, safe_model);

    // 美化 JSON
    let pretty_body = match serde_json::from_str::<serde_json::Value>(request_body) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| request_body.to_string()),
        Err(_) => request_body.to_string(),
    };

    // 计算 tools 字段长度
    let tools_len = calculate_tools_length(request_body);

    // 在末尾追加 tools 长度信息
    let content = format!(
        "{}\n\n// --- debug info ---\n// tools_length: {} bytes",
        pretty_body, tools_len
    );

    match fs::write(&filename, &content).await {
        Ok(_) => tracing::debug!("[debug_dump] 200 请求已保存: {}", filename),
        Err(e) => tracing::warn!("[debug_dump] 保存失败: {} - {}", filename, e),
    }
}

/// 请求各部分的统计信息
#[derive(Debug)]
pub struct RequestStats {
    pub system_bytes: usize,
    pub system_tokens: u64,
    pub messages_bytes: usize,
    pub messages_tokens: u64,
    pub tools_bytes: usize,
    pub tools_tokens: u64,
    pub total_bytes: usize,
    pub total_tokens: u64,
}

/// 分析 Kiro 请求体各部分的大小和 token 数
pub fn analyze_request_parts(request_body: &str) -> Option<RequestStats> {
    let v = serde_json::from_str::<serde_json::Value>(request_body).ok()?;

    // 提取各部分
    let conversation_state = v.get("conversationState")?;
    let current_message = conversation_state.get("currentMessage")?;
    let user_input_message = current_message.get("userInputMessage")?;
    let context = user_input_message.get("userInputMessageContext")?;

    // 1. System prompt
    let system_bytes = context
        .get("systemPrompt")
        .and_then(|sp| serde_json::to_string(sp).ok())
        .map(|s| s.len())
        .unwrap_or(0);
    let system_text = context
        .get("systemPrompt")
        .and_then(|sp| sp.as_str())
        .unwrap_or("");
    let system_tokens = crate::token::count_tokens(system_text);

    // 2. Messages (conversationHistory)
    let messages_bytes = conversation_state
        .get("conversationHistory")
        .and_then(|ch| serde_json::to_string(ch).ok())
        .map(|s| s.len())
        .unwrap_or(0);
    let messages_tokens = conversation_state
        .get("conversationHistory")
        .and_then(|ch| ch.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|msg| msg.get("text").and_then(|t| t.as_str()))
                .map(|text| crate::token::count_tokens(text))
                .sum()
        })
        .unwrap_or(0);

    // 3. Tools
    let tools_bytes = context
        .get("tools")
        .and_then(|t| serde_json::to_string(t).ok())
        .map(|s| s.len())
        .unwrap_or(0);
    let tools_tokens = context
        .get("tools")
        .and_then(|t| serde_json::to_string(t).ok())
        .map(|json_str| crate::token::count_tokens(&json_str))
        .unwrap_or(0);

    // 总计
    let total_bytes = request_body.len();
    let total_tokens = system_tokens + messages_tokens + tools_tokens;

    Some(RequestStats {
        system_bytes,
        system_tokens,
        messages_bytes,
        messages_tokens,
        tools_bytes,
        tools_tokens,
        total_bytes,
        total_tokens,
    })
}
