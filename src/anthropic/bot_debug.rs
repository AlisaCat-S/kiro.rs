//! Bot 模型调试模块
//!
//! 当使用 -bot 后缀模型时，将发送给后端的原始请求和后端返回的原始响应
//! 保存到 `bot_debug/` 目录，用于排查系统提示词注入是否生效。

use tokio::fs;
use chrono::Local;

const DEBUG_DIR: &str = "bot_debug";

/// 确保 bot_debug 目录存在
async fn ensure_dir() {
    let _ = fs::create_dir_all(DEBUG_DIR).await;
}

/// 生成带时间戳的文件名前缀
fn timestamp_prefix() -> String {
    Local::now().format("%Y%m%d_%H%M%S_%3f").to_string()
}

/// 保存请求体到 debug 目录（美化 JSON）
pub async fn dump_request(model: &str, request_body: &str) {
    ensure_dir().await;
    let ts = timestamp_prefix();
    let safe_model = model.replace('/', "_").replace('\\', "_");
    let filename = format!("{}/{}_{}_request.json", DEBUG_DIR, ts, safe_model);

    // 尝试美化 JSON，失败则原样保存
    let content = match serde_json::from_str::<serde_json::Value>(request_body) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| request_body.to_string()),
        Err(_) => request_body.to_string(),
    };

    match fs::write(&filename, &content).await {
        Ok(_) => tracing::info!("[bot_debug] 请求已保存: {}", filename),
        Err(e) => tracing::warn!("[bot_debug] 保存请求失败: {} - {}", filename, e),
    }
}

/// 保存响应事件到 debug 目录
/// events 是收集到的原始 Kiro 事件 JSON 列表
#[allow(dead_code)]
pub async fn dump_response(model: &str, events: &[String]) {
    ensure_dir().await;
    let ts = timestamp_prefix();
    let safe_model = model.replace('/', "_").replace('\\', "_");
    let filename = format!("{}/{}_{}_response.jsonl", DEBUG_DIR, ts, safe_model);

    let content = events.join("\n");

    match fs::write(&filename, &content).await {
        Ok(_) => tracing::info!("[bot_debug] 响应已保存: {} ({} 事件)", filename, events.len()),
        Err(e) => tracing::warn!("[bot_debug] 保存响应失败: {} - {}", filename, e),
    }
}

/// 保存单次完整的请求-响应对（非流式用）
#[allow(dead_code)]
pub async fn dump_non_stream_response(model: &str, response_body: &str) {
    ensure_dir().await;
    let ts = timestamp_prefix();
    let safe_model = model.replace('/', "_").replace('\\', "_");
    let filename = format!("{}/{}_{}_response.json", DEBUG_DIR, ts, safe_model);

    let content = match serde_json::from_str::<serde_json::Value>(response_body) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| response_body.to_string()),
        Err(_) => response_body.to_string(),
    };

    match fs::write(&filename, &content).await {
        Ok(_) => tracing::info!("[bot_debug] 非流式响应已保存: {}", filename),
        Err(e) => tracing::warn!("[bot_debug] 保存非流式响应失败: {} - {}", filename, e),
    }
}
