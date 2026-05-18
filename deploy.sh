#!/bin/bash
set -e

# ============================================================
# kiro-rs 一键部署脚本
#
# 关键约束（AI 部署时务必遵守）：
#   1. credentials.json 必须是 JSON 数组格式 []，不能是单对象 {}
#      - 只有数组格式程序才会回写持久化，单对象格式导入的凭据重启后丢失
#      - 初始部署时使用空数组 [] 即可，之后通过 Admin API 导入凭据
#   2. config.json 中 default_endpoint 必须是 "ide"（唯一已注册的端点名）
#   3. 端口固定 8990，容器内监听 0.0.0.0:8990
#   4. 凭据通过 Admin API 管理（/api/admin/credentials），不要手动编辑文件
#   5. admin_api_key 是管理接口的认证密钥，必须修改默认值
# ============================================================

INSTALL_DIR="/opt/kirors"
IMAGE="ghcr.io/eyre921/kiro-rs:latest"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

check_root() {
    if [ "$EUID" -ne 0 ]; then
        error "请使用 root 权限运行: sudo bash deploy.sh"
    fi
}

check_docker() {
    if ! command -v docker &>/dev/null; then
        error "未检测到 docker，请先安装 Docker"
    fi
    if ! docker compose version &>/dev/null; then
        error "未检测到 docker compose 插件，请升级 Docker 或安装 compose 插件"
    fi
}

cmd_install() {
    check_root
    check_docker

    info "创建部署目录: $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR/config"

    if [ ! -f "$INSTALL_DIR/config/config.json" ]; then
        info "生成配置模板: config/config.json"
        cat > "$INSTALL_DIR/config/config.json" << 'EOF'
{
  "listen": "0.0.0.0:8990",
  "admin_api_key": "CHANGE_ME_TO_A_STRONG_KEY",
  "default_endpoint": "ide",
  "endpoints": {
    "ide": {
      "type": "ide",
      "region": "us-east-1",
      "load_balance": "priority"
    }
  }
}
EOF
    else
        warn "config.json 已存在，跳过"
    fi

    if [ ! -f "$INSTALL_DIR/config/credentials.json" ]; then
        info "生成凭证模板: config/credentials.json"
        cat > "$INSTALL_DIR/config/credentials.json" << 'EOF'
[]
EOF
        info "凭证文件已初始化为空数组，请通过 Admin API 导入凭据"
    else
        warn "credentials.json 已存在，跳过"
    fi

    info "生成 docker-compose.yml"
    cat > "$COMPOSE_FILE" << EOF
services:
  kiro-rs:
    image: ${IMAGE}
    container_name: kirors
    restart: unless-stopped
    ports:
      - "8990:8990"
    volumes:
      - ./config:/app/config
    environment:
      - TZ=Asia/Shanghai
EOF

    cat > "$INSTALL_DIR/kirors" << 'SCRIPT'
#!/bin/bash
set -e
cd /opt/kirors
case "${1:-help}" in
    start)   docker compose up -d ;;
    stop)    docker compose down ;;
    restart) docker compose restart ;;
    update)  docker compose pull && docker compose up -d ;;
    logs)    docker compose logs -f --tail=${2:-100} ;;
    status)  docker compose ps ;;
    *)
        echo "用法: kirors {start|stop|restart|update|logs|status}"
        echo "  start   - 启动服务"
        echo "  stop    - 停止服务"
        echo "  restart - 重启服务"
        echo "  update  - 拉取最新镜像并重启"
        echo "  logs    - 查看日志 (可选: kirors logs 200)"
        echo "  status  - 查看运行状态"
        ;;
esac
SCRIPT
    chmod +x "$INSTALL_DIR/kirors"
    ln -sf "$INSTALL_DIR/kirors" /usr/local/bin/kirors

    info "拉取最新镜像..."
    docker pull "$IMAGE"

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  安装完成！${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "部署目录: $INSTALL_DIR"
    echo "配置文件: $INSTALL_DIR/config/config.json"
    echo "凭证文件: $INSTALL_DIR/config/credentials.json"
    echo ""
    echo -e "${YELLOW}下一步:${NC}"
    echo "  1. 编辑配置: nano $INSTALL_DIR/config/config.json"
    echo "  2. 添加凭证: nano $INSTALL_DIR/config/credentials.json"
    echo "  3. 启动服务: kirors start"
    echo ""
    echo "管理命令: kirors {start|stop|restart|update|logs|status}"
}

cmd_update() {
    check_root
    check_docker
    if [ ! -f "$COMPOSE_FILE" ]; then
        error "未找到安装，请先运行: sudo bash deploy.sh install"
    fi
    info "拉取最新镜像..."
    cd "$INSTALL_DIR"
    docker compose pull
    info "重启服务..."
    docker compose up -d
    info "更新完成！"
    docker compose ps
}

cmd_uninstall() {
    check_root
    echo -e "${RED}警告: 这将停止服务并删除 $INSTALL_DIR（配置文件会保留备份）${NC}"
    read -p "确认卸载? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "已取消"
        exit 0
    fi
    cd "$INSTALL_DIR" 2>/dev/null && docker compose down 2>/dev/null || true
    cp -r "$INSTALL_DIR/config" "/tmp/kirors-config-backup-$(date +%s)" 2>/dev/null || true
    rm -rf "$INSTALL_DIR"
    rm -f /usr/local/bin/kirors
    info "已卸载，配置备份在 /tmp/kirors-config-backup-*"
}

case "${1:-install}" in
    install)   cmd_install ;;
    update)    cmd_update ;;
    uninstall) cmd_uninstall ;;
    *)
        echo "用法: bash deploy.sh {install|update|uninstall}"
        echo "  install   - 首次安装部署"
        echo "  update    - 更新到最新版本"
        echo "  uninstall - 卸载（保留配置备份）"
        ;;
esac
