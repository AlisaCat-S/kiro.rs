#!/usr/bin/env python3
"""
离线分析上下文压缩管道表现。

从 Docker 日志中提取压缩相关的 tracing 结构化数据，
生成汇总报告，帮助评估五层压缩管道的实际效果。

使用方法：
  python3 tools/analyze_compression.py logs/docker.log
  python3 tools/analyze_compression.py --top 10 logs/docker.log
  python3 tools/analyze_compression.py --csv output.csv logs/docker.log
  python3 tools/analyze_compression.py --json logs/docker.log
  cat logs/docker.log | python3 tools/analyze_compression.py -
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Sequence


# ---------------------------------------------------------------------------
# ANSI 清理（复用 diagnose_improper_request.py 的模式）
# ---------------------------------------------------------------------------

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def strip_ansi(s: str) -> str:
    return ANSI_RE.sub("", s)


# ---------------------------------------------------------------------------
# 时间戳提取
# ---------------------------------------------------------------------------

# ISO 8601 时间戳（行首），兼容带/不带时区
TIMESTAMP_RE = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})")


def extract_timestamp(line: str) -> Optional[str]:
    """提取行首 ISO 时间戳，返回秒级精度字符串或 None。"""
    m = TIMESTAMP_RE.search(line[:40])
    return m.group(1) if m else None


def hour_bucket(ts: str) -> str:
    """截取到小时：2025-01-15T10:23:45 -> 2025-01-15T10"""
    return ts[:13]


# ---------------------------------------------------------------------------
# tracing key=value 解析
# ---------------------------------------------------------------------------

KV_RE = re.compile(r"(\w+)=(\d+(?:\.\d+)?|\"[^\"]*\"|[^\s,]+)")


def parse_kv(line: str) -> Dict[str, str]:
    """从 tracing 结构化行中提取所有 key=value 对。"""
    return {m.group(1): m.group(2).strip('"') for m in KV_RE.finditer(line)}


def kv_int(kv: Dict[str, str], key: str, default: int = 0) -> int:
    v = kv.get(key)
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        return default


def kv_float(kv: Dict[str, str], key: str, default: float = 0.0) -> float:
    v = kv.get(key)
    if v is None:
        return default
    try:
        return float(v)
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------


@dataclass
class RequestRecord:
    """一次请求行的数据。"""
    line_no: int
    timestamp: Optional[str] = None
    model: str = ""
    max_tokens: int = 0
    stream: bool = True
    message_count: int = 0
    estimated_input_tokens: int = 0


@dataclass
class CompressionRecord:
    """一次压缩统计行的数据。"""
    line_no: int
    timestamp: Optional[str] = None
    estimated_input_tokens: int = 0
    bytes_saved_total: int = 0
    whitespace_bytes_saved: int = 0
    thinking_bytes_saved: int = 0
    tool_result_bytes_saved: int = 0
    tool_use_input_bytes_saved: int = 0
    history_turns_removed: int = 0
    history_bytes_saved: int = 0


@dataclass
class ContextUsageRecord:
    """contextUsageEvent 行的数据。"""
    line_no: int
    context_usage_percentage: float = 0.0
    actual_input_tokens: int = 0


@dataclass
class RejectionRecord:
    """上游拒绝行的数据。"""
    line_no: int
    kiro_request_body_bytes: int = 0


@dataclass
class MergedRequest:
    """关联后的完整请求记录。"""
    line_no: int = 0
    timestamp: Optional[str] = None
    model: str = ""
    max_tokens: int = 0
    stream: bool = True
    message_count: int = 0
    estimated_input_tokens: int = 0
    # 压缩统计
    bytes_saved_total: int = 0
    whitespace_bytes_saved: int = 0
    thinking_bytes_saved: int = 0
    tool_result_bytes_saved: int = 0
    tool_use_input_bytes_saved: int = 0
    history_turns_removed: int = 0
    history_bytes_saved: int = 0
    has_compression: bool = False
    # 上下文使用
    context_usage_percentage: Optional[float] = None
    actual_input_tokens: Optional[int] = None
    # 压缩率
    compression_rate: float = 0.0


# ---------------------------------------------------------------------------
# 日志解析
# ---------------------------------------------------------------------------

# 匹配标记
MARKER_REQUEST = "Received POST /v1/messages request"
MARKER_COMPRESSION = "输入压缩完成"
MARKER_CONTEXT_USAGE = "收到 contextUsageEvent"
MARKER_REJECTION = "上游拒绝请求：输入上下文过长"

# contextUsageEvent 格式：收到 contextUsageEvent: 67.2%, 计算 input_tokens: 12345
CONTEXT_USAGE_RE = re.compile(
    r"收到 contextUsageEvent:\s*([\d.]+)%.*?input_tokens:\s*(\d+)"
)


def parse_log(
    lines: Sequence[str],
    *,
    min_tokens: int = 0,
    model_pattern: Optional[str] = None,
) -> tuple[
    list[MergedRequest],
    list[RejectionRecord],
    int,
]:
    """
    解析日志行，返回 (merged_requests, rejections, total_lines)。

    关联策略：连续出现的请求行和压缩统计行，
    基于 estimated_input_tokens 匹配 + 行号邻近（间距 ≤ 50 行）。
    """
    requests: list[RequestRecord] = []
    compressions: list[CompressionRecord] = []
    context_usages: list[ContextUsageRecord] = []
    rejections: list[RejectionRecord] = []

    model_re = re.compile(model_pattern, re.IGNORECASE) if model_pattern else None

    for idx, raw_line in enumerate(lines):
        line_no = idx + 1
        line = strip_ansi(raw_line)

        if MARKER_REQUEST in line:
            kv = parse_kv(line)
            model = kv.get("model", "")
            if model_re and not model_re.search(model):
                continue
            est = kv_int(kv, "estimated_input_tokens")
            if est < min_tokens:
                continue
            requests.append(RequestRecord(
                line_no=line_no,
                timestamp=extract_timestamp(line),
                model=model,
                max_tokens=kv_int(kv, "max_tokens"),
                stream=kv.get("stream", "true") == "true",
                message_count=kv_int(kv, "message_count"),
                estimated_input_tokens=est,
            ))

        elif MARKER_COMPRESSION in line:
            kv = parse_kv(line)
            est = kv_int(kv, "estimated_input_tokens")
            if est < min_tokens:
                continue
            compressions.append(CompressionRecord(
                line_no=line_no,
                timestamp=extract_timestamp(line),
                estimated_input_tokens=est,
                bytes_saved_total=kv_int(kv, "bytes_saved_total"),
                whitespace_bytes_saved=kv_int(kv, "whitespace_bytes_saved"),
                thinking_bytes_saved=kv_int(kv, "thinking_bytes_saved"),
                tool_result_bytes_saved=kv_int(kv, "tool_result_bytes_saved"),
                tool_use_input_bytes_saved=kv_int(kv, "tool_use_input_bytes_saved"),
                history_turns_removed=kv_int(kv, "history_turns_removed"),
                history_bytes_saved=kv_int(kv, "history_bytes_saved"),
            ))

        elif MARKER_CONTEXT_USAGE in line:
            m = CONTEXT_USAGE_RE.search(line)
            if m:
                context_usages.append(ContextUsageRecord(
                    line_no=line_no,
                    context_usage_percentage=float(m.group(1)),
                    actual_input_tokens=int(m.group(2)),
                ))

        elif MARKER_REJECTION in line:
            kv = parse_kv(line)
            rejections.append(RejectionRecord(
                line_no=line_no,
                kiro_request_body_bytes=kv_int(kv, "kiro_request_body_bytes"),
            ))

    # --- 关联请求行与压缩统计行 ---
    merged = _merge_records(requests, compressions, context_usages)

    return merged, rejections, len(lines)


def _merge_records(
    requests: list[RequestRecord],
    compressions: list[CompressionRecord],
    context_usages: list[ContextUsageRecord],
) -> list[MergedRequest]:
    """
    关联请求行与压缩统计行。

    策略：对每个请求行，在其后 50 行内查找 estimated_input_tokens 相同的压缩统计行。
    """
    merged: list[MergedRequest] = []
    used_comp_indices: set[int] = set()
    used_ctx_indices: set[int] = set()

    for req in requests:
        mr = MergedRequest(
            line_no=req.line_no,
            timestamp=req.timestamp,
            model=req.model,
            max_tokens=req.max_tokens,
            stream=req.stream,
            message_count=req.message_count,
            estimated_input_tokens=req.estimated_input_tokens,
        )

        # 查找匹配的压缩统计行
        for ci, comp in enumerate(compressions):
            if ci in used_comp_indices:
                continue
            # 行号邻近（压缩行在请求行之后 50 行内）
            if not (0 < comp.line_no - req.line_no <= 50):
                continue
            # estimated_input_tokens 匹配
            if comp.estimated_input_tokens != req.estimated_input_tokens:
                continue
            # 匹配成功
            mr.bytes_saved_total = comp.bytes_saved_total
            mr.whitespace_bytes_saved = comp.whitespace_bytes_saved
            mr.thinking_bytes_saved = comp.thinking_bytes_saved
            mr.tool_result_bytes_saved = comp.tool_result_bytes_saved
            mr.tool_use_input_bytes_saved = comp.tool_use_input_bytes_saved
            mr.history_turns_removed = comp.history_turns_removed
            mr.history_bytes_saved = comp.history_bytes_saved
            mr.has_compression = True
            used_comp_indices.add(ci)
            break

        # 查找匹配的 contextUsageEvent（在请求行之后 500 行内）
        for ui, ctx in enumerate(context_usages):
            if ui in used_ctx_indices:
                continue
            if not (0 < ctx.line_no - req.line_no <= 500):
                continue
            mr.context_usage_percentage = ctx.context_usage_percentage
            mr.actual_input_tokens = ctx.actual_input_tokens
            used_ctx_indices.add(ui)
            break

        # 计算压缩率（基于估算 token 数，假设 1 token ≈ 4 bytes）
        if mr.estimated_input_tokens > 0 and mr.bytes_saved_total > 0:
            estimated_bytes = mr.estimated_input_tokens * 4
            mr.compression_rate = mr.bytes_saved_total / estimated_bytes * 100

        merged.append(mr)

    return merged


# ---------------------------------------------------------------------------
# 统计计算
# ---------------------------------------------------------------------------


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    f = int(k)
    c = f + 1 if f + 1 < len(s) else f
    return s[f] + (s[c] - s[f]) * (k - f)


def fmt_bytes(n: int) -> str:
    """格式化字节数为人类可读形式。"""
    if n >= 1_000_000:
        return f"{n:,} ({n / 1_000_000:.1f} MB)"
    if n >= 1_000:
        return f"{n:,} ({n / 1_000:.1f} KB)"
    return f"{n:,}"


# ---------------------------------------------------------------------------
# 报告生成
# ---------------------------------------------------------------------------


def generate_report(
    merged: list[MergedRequest],
    rejections: list[RejectionRecord],
    total_lines: int,
    *,
    top_n: int = 5,
) -> str:
    """生成文本格式的分析报告。"""
    lines: list[str] = []
    w = lines.append

    w("=== 上下文压缩分析报告 ===")
    w("")
    w(f"扫描行数: {total_lines:,}")
    w(f"匹配请求: {len(merged)}")
    with_comp = [r for r in merged if r.has_compression]
    w(f"有压缩统计: {len(with_comp)}")
    w("")

    if not with_comp:
        w("未找到压缩统计数据。")
        return "\n".join(lines)

    # --- 总体概览 ---
    total_saved = sum(r.bytes_saved_total for r in with_comp)
    avg_saved = total_saved // len(with_comp) if with_comp else 0
    rates = [r.compression_rate for r in with_comp if r.compression_rate > 0]
    median_rate = median(rates)

    w("--- 总体概览 ---")
    w(f"总节省字节: {fmt_bytes(total_saved)}")
    w(f"平均每请求节省: {avg_saved:,} bytes")
    w(f"压缩率中位数: {median_rate:.1f}%")
    w("")

    # --- 各层贡献 ---
    ws_total = sum(r.whitespace_bytes_saved for r in with_comp)
    th_total = sum(r.thinking_bytes_saved for r in with_comp)
    tr_total = sum(r.tool_result_bytes_saved for r in with_comp)
    tu_total = sum(r.tool_use_input_bytes_saved for r in with_comp)
    hi_total = sum(r.history_bytes_saved for r in with_comp)

    def layer_line(name: str, val: int) -> str:
        pct = val / total_saved * 100 if total_saved > 0 else 0
        avg = val // len(with_comp) if with_comp else 0
        return f"  {name:<18}{val:>12,} bytes ({pct:>5.1f}%)  avg {avg:,}/req"

    w("--- 各层贡献 ---")
    w(layer_line("空白压缩:", ws_total))
    w(layer_line("thinking 截断:", th_total))
    w(layer_line("tool_result:", tr_total))
    w(layer_line("tool_use_input:", tu_total))
    w(layer_line("历史截断:", hi_total))
    w("")

    # --- 历史截断详情 ---
    with_history = [r for r in with_comp if r.history_turns_removed > 0]
    w("--- 历史截断详情 ---")
    w(f"触发历史截断的请求: {len(with_history)}/{len(with_comp)} ({len(with_history)/len(with_comp)*100:.1f}%)")
    if with_history:
        turns = [r.history_turns_removed for r in with_history]
        w(f"平均移除轮数: {sum(turns)/len(turns):.1f}")
        w(f"最大移除轮数: {max(turns)}")
    w("")

    # --- 上下文窗口使用 ---
    with_ctx = [r for r in merged if r.context_usage_percentage is not None]
    w("--- 上下文窗口使用 (contextUsageEvent) ---")
    if with_ctx:
        usages = [r.context_usage_percentage for r in with_ctx]
        avg_usage = sum(usages) / len(usages)
        over_80 = sum(1 for u in usages if u > 80)
        over_95 = sum(1 for u in usages if u > 95)
        overflow = sum(1 for u in usages if u >= 100)
        w(f"平均使用率: {avg_usage:.1f}%")
        w(f">80% 使用率的请求: {over_80} ({over_80/len(with_ctx)*100:.1f}%)")
        w(f">95% 使用率的请求: {over_95} ({over_95/len(with_ctx)*100:.1f}%)")
        w(f"100% (溢出): {overflow} ({overflow/len(with_ctx)*100:.1f}%)")
    else:
        w("无 contextUsageEvent 数据（需要 DEBUG 日志级别）")
    w("")

    # --- 上游拒绝 ---
    w("--- 上游拒绝 ---")
    w(f"输入过长拒绝: {len(rejections)} 次")
    w("")

    # --- 高压缩请求 TOP-N ---
    sorted_by_saved = sorted(with_comp, key=lambda r: r.bytes_saved_total, reverse=True)
    w(f"--- 高压缩请求 TOP-{top_n} ---")
    for i, r in enumerate(sorted_by_saved[:top_n], 1):
        w(f"  #{i}  line={r.line_no}  saved={r.bytes_saved_total:,}  rate={r.compression_rate:.1f}%  model={r.model}  tokens={r.estimated_input_tokens:,}")
    w("")

    # --- 低效/无压缩请求样本 ---
    no_comp = [r for r in with_comp if r.bytes_saved_total == 0]
    w("--- 低效/无压缩请求样本 ---")
    if no_comp:
        for r in no_comp[:5]:
            w(f"  line={r.line_no}  saved=0  tokens={r.estimated_input_tokens:,}  message_count={r.message_count}")
    else:
        w("  (无)")
    w("")

    # --- 时间趋势 ---
    hourly: Dict[str, list[MergedRequest]] = defaultdict(list)
    for r in with_comp:
        if r.timestamp:
            hourly[hour_bucket(r.timestamp)].append(r)

    if hourly:
        w("--- 时间趋势 (按小时) ---")
        for hour in sorted(hourly.keys()):
            reqs = hourly[hour]
            avg_s = sum(r.bytes_saved_total for r in reqs) // len(reqs)
            ctx_reqs = [r for r in reqs if r.context_usage_percentage is not None]
            avg_ctx = sum(r.context_usage_percentage for r in ctx_reqs) / len(ctx_reqs) if ctx_reqs else 0
            ctx_str = f"  avg_context_usage={avg_ctx:.1f}%" if ctx_reqs else ""
            w(f"  {hour}:  requests={len(reqs)}  avg_saved={avg_s:,}{ctx_str}")
        w("")

    return "\n".join(lines)


def generate_json_report(
    merged: list[MergedRequest],
    rejections: list[RejectionRecord],
    total_lines: int,
) -> str:
    """生成 JSON 格式的汇总报告。"""
    with_comp = [r for r in merged if r.has_compression]
    total_saved = sum(r.bytes_saved_total for r in with_comp)

    report = {
        "total_lines": total_lines,
        "matched_requests": len(merged),
        "with_compression": len(with_comp),
        "total_bytes_saved": total_saved,
        "avg_bytes_saved": total_saved // len(with_comp) if with_comp else 0,
        "layers": {
            "whitespace": sum(r.whitespace_bytes_saved for r in with_comp),
            "thinking": sum(r.thinking_bytes_saved for r in with_comp),
            "tool_result": sum(r.tool_result_bytes_saved for r in with_comp),
            "tool_use_input": sum(r.tool_use_input_bytes_saved for r in with_comp),
            "history": sum(r.history_bytes_saved for r in with_comp),
        },
        "rejections": len(rejections),
    }
    return json.dumps(report, indent=2, ensure_ascii=False)


def write_csv(merged: list[MergedRequest], path: str) -> None:
    """导出每条请求的明细为 CSV。"""
    fieldnames = [
        "line_no", "timestamp", "model", "max_tokens", "stream",
        "message_count", "estimated_input_tokens", "bytes_saved_total",
        "whitespace_bytes_saved", "thinking_bytes_saved",
        "tool_result_bytes_saved", "tool_use_input_bytes_saved",
        "history_turns_removed", "history_bytes_saved",
        "compression_rate", "context_usage_percentage", "actual_input_tokens",
    ]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in merged:
            row = asdict(r)
            row = {k: row[k] for k in fieldnames}
            writer.writerow(row)


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="分析上下文压缩管道表现",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "logfile", nargs="?", default="logs/docker.log",
        help="日志文件路径，使用 '-' 从 stdin 读取（默认: logs/docker.log）"
    )
    parser.add_argument("--top", type=int, default=5, help="高压缩请求 TOP-N（默认: 5）")
    parser.add_argument("--csv", metavar="FILE", help="导出每条请求的明细为 CSV")
    parser.add_argument("--json", action="store_true", help="JSON 格式输出汇总")
    parser.add_argument("--min-tokens", type=int, default=0, help="仅分析 estimated_input_tokens >= N 的请求")
    parser.add_argument("--model", metavar="PATTERN", help="按模型名过滤（正则）")
    args = parser.parse_args(argv)

    # 读取日志
    if args.logfile == "-":
        log_lines = sys.stdin.read().splitlines()
    else:
        try:
            with open(args.logfile, "r", encoding="utf-8", errors="replace") as f:
                log_lines = f.read().splitlines()
        except FileNotFoundError:
            print(f"ERROR: 日志文件不存在: {args.logfile}", file=sys.stderr)
            return 2

    # 解析
    merged, rejections, total_lines = parse_log(
        log_lines,
        min_tokens=args.min_tokens,
        model_pattern=args.model,
    )

    # 输出
    if args.json:
        print(generate_json_report(merged, rejections, total_lines))
    else:
        print(generate_report(merged, rejections, total_lines, top_n=args.top))

    # CSV 导出
    if args.csv:
        write_csv(merged, args.csv)
        print(f"CSV 已导出: {args.csv}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
