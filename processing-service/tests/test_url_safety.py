import ipaddress
import socket

import pytest

from app.core.exceptions import ServiceError
from app.extractors import url_safety
from app.extractors.url_safety import InvalidUrlError, UnsafeUrlError, check_url, is_public_ip


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/article",
        "http://news.example.org/2025/01/story?id=4",
        "https://EXAMPLE.com:443/path",
        "http://example.com:80/",
        "https://bücher.example/artikel",  # IDN
        "https://93.184.216.34/page",  # public IP literal
    ],
)
def test_accepts_public_http_urls(url):
    checked = check_url(url)
    assert checked.scheme in ("http", "https")
    assert checked.hostname == checked.hostname.lower()


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "not a url",
        "ftp://example.com/file",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
        "gopher://example.com",
        "//example.com/path",
        "https://",
        "https://exa mple.com/",
    ],
)
def test_rejects_invalid_or_unsupported_urls(url):
    with pytest.raises((InvalidUrlError, UnsafeUrlError)):
        check_url(url)


def test_rejects_overlong_urls():
    with pytest.raises(InvalidUrlError):
        check_url("https://example.com/" + "a" * 2100)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/",
        "http://LOCALHOST:80/admin",
        "http://app.localhost/",
        "http://printer.local/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://service.internal/",
        "http://redis/",  # single-label internal name
        "http://127.0.0.1/",
        "http://127.1/",  # shorthand loopback
        "http://2130706433/",  # decimal loopback
        "http://0x7f000001/",  # hex loopback
        "http://0.0.0.0/",
        "http://10.0.0.5/",
        "http://172.16.3.4/",
        "http://192.168.1.1/",
        "http://100.64.0.1/",  # carrier-grade NAT
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://[::1]/",
        "http://[fd00::1]/",  # IPv6 ULA
        "http://[fe80::1]/",  # IPv6 link-local
        "http://[::ffff:127.0.0.1]/",  # IPv4-mapped loopback
        "http://[::ffff:169.254.169.254]/",
        "http://[2002:7f00:1::]/",  # 6to4 wrapping 127.0.0.1
        "http://224.0.0.1/",  # multicast
        "https://user:pass@example.com/",  # embedded credentials
        "https://example.com:8080/",  # non-standard port
        "http://example.com:22/",
        "https://example.com:6379/",
    ],
)
def test_rejects_unsafe_destinations(url):
    with pytest.raises(UnsafeUrlError):
        check_url(url)


@pytest.mark.parametrize(
    "ip, expected",
    [
        ("93.184.216.34", True),
        ("2606:4700::1111", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("169.254.169.254", False),
        ("::1", False),
        ("::ffff:10.0.0.1", False),
        ("fc00::1", False),
        ("192.0.2.1", False),  # documentation range
        ("240.0.0.1", False),  # reserved
    ],
)
def test_is_public_ip(ip, expected):
    assert is_public_ip(ipaddress.ip_address(ip)) is expected


async def _resolve(addresses):
    async def fake(_host, _port):
        return addresses

    return fake


@pytest.mark.anyio
async def test_dns_resolution_must_be_public(monkeypatch):
    monkeypatch.setattr(url_safety, "resolver", await _resolve(["93.184.216.34"]))
    ip = await url_safety.resolve_public_ip(check_url("https://example.com/a"))
    assert str(ip) == "93.184.216.34"


@pytest.mark.anyio
@pytest.mark.parametrize("addresses", [["10.0.0.7"], ["93.184.216.34", "127.0.0.1"], ["169.254.169.254"], ["::1"]])
async def test_dns_rebinding_to_private_addresses_is_blocked(monkeypatch, addresses):
    """A public-looking hostname that resolves (even partly) to an internal IP is rejected."""
    monkeypatch.setattr(url_safety, "resolver", await _resolve(addresses))
    with pytest.raises(UnsafeUrlError):
        await url_safety.resolve_public_ip(check_url("https://innocent.example.com/"))


@pytest.mark.anyio
async def test_unresolvable_host_is_a_non_retryable_error(monkeypatch):
    async def fail(_host, _port):
        raise socket.gaierror("Name or service not known")

    monkeypatch.setattr(url_safety, "resolver", fail)
    with pytest.raises(ServiceError) as info:
        await url_safety.resolve_public_ip(check_url("https://does-not-exist.example.com/"))
    assert info.value.code == "ARTICLE_UNREACHABLE"
    assert info.value.retryable is False
