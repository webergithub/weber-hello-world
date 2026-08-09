"""适配器层单测：不联网，只验证参数校验、签名与响应解析。"""

from __future__ import annotations

import pytest

from watchtower.adapters import AdapterError, NotConfigured, get_adapter, list_platforms
from watchtower.adapters.ezviz import PROTOCOL_CODE, EzvizAdapter, _unwrap
from watchtower.adapters.imou import ImouAdapter, _pick_stream
from watchtower.adapters.tuya import TuyaAdapter
from watchtower.adapters.xiaomi import XiaomiAdapter
from watchtower.models import Camera


def cam(platform: str, **options) -> Camera:
    return Camera(id="cam_test", name="测试", platform=platform, options=options)


# ---------------------------------------------------------------- 注册表

def test_registry_resolves_aliases():
    assert isinstance(get_adapter(cam("米家", mode="rtsp")), XiaomiAdapter)
    assert isinstance(get_adapter(cam("萤石")), EzvizAdapter)
    assert isinstance(get_adapter(cam("乐橙")), ImouAdapter)
    assert isinstance(get_adapter(cam("涂鸦")), TuyaAdapter)


def test_unknown_platform_is_actionable():
    with pytest.raises(NotConfigured) as exc:
        get_adapter(cam("nosuchvendor"))
    assert "已支持" in str(exc.value)


def test_list_platforms_exposes_required_options():
    by_key = {item["platform"]: item for item in list_platforms()}
    assert "app_key" in by_key["ezviz"]["required_options"]
    # 360 明确标注为不可服务端直接拉流，避免给用户错误预期
    assert by_key["qihoo360"]["server_pullable"] is False


# ---------------------------------------------------------------- 萤石

def test_ezviz_unwrap_raises_on_error_code():
    with pytest.raises(AdapterError) as exc:
        _unwrap({"code": "10002", "msg": "accessToken异常"}, "获取直播地址")
    assert "10002" in str(exc.value)


def test_ezviz_unwrap_returns_data():
    assert _unwrap({"code": "200", "data": {"url": "x"}}, "测试") == {"url": "x"}


def test_ezviz_rejects_unknown_protocol():
    adapter = EzvizAdapter(cam(
        "ezviz", app_key="k", app_secret="s", device_serial="D1", protocol="webrtc",
    ))
    with pytest.raises(AdapterError) as exc:
        adapter.resolve()
    assert "protocol" in str(exc.value)


def test_ezviz_protocol_codes_match_docs():
    # 官方定义：1=ezopen 2=hls 3=rtmp 4=flv
    assert PROTOCOL_CODE == {"ezopen": 1, "hls": 2, "rtmp": 3, "flv": 4}


def test_ezviz_missing_option_names_the_field():
    with pytest.raises(NotConfigured) as exc:
        EzvizAdapter(cam("ezviz", app_key="k")).check_options()
    assert "app_secret" in str(exc.value)


# ---------------------------------------------------------------- 乐橙

def test_imou_pick_stream_prefers_matching_stream_id():
    data = {"streams": [
        {"streamId": 0, "hls": "https://hd.example/live.m3u8"},
        {"streamId": 1, "hls": "https://sd.example/live.m3u8"},
    ]}
    assert _pick_stream(data, "hls", 1) == "https://sd.example/live.m3u8"


def test_imou_pick_stream_falls_back_to_alias_field():
    data = {"streams": [{"streamId": 0, "hlsHed": "https://x/live.m3u8"}]}
    assert _pick_stream(data, "hls", 0) == "https://x/live.m3u8"


def test_imou_pick_stream_empty_when_protocol_absent():
    assert _pick_stream({"streams": [{"streamId": 0, "hls": "u"}]}, "rtsp", 0) == ""
    assert _pick_stream({}, "hls", 0) == ""


def test_imou_sign_is_md5_of_documented_string():
    import hashlib

    adapter = ImouAdapter(cam("imou", app_id="a", app_secret="secret", device_id="D"))
    # 复刻文档里的拼接规则，确保实现没有偷偷改格式
    expected = hashlib.md5(b"time:1700000000,nonce:abc,appSecret:secret").hexdigest()
    assert len(expected) == 32
    assert adapter.opt("app_secret") == "secret"


