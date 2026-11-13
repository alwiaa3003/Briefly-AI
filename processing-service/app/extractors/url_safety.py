"""SSRF protection for outbound article fetches.

Every URL (the submitted one and every redirect target) goes through:

1. Syntax checks: http/https only, no embedded credentials, standard ports
   only, a bounded length, and no obviously internal hostnames.
2. DNS resolution. *Every* resolved address must be a public, globally
   routable unicast IP. Loopback, private (RFC 1918), CGNAT, link-local
   (including 169.254.169.254 cloud metadata), multicast, reserved, and IPv6
   ULA / IPv4-mapped / 6to4 / Teredo forms of those are rejected.
3. The fetcher then connects to the *validated IP* (not the hostname), so a
   second DNS lookup cannot be used to rebind to an internal address.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit

from app.core.exceptions import ServiceError

MAX_URL_LENGTH = 2048
ALLOWED_SCHEMES = {"http": 80, "https": 443}
DNS_TIMEOUT_SECONDS = 5.0

BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata",
    "metadata.google.internal",
    "instance-data",
}
BLOCKED_SUFFIXES = (
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".home.arpa",
    ".corp",
    ".private",
)

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class UnsafeUrlError(ServiceError):
    def __init__(self, message: str = "This URL cannot be fetched for security reasons.") -> None:
        super().__init__(422, "UNSAFE_URL", message, retryable=False)


class InvalidUrlError(ServiceError):
    def __init__(self, message: str = "Enter a valid http:// or https:// article URL.") -> None:
        super().__init__(422, "INVALID_URL", message, retryable=False)


@dataclass(frozen=True)
class CheckedUrl:
    url: str
    scheme: str
    hostname: str  # lowercase, IDNA-encoded, no brackets
    port: int
    parts: SplitResult


def _unwrap_embedded_ipv4(ip: IPAddress) -> IPAddress:
    """Returns the IPv4 address hidden inside IPv4-mapped, 6to4 or Teredo IPv6 addresses."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return ip.ipv4_mapped
        if ip.sixtofour is not None:
            return ip.sixtofour
        if ip.teredo is not None:
            return ip.teredo[1]
    return ip


def is_public_ip(ip: IPAddress) -> bool:
    candidates = {ip, _unwrap_embedded_ipv4(ip)}
    return all(c.is_global and not c.is_multicast and not c.is_reserved for c in candidates)


def _parse_ip_literal(hostname: str) -> IPAddress | None:
    try:
        return ipaddress.ip_address(hostname)
    except ValueError:
        pass
    # Legacy numeric forms that some resolvers accept: 2130706433, 0x7f000001, 0177.0.0.1, 127.1
    try:
        packed = socket.inet_aton(hostname)
    except (OSError, UnicodeEncodeError):
        return None
    return ipaddress.IPv4Address(packed)


def check_url(raw_url: str) -> CheckedUrl:
    """Validates URL syntax and hostname. Does not perform DNS resolution."""
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise InvalidUrlError()
    url = raw_url.strip()
    if len(url) > MAX_URL_LENGTH:
        raise InvalidUrlError("The URL is too long.")
    if any(ord(ch) < 0x20 or ch in " \\" for ch in url):
        raise InvalidUrlError()

    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise InvalidUrlError() from exc

    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise InvalidUrlError("Only http:// and https:// links are supported.")
    if parts.username is not None or parts.password is not None:
        raise UnsafeUrlError("URLs containing usernames or passwords are not allowed.")
    if not parts.hostname:
        raise InvalidUrlError()

    default_port = ALLOWED_SCHEMES[scheme]
    effective_port = port if port is not None else default_port
    if effective_port not in (80, 443):
        raise UnsafeUrlError("Only standard web ports (80 and 443) are allowed.")

    try:
        hostname = parts.hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise InvalidUrlError() from exc
    if not hostname:
        raise InvalidUrlError()

    if hostname in BLOCKED_HOSTNAMES or hostname.endswith(BLOCKED_SUFFIXES):
        raise UnsafeUrlError("Links to local or internal hosts are not allowed.")

    literal = _parse_ip_literal(hostname)
    if literal is not None and not is_public_ip(literal):
        raise UnsafeUrlError("Links to private or internal network addresses are not allowed.")
    if literal is None and "." not in hostname:
        # Single-label names (e.g. "intranet", "redis") only resolve on internal networks.
        raise UnsafeUrlError("Links to local or internal hosts are not allowed.")

    return CheckedUrl(url=url, scheme=scheme, hostname=hostname, port=effective_port, parts=parts)


async def _system_resolve(hostname: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


# Replaced in tests.
resolver = _system_resolve


async def resolve_public_ip(checked: CheckedUrl) -> IPAddress:
    """Resolves the hostname and returns one address, after verifying *all* of them are public."""
    literal = _parse_ip_literal(checked.hostname)
    if literal is not None:
        return literal

    try:
        raw_addresses = await asyncio.wait_for(resolver(checked.hostname, checked.port), DNS_TIMEOUT_SECONDS)
    except (socket.gaierror, UnicodeError) as exc:
        raise ServiceError(
            422, "ARTICLE_UNREACHABLE", "The website's address could not be found. Check the link.", retryable=False
        ) from exc
    except (TimeoutError, OSError) as exc:
        raise ServiceError(
            504, "ARTICLE_UNREACHABLE", "The website could not be reached. Please try again later.", retryable=True
        ) from exc

    addresses: list[IPAddress] = []
    for raw in raw_addresses:
        try:
            addresses.append(ipaddress.ip_address(raw.split("%", 1)[0]))
        except ValueError:
            continue
    if not addresses:
        raise ServiceError(422, "ARTICLE_UNREACHABLE", "The website's address could not be found.", retryable=False)
    if not all(is_public_ip(address) for address in addresses):
        raise UnsafeUrlError("This link resolves to a private or internal network address.")
    return addresses[0]
