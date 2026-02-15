//! 工具压缩模块
//!
//! 当工具定义总大小超过目标阈值时，动态压缩工具 payload 以防止 Kiro API 500 错误。
//! 压缩策略：
//! 1. 简化 input_schema（仅保留 type/enum/required）
//! 2. 按比例压缩 description（最小 50 字符）

use crate::kiro::model::requests::tool::{InputSchema, Tool, ToolSpecification};

/// 工具压缩目标大小（20KB）
const TOOL_COMPRESSION_TARGET_SIZE: usize = 20 * 1024;

/// 压缩后描述最小长度
const MIN_TOOL_DESCRIPTION_LENGTH: usize = 50;

/// 计算工具列表的 JSON 序列化大小
fn calculate_tools_size(tools: &[Tool]) -> usize {
    serde_json::to_string(tools).map(|s| s.len()).unwrap_or(0)
}

/// 简化 input_schema，仅保留 type/enum/required/properties/items 等必要字段
fn simplify_input_schema(schema: &serde_json::Value) -> serde_json::Value {
    match schema {
        serde_json::Value::Object(map) => {
            let mut simplified = serde_json::Map::new();

            // 保留必要字段
            for key in &["type", "enum", "required"] {
                if let Some(v) = map.get(*key) {
                    simplified.insert(key.to_string(), v.clone());
                }
            }

            // 递归处理 properties
            if let Some(serde_json::Value::Object(props)) = map.get("properties") {
                let mut simplified_props = serde_json::Map::new();
                for (key, value) in props {
                    simplified_props.insert(key.clone(), simplify_input_schema(value));
                }
                simplified.insert(
                    "properties".to_string(),
                    serde_json::Value::Object(simplified_props),
                );
            }

            // 处理 items（数组类型）
            if let Some(items) = map.get("items") {
                simplified.insert("items".to_string(), simplify_input_schema(items));
            }

            // 处理 additionalProperties
            if let Some(ap) = map.get("additionalProperties") {
                simplified.insert(
                    "additionalProperties".to_string(),
                    simplify_input_schema(ap),
                );
            }

            // 处理 anyOf/oneOf/allOf
            for key in &["anyOf", "oneOf", "allOf"] {
                if let Some(serde_json::Value::Array(arr)) = map.get(*key) {
                    let simplified_arr: Vec<serde_json::Value> =
                        arr.iter().map(simplify_input_schema).collect();
                    simplified.insert(key.to_string(), serde_json::Value::Array(simplified_arr));
                }
            }

            serde_json::Value::Object(simplified)
        }
        other => other.clone(),
    }
}

/// 压缩工具描述到目标长度（UTF-8 安全截断）
fn compress_description(description: &str, target_length: usize) -> String {
    let target = target_length.max(MIN_TOOL_DESCRIPTION_LENGTH);

    if description.len() <= target {
        return description.to_string();
    }

    let trunc_len = target.saturating_sub(3); // 留空间给 "..."

    // 找到有效的 UTF-8 字符边界
    let safe_len = description
        .char_indices()
        .take_while(|(i, _)| *i < trunc_len)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);

    if safe_len == 0 {
        return description
            .chars()
            .take(MIN_TOOL_DESCRIPTION_LENGTH)
            .collect();
    }

    format!("{}...", &description[..safe_len])
}

/// 如果工具总大小超过阈值则压缩
///
pub fn compress_tools_if_needed(tools: &[Tool]) -> (Vec<Tool>, Option<(usize, usize)>) {
    if tools.is_empty() {
        return (tools.to_vec(), None);
    }

    let original_size = calculate_tools_size(tools);
    if original_size <= TOOL_COMPRESSION_TARGET_SIZE {
        return (tools.to_vec(), None);
    }

    // 第一步：简化 input_schema
    let mut compressed: Vec<Tool> = tools
        .iter()
        .map(|t| {
            let simplified_schema = simplify_input_schema(&t.tool_specification.input_schema.json);
            Tool {
                tool_specification: ToolSpecification {
                    name: t.tool_specification.name.clone(),
                    description: t.tool_specification.description.clone(),
                    input_schema: InputSchema {
                        json: simplified_schema,
                    },
                },
            }
        })
        .collect();

    let size_after_schema = calculate_tools_size(&compressed);
    if size_after_schema <= TOOL_COMPRESSION_TARGET_SIZE {
        return (compressed, Some((original_size, size_after_schema)));
    }

    // 第二步：按比例压缩 description
    let size_to_reduce = size_after_schema - TOOL_COMPRESSION_TARGET_SIZE;
    let total_desc_len: usize = compressed
        .iter()
        .map(|t| t.tool_specification.description.len())
        .sum();

    if total_desc_len > 0 {
        let keep_ratio = 1.0 - (size_to_reduce as f64 / total_desc_len as f64);
        let keep_ratio = keep_ratio.clamp(0.0, 1.0);

        for tool in &mut compressed {
            let desc = &tool.tool_specification.description;
            let target_len = (desc.len() as f64 * keep_ratio) as usize;
            tool.tool_specification.description = compress_description(desc, target_len);
        }
    }

    let final_size = calculate_tools_size(&compressed);
    (compressed, Some((original_size, final_size)))
}

/// 描述提升阈值（单个工具描述超过此长度时提升到 system prompt）
const TOOL_DESCRIPTION_ELEVATE_THRESHOLD: usize = 10000;

/// 将超长工具描述提升到 system prompt（KiroGate 方案）
///
pub fn elevate_long_descriptions(tools: &[Tool]) -> (Vec<Tool>, String, usize) {
    if tools.is_empty() {
        return (tools.to_vec(), String::new(), 0);
    }

    let mut processed_tools = Vec::new();
    let mut doc_parts: Vec<String> = Vec::new();

    for tool in tools {
        let desc = &tool.tool_specification.description;
        if desc.len() <= TOOL_DESCRIPTION_ELEVATE_THRESHOLD {
            processed_tools.push(tool.clone());
        } else {
            let tool_name = &tool.tool_specification.name;
            tracing::debug!(
                "工具 '{}' 描述过长 ({} 字符 > {} 阈值)，提升到 system prompt",
                tool_name,
                desc.len(),
                TOOL_DESCRIPTION_ELEVATE_THRESHOLD
            );

            doc_parts.push(format!("## Tool: {}\n\n{}", tool_name, desc));

            processed_tools.push(Tool {
                tool_specification: ToolSpecification {
                    name: tool_name.clone(),
                    description: format!(
                        "[Full documentation in system prompt under '## Tool: {}']",
                        tool_name
                    ),
                    input_schema: tool.tool_specification.input_schema.clone(),
                },
            });
        }
    }

    let documentation = if doc_parts.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n---\n# Tool Documentation\nThe following tools have detailed documentation that couldn't fit in the tool definition.\n\n{}\n",
            doc_parts.join("\n\n---\n\n")
        )
    };

    (processed_tools, documentation, doc_parts.len())
}
