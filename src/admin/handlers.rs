//! Admin API HTTP 处理器

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};

use super::{
    middleware::AdminState,
    types::{
        AddCredentialRequest, SetDisabledRequest, SetLoadBalancingModeRequest,
        SetPriorityRequest, SetToolCompressionModeRequest, SuccessResponse,
    },
};

/// GET /api/admin/credentials
/// 获取所有凭据状态
pub async fn get_all_credentials(State(state): State<AdminState>) -> impl IntoResponse {
    let response = state.service.get_all_credentials();
    Json(response)
}

/// POST /api/admin/credentials/:id/disabled
/// 设置凭据禁用状态
pub async fn set_credential_disabled(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Json(payload): Json<SetDisabledRequest>,
) -> impl IntoResponse {
    match state.service.set_disabled(id, payload.disabled) {
        Ok(_) => {
            let action = if payload.disabled { "禁用" } else { "启用" };
            Json(SuccessResponse::new(format!("凭据 #{} 已{}", id, action))).into_response()
        }
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/priority
/// 设置凭据优先级
pub async fn set_credential_priority(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Json(payload): Json<SetPriorityRequest>,
) -> impl IntoResponse {
    match state.service.set_priority(id, payload.priority) {
        Ok(_) => Json(SuccessResponse::new(format!(
            "凭据 #{} 优先级已设置为 {}",
            id, payload.priority
        )))
        .into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/reset
/// 重置失败计数并重新启用
pub async fn reset_failure_count(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    match state.service.reset_and_enable(id) {
        Ok(_) => Json(SuccessResponse::new(format!(
            "凭据 #{} 失败计数已重置并重新启用",
            id
        )))
        .into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// GET /api/admin/credentials/:id/balance
/// 获取指定凭据的余额
pub async fn get_credential_balance(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    match state.service.get_balance(id).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials
/// 添加新凭据
pub async fn add_credential(
    State(state): State<AdminState>,
    Json(payload): Json<AddCredentialRequest>,
) -> impl IntoResponse {
    match state.service.add_credential(payload).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// DELETE /api/admin/credentials/:id
/// 删除凭据
pub async fn delete_credential(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    match state.service.delete_credential(id) {
        Ok(_) => Json(SuccessResponse::new(format!("凭据 #{} 已删除", id))).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// GET /api/admin/config/load-balancing
/// 获取负载均衡模式
pub async fn get_load_balancing_mode(State(state): State<AdminState>) -> impl IntoResponse {
    let response = state.service.get_load_balancing_mode();
    Json(response)
}

/// PUT /api/admin/config/load-balancing
/// 设置负载均衡模式
pub async fn set_load_balancing_mode(
    State(state): State<AdminState>,
    Json(payload): Json<SetLoadBalancingModeRequest>,
) -> impl IntoResponse {
    match state.service.set_load_balancing_mode(payload) {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// GET /api/admin/config/tool-compression
/// 获取工具压缩模式
pub async fn get_tool_compression_mode(State(state): State<AdminState>) -> impl IntoResponse {
    let response = state.service.get_tool_compression_mode();
    Json(response)
}

/// PUT /api/admin/config/tool-compression
/// 设置工具压缩模式
pub async fn set_tool_compression_mode(
    State(state): State<AdminState>,
    Json(payload): Json<SetToolCompressionModeRequest>,
) -> impl IntoResponse {
    match state.service.set_tool_compression_mode(payload) {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// GET /api/admin/config/tools-list
/// 请求 MCP tools/list 并返回结果
pub async fn get_tools_list(State(state): State<AdminState>) -> impl IntoResponse {
    let provider = match &state.kiro_provider {
        Some(p) => p.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "KiroProvider 未配置"})),
            )
                .into_response();
        }
    };

    let mcp_request = serde_json::json!({
        "id": "tools_list",
        "jsonrpc": "2.0",
        "method": "tools/list"
    });

    let request_body = serde_json::to_string(&mcp_request).unwrap();

    match provider.call_mcp(&request_body).await {
        Ok(response) => match response.text().await {
            Ok(body) => match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(json) => Json(json).into_response(),
                Err(_) => Json(serde_json::json!({"raw": body})).into_response(),
            },
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("读取响应失败: {}", e)})),
            )
                .into_response(),
        },
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": format!("MCP 请求失败: {}", e)})),
        )
            .into_response(),
    }
}

/// GET /api/admin/config/debug-mode
/// 获取 Debug 开关状态
pub async fn get_debug_mode() -> impl IntoResponse {
    let enabled = crate::anthropic::debug_dump::is_debug_enabled();
    Json(serde_json::json!({"enabled": enabled})).into_response()
}

/// PUT /api/admin/config/debug-mode
/// 设置 Debug 开关状态
pub async fn set_debug_mode(
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let enabled = payload
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    crate::anthropic::debug_dump::set_debug_enabled(enabled);

    Json(serde_json::json!({"enabled": enabled})).into_response()
}
