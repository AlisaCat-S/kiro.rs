//! Debug Dump 模块
//!
//! 当 Kiro API 返回 400 Bad Request 时，将发送给后端的完整请求体
//! 保存到 `debug/400BAD/` 目录，用于排查请求格式问题。
//! 当 Debug 开关打开时，成功的请求保存到 `debug/200OK/` 目录。

use chrono::Local;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::fs;

const BAD_REQUEST_DIR: &str = "debug/400BAD";
const OK_REQUEST_DIR: &str = "debug/200OK";

/// 全局 Debug 开关
static DEBUG_ENABLED: AtomicBool = AtomicBool::new(false);

/// 设置 Debug 开关状态
pub fn set_debug_enabled(enabled: bool) {
    DEBUG_ENABLED.store(enabled, Ordering::Relaxed);
    tracing::info!(
        "[debug_dump] Debug 模式已{}",
        if enabled { "开启" } else { "关闭" }
    );
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

    let tools_len = calculate_tools_length(request_body);

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

    let pretty_body = match serde_json::from_str::<serde_json::Value>(request_body) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| request_body.to_string()),
        Err(_) => request_body.to_string(),
    };

    let tools_len = calculate_tools_length(request_body);

    let content = format!(
        "{}\n\n// --- debug info ---\n// tools_length: {} bytes",
        pretty_body, tools_len
    );

    match fs::write(&filename, &content).await {
        Ok(_) => tracing::debug!("[debug_dump] 200 请求已保存: {}", filename),
        Err(e) => tracing::warn!("[debug_dump] 保存失败: {} - {}", filename, e),
    }
}
