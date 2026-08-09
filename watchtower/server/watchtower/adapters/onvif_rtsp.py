"""ONVIF / RTSP 适配器 —— 覆盖面最大的一类（海康、大华、宇视、TP-Link VIGI、雄迈等）。

三种用法，按"配得越少越好"排序：

``mode=onvif``（默认）
    只给 host + 账号密码，自动走 ONVIF Profile S：``GetProfiles`` → ``GetStreamUri``
    问设备要 RTSP 地址。厂商换型号也不用改配置。

``mode=template``
    知道厂商的地址规则时直接套模板，省掉一次 ONVIF 往返：
    ``rtsp://{user}:{password}@{host}:{port}{path}``

``mode=url``
    地址已知，原样用。

另外提供 :func:`discover` —— 标准库实现的 WS-Discovery 组播探测，
用来在局域网里"扫一遍有哪些摄像机"，不依赖任何第三方 ONVIF 库。
"""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Any
from xml.etree import ElementTree

from .. import http
from .base import AdapterError, CameraAdapter, NotConfigured, StreamSource

WSD_ADDR = "239.255.255.250"
WSD_PORT = 3702

# 各厂商常见的 ONVIF media 服务路径，逐个试
MEDIA_PATHS = (
    "/onvif/media_service",
    "/onvif/Media",
    "/onvif/media",
    "/onvif/device_service",
    "/onvif/services",
)

# 常见厂商的 RTSP 路径模板，mode=template 时可直接引用
VENDOR_PATHS = {
    "hikvision": "/Streaming/Channels/{channel}01",
    "dahua": "/cam/realmonitor?channel={channel}&subtype=0",
    "uniview": "/media/video{channel}",
    "tplink-vigi": "/stream1",
    "xm": "/user={user}&password={password}&channel={channel}&stream=0.sdp",
}


class OnvifRtspAdapter(CameraAdapter):
    platform = "onvif"
    display_name = "ONVIF / RTSP 通用（海康·大华·宇视·VIGI…）"
    required_options = ()
    doc_url = "https://www.onvif.org/profiles/profile-s/"

    def resolve(self) -> StreamSource:
        mode = str(self.opt("mode", "onvif")).lower()
        if mode == "url":
            url = str(self.opt("url", required=True)).strip()
            return StreamSource(url=url, protocol="rtsp")
        if mode == "template":
            return StreamSource(url=self._from_template(), protocol="rtsp")
        if mode == "onvif":
            return StreamSource(url=self._from_onvif(), protocol="rtsp", note="ONVIF GetStreamUri")
        raise NotConfigured(f"[onvif] 未知 mode={mode!r}，可选：onvif / template / url")

    # ---- 模板拼地址 ----

    def _from_template(self) -> str:
        host = self.opt("host", required=True)
        user = urllib.parse.quote(str(self.opt("username", "")), safe="")
        password = urllib.parse.quote(str(self.opt("password", "")), safe="")
        port = int(self.opt("rtsp_port", 554))
        channel = str(self.opt("channel", 1))

        path = self.opt("path")
        if not path:
            vendor = str(self.opt("vendor", "")).lower()
            if vendor not in VENDOR_PATHS:
                raise NotConfigured(
                    f"[onvif] mode=template 需要 path，或用已知 vendor："
                    f"{', '.join(VENDOR_PATHS)}"
                )
            path = VENDOR_PATHS[vendor]
        path = str(path).format(channel=channel, user=user, password=password)

        cred = f"{user}:{password}@" if user else ""
        return f"rtsp://{cred}{host}:{port}{path}"

    # ---- 问设备要地址 ----

    def _from_onvif(self) -> str:
        host = str(self.opt("host", required=True))
        port = int(self.opt("onvif_port", 80))
        username = str(self.opt("username", ""))
        password = str(self.opt("password", ""))
        wanted = self.opt("profile_token")

        last_error: Exception | None = None
        for path in ([str(self.opt("media_path"))] if self.opt("media_path") else MEDIA_PATHS):
            service = f"http://{host}:{port}{path}"
            try:
                profiles = _get_profiles(service, username, password)
                if not profiles:
                    continue
                token = wanted if wanted in profiles else profiles[0]
                uri = _get_stream_uri(service, username, password, token)
                if uri:
                    return _inject_credentials(uri, username, password)
            except Exception as exc:  # 某个候选路径不通就试下一个
                last_error = exc
        raise AdapterError(
            f"[onvif] {host}:{port} 没能通过 ONVIF 取到 RTSP 地址"
            + (f"（最后一次错误：{last_error}）" if last_error else "")
            + "；可改用 mode=template 或 mode=url"
        )