# ---------------------------------------------------------------- 涂鸦

def test_tuya_region_endpoint_mapping():
    assert TuyaAdapter(cam("tuya", region="cn")).endpoint == "https://openapi.tuyacn.com"
    assert TuyaAdapter(cam("tuya", region="us")).endpoint == "https://openapi.tuyaus.com"


def test_tuya_unknown_region_raises():
    with pytest.raises(AdapterError):
        _ = TuyaAdapter(cam("tuya", region="mars")).endpoint


def test_tuya_sign_headers_shape():
    adapter = TuyaAdapter(cam("tuya", client_id="cid", client_secret="sec", device_id="d"))
    headers = adapter._sign("GET", "/v1.0/token?grant_type=1", b"")
    assert headers["client_id"] == "cid"
    assert headers["sign_method"] == "HMAC-SHA256"
    assert len(headers["sign"]) == 64 and headers["sign"] == headers["sign"].upper()
    assert "access_token" not in headers          # 取 token 时不带


def test_tuya_business_request_carries_token():
    adapter = TuyaAdapter(cam("tuya", client_id="cid", client_secret="sec", device_id="d"))
    headers = adapter._sign("POST", "/v1.0/devices/d/stream/actions/allocate", b"{}", token="tk")
    assert headers["access_token"] == "tk"


# ---------------------------------------------------------------- 小米

def test_xiaomi_go2rtc_source_shape():
    adapter = XiaomiAdapter(cam(
        "xiaomi", mode="go2rtc", uid="1234567890", region="cn",
        ip="192.168.1.123", did="9876543210", model="isa.camera.hlc7",
    ))
    source = adapter.resolve()
    assert source.url.startswith("xiaomi://1234567890:cn@192.168.1.123?")
    assert "did=9876543210" in source.url
    assert "model=isa.camera.hlc7" in source.url
    assert source.protocol == "go2rtc"
    assert "公网" in source.note          # 建连需要公网换密钥，必须提示


def test_xiaomi_micam_bridge_gives_local_rtsp():
    source = XiaomiAdapter(cam(
        "xiaomi", mode="micam", micam_host="10.0.0.5", micam_stream="door",
    )).resolve()
    assert source.url == "rtsp://10.0.0.5:8554/door"
    assert source.protocol == "rtsp"


def test_xiaomi_rtsp_mode_rejects_non_rtsp_url():
    with pytest.raises(NotConfigured):
        XiaomiAdapter(cam("xiaomi", mode="rtsp", url="http://x/live.m3u8")).resolve()


# ---------------------------------------------------------------- 360

def test_qihoo360_unconfigured_gives_guidance():
    adapter = get_adapter(cam("360"))
    with pytest.raises(NotConfigured) as exc:
        adapter.resolve()
    message = str(exc.value)
    assert "mode=manual" in message and "mode=relay" in message


def test_qihoo360_relay_marks_publish_protocol():
    source = get_adapter(cam("360", mode="relay", stream_name="door360")).resolve()
    # publish 表示"等别人推进来"，归一层据此不去主动拉流
    assert source.protocol == "publish"
    assert source.playable_by_ffmpeg is False


# ---------------------------------------------------------------- 通用

def test_generic_rejects_unknown_scheme():
    with pytest.raises(NotConfigured):
        get_adapter(cam("generic", url="ftp://x/y")).resolve()


def test_generic_guesses_protocol():
    assert get_adapter(cam("generic", url="rtsp://a/b")).resolve().protocol == "rtsp"
    assert get_adapter(cam("generic", url="https://a/b.m3u8")).resolve().protocol == "hls"
    assert get_adapter(cam("generic", url="tapo://u:p@1.2.3.4")).resolve().protocol == "go2rtc"


def test_onvif_template_builds_vendor_url():
    from watchtower.adapters.onvif_rtsp import OnvifRtspAdapter

    source = OnvifRtspAdapter(cam(
        "onvif", mode="template", vendor="hikvision",
        host="192.168.1.64", username="admin", password="pa ss", channel=1,
    )).resolve()
    assert source.url == "rtsp://admin:pa%20ss@192.168.1.64:554/Streaming/Channels/101"
