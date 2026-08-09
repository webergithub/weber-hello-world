"""命令行入口：``python -m watchtower <命令>``。

常用：

    python -m watchtower init                     # 生成默认配置
    python -m watchtower discover                 # 局域网扫 ONVIF 摄像机
    python -m watchtower add-camera --platform ezviz --name 前院 \
        -o app_key=xxx -o app_secret=yyy -o device_serial=ABC123
    python -m watchtower cameras                  # 看各路状态
    python -m watchtower go2rtc-config > go2rtc.yaml
    python -m watchtower digest --day 2026-08-09  # 手工补一天的剪影
    python -m watchtower push-test --channel bark --target <key>
    python -m watchtower serve                    # 起服务
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict
from pathlib import Path

from .adapters import discover, get_adapter, list_platforms
from .config import DEFAULT_CONFIG_PATH, Settings, load_settings
from .db import Database
from .media.go2rtc import render_config
from .media.streams import StreamManager
from .models import Camera, Subscriber, new_id
from .push.dispatcher import Notifier


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


def _kv(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in pairs or []:
        key, sep, value = item.partition("=")
        if not sep:
            raise SystemExit(f"参数 -o 需要 key=value 形式，收到：{item!r}")
        out[key.strip()] = value.strip()
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser("watchtower", description="多平台监控聚合 · 人物分析 · 一日剪影")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("-c", "--config", default=None, help="配置文件路径")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="生成默认配置文件")
    sub.add_parser("platforms", help="列出支持的平台与必填参数")
    sub.add_parser("cameras", help="列出摄像头及在线状态")
    sub.add_parser("go2rtc-config", help="输出 go2rtc 引导配置到标准输出")

    p = sub.add_parser("discover", help="局域网 ONVIF 设备发现")
    p.add_argument("--timeout", type=float, default=4.0)

    p = sub.add_parser("add-camera", help="新增/更新一路摄像头")
    p.add_argument("--id", default=None)
    p.add_argument("--name", required=True)
    p.add_argument("--platform", required=True)
    p.add_argument("--zone", default="")
    p.add_argument("--no-analyze", action="store_true")
    p.add_argument("--no-record", action="store_true")
    p.add_argument("-o", "--option", action="append", metavar="k=v", help="平台参数，可重复")

    p = sub.add_parser("rm-camera", help="删除一路摄像头")
    p.add_argument("camera_id")

    p = sub.add_parser("digest", help="生成一日剪影")
    p.add_argument("--day", default=None, help="YYYY-MM-DD，默认今天")
    p.add_argument("--camera", default="", help="只做某一路，默认全部合成")

    p = sub.add_parser("push-test", help="测试推送通道")
    p.add_argument("--channel", required=True)
    p.add_argument("--target", required=True)

    p = sub.add_parser("sub-add", help="新增推送订阅")
    p.add_argument("--channel", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--label", default="")
    p.add_argument("--levels", default="event,digest")

    p = sub.add_parser("serve", help="启动 HTTP 服务")
    p.add_argument("--host", default=None)
    p.add_argument("--port", type=int, default=None)

    args = parser.parse_args(argv)
    _setup_logging(args.verbose)
    settings = load_settings(args.config)

    return _dispatch(args, settings)


def _dispatch(args: argparse.Namespace, settings: Settings) -> int:
    command = args.command

    if command == "init":
        path = Path(args.config) if args.config else DEFAULT_CONFIG_PATH
        if path.exists():
            print(f"配置已存在，未覆盖：{path}")
            return 0
        path.write_text(
            json.dumps(asdict(Settings()), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"已生成默认配置：{path}\n请至少设置 api_token 后再对公网暴露。")
        return 0

    if command == "platforms":
        for item in list_platforms():
            required = ", ".join(item["required_options"]) or "（无）"
            pullable = "可服务端拉流" if item["server_pullable"] else "不可服务端直接拉流"
            print(f"{item['platform']:<10} {item['display_name']}")
            print(f"           必填：{required}    {pullable}")
            if item.get("doc_url"):
                print(f"           文档：{item['doc_url']}")
        return 0

    if command == "discover":
        found = discover(timeout=args.timeout)
        if not found:
            print("没有发现 ONVIF 设备（确认在同一广播域，且设备已开启 ONVIF）")
            return 1
        for item in found:
            print(f"{item['address']:<16} {' '.join(item['xaddrs'])}")
        return 0

    settings.ensure_dirs()
    db = Database(settings.db_path)

    if command == "cameras":
        streams = StreamManager(db, settings)
        rows = streams.status()
        if not rows:
            print("还没有摄像头，用 add-camera 添加")
            return 0
        for row in rows:
            state = "在线" if row["online"] else ("停用" if not row["enabled"] else "离线")
            print(f"{row['id']:<20} {row['name']:<12} {row['platform']:<10} {state}")
            if row["error"]:
                print(f"    ✗ {row['error']}")
            elif row["note"]:
                print(f"    · {row['note']}")
        return 0

    if command == "add-camera":
        camera = Camera(
            id=args.id or new_id("cam"),
            name=args.name,
            platform=args.platform,
            options=_kv(args.option),
            zone=args.zone,
            analyze=not args.no_analyze,
            record=not args.no_record,
        )
        try:
            get_adapter(camera, db).check_options()
        except Exception as exc:
            print(f"参数校验失败：{exc}", file=sys.stderr)
            return 2
        db.upsert_camera(camera)
        streams = StreamManager(db, settings)
        source = streams.sync(camera, force=True)
        if source:
            print(f"已添加 {camera.id}（{source.protocol}）")
            if source.note:
                print(f"提示：{source.note}")
            return 0
        # 参数是好的（上面 check_options 过了），这里是解析或上线环节出的问题
        print(f"已入库，但未能上线：{streams.error_of(camera.id)}", file=sys.stderr)
        print("若提示连接被拒，多半是 go2rtc 还没启动，起来后执行 "
              f"`watchtower cameras` 或调用 /api/cameras/{camera.id}/sync 重试。", file=sys.stderr)
        return 1

    if command == "rm-camera":
        camera = db.get_camera(args.camera_id)
        if not camera:
            print("没有这路摄像头", file=sys.stderr)
            return 1
        StreamManager(db, settings).remove(camera)
        db.delete_camera(camera.id)
        print(f"已删除 {camera.id}")
        return 0

    if command == "go2rtc-config":
        streams = StreamManager(db, settings)
        mapping = {}
        for camera in db.list_cameras(only_enabled=True):
            try:
                source = streams.resolve(camera)
            except Exception as exc:
                print(f"# {camera.id} 解析失败：{exc}", file=sys.stderr)
                continue
            if source.protocol != "publish":
                mapping[camera.stream_name] = source.url
        print(render_config(mapping, settings.go2rtc), end="")
        return 0

    if command == "digest":
        from .digest.builder import DigestBuilder, today

        notifier = Notifier(db, settings)
        builder = DigestBuilder(db, settings, on_digest=notifier.on_digest)
        digest = builder.build(args.day or today(), args.camera)
        if not digest:
            print("剪影生成失败", file=sys.stderr)
            return 1
        print(f"{digest.day} 剪影：{digest.video_path or '(无成片)'}")
        print(digest.summary)
        return 0

    if command == "push-test":
        try:
            Notifier(db, settings).test(args.channel, args.target)
        except Exception as exc:
            print(f"推送失败：{exc}", file=sys.stderr)
            return 1
        print("已发送，请查收")
        return 0

    if command == "sub-add":
        sub_obj = Subscriber(
            id=new_id("sub"), channel=args.channel, target=args.target,
            label=args.label, levels=tuple(x for x in args.levels.split(",") if x),
        )
        db.upsert_subscriber(sub_obj)
        print(f"已添加订阅 {sub_obj.id}")
        return 0

    if command == "serve":
        import uvicorn

        from .api.app import create_app

        host = args.host or settings.api_host
        port = args.port or settings.api_port
        uvicorn.run(create_app(settings), host=host, port=port, log_level="info")
        return 0

    parser_error = f"未知命令 {command!r}"
    print(parser_error, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