# ---------------------------------------------------------------- ONVIF SOAP

_SEC_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
_UTIL_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
_PWD_DIGEST = (
    "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest"
)
_B64 = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"


def _security_header(username: str, password: str) -> str:
    """WS-UsernameToken（PasswordDigest）。没有账号时返回空头。"""
    if not username:
        return ""
    nonce = os.urandom(16)
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    digest = base64.b64encode(
        hashlib.sha1(nonce + created.encode() + password.encode()).digest()
    ).decode()
    return (
        f'<Security xmlns="{_SEC_NS}"><UsernameToken>'
        f"<Username>{_esc(username)}</Username>"
        f'<Password Type="{_PWD_DIGEST}">{digest}</Password>'
        f'<Nonce EncodingType="{_B64}">{base64.b64encode(nonce).decode()}</Nonce>'
        f'<Created xmlns="{_UTIL_NS}">{created}</Created>'
        f"</UsernameToken></Security>"
    )


def _soap(service: str, username: str, password: str, body: str, timeout: float = 6.0) -> ElementTree.Element:
    envelope = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
        f"<s:Header>{_security_header(username, password)}</s:Header>"
        f"<s:Body>{body}</s:Body>"
        "</s:Envelope>"
    )
    raw = http.request(
        service,
        method="POST",
        data=envelope.encode("utf-8"),
        headers={"Content-Type": "application/soap+xml; charset=utf-8"},
        timeout=timeout,
    )
    return ElementTree.fromstring(raw)


def _get_profiles(service: str, username: str, password: str) -> list[str]:
    root = _soap(service, username, password,
                 '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>')
    return [
        el.attrib["token"]
        for el in _iter_local(root, "Profiles")
        if "token" in el.attrib
    ]


def _get_stream_uri(service: str, username: str, password: str, profile_token: str) -> str:
    body = (
        '<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">'
        "<StreamSetup>"
        '<Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>'
        '<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>'
        "</StreamSetup>"
        f"<ProfileToken>{_esc(profile_token)}</ProfileToken>"
        "</GetStreamUri>"
    )
    root = _soap(service, username, password, body)
    for el in _iter_local(root, "Uri"):
        if el.text and el.text.strip():
            return el.text.strip()
    return ""


def _iter_local(root: ElementTree.Element, local_name: str):
    """按 localname 匹配 —— 各家 ONVIF 实现的命名空间前缀不统一，硬编码 ns 会踩坑。"""
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == local_name:
            yield el


def _inject_credentials(uri: str, username: str, password: str) -> str:
    """很多设备返回的 RTSP 地址不带账号密码，得自己塞回去。"""
    if not username or "@" in uri.split("//", 1)[-1].split("/", 1)[0]:
        return uri
    scheme, _, rest = uri.partition("://")
    cred = f"{urllib.parse.quote(username, safe='')}:{urllib.parse.quote(password, safe='')}"
    return f"{scheme}://{cred}@{rest}"


def _esc(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))


# ---------------------------------------------------------------- WS-Discovery

PROBE = """<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:{msg_id}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
  </e:Body>
</e:Envelope>"""


def discover(timeout: float = 4.0) -> list[dict[str, Any]]:
    """局域网 ONVIF 设备发现（WS-Discovery 组播探测）。

    返回 ``[{"address": "...", "xaddrs": [...], "scopes": [...]}]``。
    没有任何第三方依赖 —— 纯 socket + 标准库 XML 解析。
    """
    message = PROBE.format(msg_id=uuid.uuid4()).encode("utf-8")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.settimeout(timeout)
    found: dict[str, dict[str, Any]] = {}
    try:
        sock.sendto(message, (WSD_ADDR, WSD_PORT))
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, addr = sock.recvfrom(65535)
            except (socket.timeout, OSError):
                break
            entry = _parse_probe_match(data)
            if entry:
                entry["address"] = addr[0]
                found[entry.get("uuid") or addr[0]] = entry
    finally:
        sock.close()
    return list(found.values())


def _parse_probe_match(data: bytes) -> dict[str, Any] | None:
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError:
        return None
    entry: dict[str, Any] = {"xaddrs": [], "scopes": [], "uuid": ""}
    for el in _iter_local(root, "XAddrs"):
        entry["xaddrs"] = (el.text or "").split()
    for el in _iter_local(root, "Scopes"):
        entry["scopes"] = (el.text or "").split()
    for el in _iter_local(root, "Address"):
        if el.text and el.text.startswith("urn:uuid:"):
            entry["uuid"] = el.text.strip()
    return entry if entry["xaddrs"] else None


__all__ = ["OnvifRtspAdapter", "discover", "VENDOR_PATHS"]
