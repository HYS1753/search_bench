"""기술적인 오류 원문을 사용자가 바로 이해하고 조치할 수 있는 한국어 안내로 바꾼다(원문은 괄호로 남긴다)."""

from __future__ import annotations

import re

_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"CERTIFICATE_VERIFY_FAILED|SSLError|certificate verify|SSL:", re.I),
     "보안 인증서를 확인하지 못했습니다. 사내 인증서를 쓰는 주소라면 설정의 ‘인증서 검사’를 끄세요."),
    (re.compile(r"Name or service not known|nodename nor servname|getaddrinfo|No address associated|Temporary failure in name resolution", re.I),
     "주소의 호스트 이름을 찾지 못했습니다. 주소에 오타가 없는지, 사내 DNS·VPN 이 필요한지 확인하세요."),
    (re.compile(r"ConnectTimeout|ReadTimeout|WriteTimeout|PoolTimeout|timed out|Timeout", re.I),
     "정해진 시간 안에 응답이 오지 않았습니다. 서버 상태를 확인하거나 설정에서 대기 시간을 늘리세요."),
    (re.compile(r"ConnectError|All connection attempts failed|Connection refused|APIConnectionError|Connection error|ECONNREFUSED|RemoteProtocolError", re.I),
     "서버에 연결하지 못했습니다. 주소(호스트·포트)가 맞는지, 서버가 켜져 있는지, 사내망·VPN 이 필요한지 확인하세요."),
    (re.compile(r"\b(401|403)\b|AuthenticationError|PermissionDenied|invalid[_ ]api[_ ]key|Unauthorized|Forbidden", re.I),
     "인증에 실패했습니다. API 키와 인증 방식(Bearer·헤더), 권한을 확인하세요."),
    (re.compile(r"\b404\b|NotFoundError|model_not_found|does not exist", re.I),
     "주소나 모델을 찾지 못했습니다. 경로·모델 ID 에 오타가 없는지 확인하세요."),
    (re.compile(r"\b429\b|RateLimit|rate limit|quota|RESOURCE_EXHAUSTED", re.I),
     "호출 한도를 넘었습니다. 잠시 후 다시 하거나 ‘동시에 처리할 개수’를 줄이세요."),
    (re.compile(r"\b5\d\d\b|InternalServerError|ServiceUnavailable|Bad Gateway", re.I),
     "상대 서버에서 오류가 났습니다. 잠시 후 다시 시도하고, 계속되면 그 서버 담당자에게 확인하세요."),
]


def explain(raw: str, *, prefix: str = "") -> str:
    """'안내 (원문: …)'. 이미 한국어 안내로 시작하면 그대로 둔다."""
    text = (raw or "").strip()
    if not text:
        return prefix.strip() or "알 수 없는 오류가 났습니다."
    if re.match(r"^[가-힣]", text) and "원문:" in text:
        return text
    for pat, msg in _RULES:
        if pat.search(text):
            return f"{prefix}{msg} (원문: {text[:300]})"
    return f"{prefix}{text[:500]}"
