import os

import paramiko


RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
EU_HOST = os.environ["EU_HOST"]
EU_USER = os.environ.get("EU_USER", "root")
EU_PASS = os.environ["EU_PASS"]


def load_key(path):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except paramiko.SSHException:
            continue
    raise RuntimeError("Could not read SSH key")


def connect_key(host, user, key_path):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, pkey=load_key(key_path), look_for_keys=False, allow_agent=False)
    return client


def connect_password(host, user, password):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, look_for_keys=False, allow_agent=False)
    return client


def run(client, label, command, timeout=180):
    print(f"--- {label}")
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    print(f"exit={code}")
    return code


ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)
try:
    run(ru, "RU containers", "sudo -n docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'")
    run(ru, "RU admin unauth", "curl -sS -I --max-time 10 http://127.0.0.1/admin.html | head -5")
    run(ru, "RU admin auth", "\n".join([
        "set -euo pipefail",
        "cd /opt/radio_ru",
        "AUTH=$(python3 - <<'PY'",
        "import base64",
        "vals={}",
        "for line in open('.env', encoding='utf-8-sig'):",
        "    if '=' in line:",
        "        k,v=line.rstrip('\\n').split('=',1)",
        "        vals[k]=v",
        "raw=(vals.get('ADMIN_USERNAME','admin')+':'+vals.get('ADMIN_PASSWORD','')).encode()",
        "print(base64.b64encode(raw).decode())",
        "PY",
        ")",
        "curl -sS -I --max-time 10 -H \"Authorization: Basic $AUTH\" http://127.0.0.1/admin.html | head -5",
    ]))
    run(ru, "RU public stream", "curl -sS --max-time 8 -o /tmp/public-stream.bin -w 'stream_http=%{http_code} stream_size=%{size_download} stream_type=%{content_type}\\n' http://127.0.0.1/stream || true")
    run(eu, "EU containers", "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'")
    run(eu, "EU to RU listener API", "\n".join([
        "set -euo pipefail",
        "cd /opt/radio_europa",
        "TOKEN=$(grep '^LISTENER_API_TOKEN=' .env | cut -d= -f2-)",
        "curl -sS --max-time 10 -o /tmp/listener_status.json -w 'listener_http=%{http_code}\\n' -X POST -H 'Content-Type: application/json' -H \"X-Radio-Listener-Token: $TOKEN\" -d '{\"telegramId\":\"295767771\",\"username\":\"AlexBul94\"}' http://10.77.0.2:18082/api/listeners/status",
        "python3 - <<'PY'",
        "import json",
        "data=json.load(open('/tmp/listener_status.json', encoding='utf-8'))",
        "print('listener_ok=' + str(data.get('ok')))",
        "print('listener_reason=' + str(data.get('reason', '')))",
        "PY",
    ]))
    run(eu, "EU bot recent errors", "docker logs --since 60s radio-eu 2>&1 | grep -Ei 'error|failed|timeout|conflict' || true")
    run(eu, "EU bot link state", "docker exec radio-eu sh -lc 'cat /cache/config/bot-link.json 2>/dev/null || true'")
finally:
    ru.close()
    eu.close()
