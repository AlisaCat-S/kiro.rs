//! Debug Dump 模块
//!
//! 当 Kiro API 返回 400 Bad Request 时，将发送给后端的完整请求体
//! 保存到 `debug/` 目录，用于排查请求格式问题。

use tokio::fs;
use chrono::Local;

const DEBUG_DIR: &str = "debug";

/// 确保 debug 目录存在
async fn ensure_dir() {
    let _ = fs::create_dir_all(DEBUG_DIR).await;
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

/// 保存 400 Bad Request 的请求体到 debug 目录
pub async fn dump_bad_request(model: &str, request_body: &str, error_msg: &str) {
    ensure_dir().await;
    let ts = timestamp_prefix();
    let safe_model = model.replace('/', "_").replace('\\', "_");
    let filename = format!("{}/{}_{}_bad_request.json", DEBUG_DIR, ts, safe_model);

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
