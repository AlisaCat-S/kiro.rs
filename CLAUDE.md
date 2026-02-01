# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

kiro-rs 是一个用 Rust 编写的 Anthropic Claude API 兼容代理服务，将 Anthropic API 请求转换为 Kiro API 请求。支持多凭据管理、自动故障转移、流式响应和 Web 管理界面。

**技术栈**: Rust (Axum 0.8 + Tokio) + React 18 + TypeScript + Tailwind CSS

## 常用命令

```bash
# 构建（必须先构建前端）
cd admin-ui && pnpm install && pnpm build
cargo build --release

# 开发运行
cargo run -- -c config.json --credentials credentials.json

# 测试
cargo test

# 代码检查
cargo fmt          # 格式化
cargo clippy       # lint

# 前端开发
cd admin-ui
pnpm install
pnpm dev           # 开发服务器
pnpm build         # 生产构建
```

## 架构概览

```
kiro-rs/
├── src/
│   ├── main.rs                 # 入口、路由配置
│   ├── model/                  # 配置和命令行参数
│   ├── anthropic/              # Anthropic API 兼容层
│   │   ├── router.rs           # 路由配置
│   │   ├── handlers.rs         # 请求处理器
│   │   ├── middleware.rs       # 认证中间件
│   │   ├── types.rs            # 类型定义
│   │   ├── converter.rs        # Anthropic ↔ Kiro 协议转换
│   │   └── stream.rs           # SSE 流式响应处理
│   ├── kiro/                   # Kiro API 客户端
│   │   ├── provider.rs         # API 提供者（核心请求逻辑）
│   │   ├── token_manager.rs    # 多凭据管理、Token 刷新
│   │   ├── machine_id.rs       # 设备指纹生成
│   │   ├── web_portal.rs       # Web Portal API
│   │   ├── model/              # 数据模型（credentials, events, requests）
│   │   └── parser/             # AWS Event Stream 解析器
│   ├── admin/                  # Admin API 模块
│   │   ├── handlers.rs         # API 处理器
│   │   ├── service.rs          # 凭据管理业务逻辑
│   │   └── types.rs            # 类型定义
│   └── admin_ui/               # rust-embed 静态文件嵌入
└── admin-ui/                   # React 前端
```

## 核心设计模式

1. **Provider Pattern** - `kiro/provider.rs`: 统一的 API 提供者接口，处理请求转发和重试
2. **Multi-Token Manager** - `kiro/token_manager.rs`: 多凭据管理，按优先级故障转移，自动刷新 Token
3. **Protocol Converter** - `anthropic/converter.rs`: Anthropic ↔ Kiro 双向协议转换
4. **Event Stream Parser** - `kiro/parser/`: AWS Event Stream 二进制协议解析

## API 端点

**代理端点**:
- `GET /v1/models` - 获取可用模型列表
- `POST /v1/messages` - 创建消息（Anthropic 格式）
- `POST /v1/messages/count_tokens` - Token 计数

**Admin API** (需配置 `adminApiKey`):
- 凭据 CRUD、状态监控

## 重要注意事项

1. **构建顺序**: 必须先构建前端 `admin-ui`，再编译 Rust 后端（静态文件通过 `rust-embed` 嵌入）
2. **凭据格式**: 支持单凭据（向后兼容）和多凭据（数组格式，支持 priority 字段）
3. **重试策略**: 单凭据最多重试 2 次，单请求最多重试 5 次
4. **不支持的工具**: `web_search` 和 `websearch` 会被自动过滤
5. **安全**: 使用 `subtle` 库进行常量时间比较防止时序攻击
