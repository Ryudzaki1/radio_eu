import os
import time

import paramiko


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
EU_HOST = os.environ["EU_HOST"]
EU_USER = os.environ.get("EU_USER", "root")
EU_PASS = os.environ["EU_PASS"]
PUBLIC_RADIO_URL = os.environ.get("PUBLIC_RADIO_URL", "http://111.88.144.171")
RADIO_DOMAIN = os.environ.get("RADIO_DOMAIN", "radio.ryudzaki.website")


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


def run(client, command, stdin_data=None, timeout=900, print_output=True):
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_data is not None:
        stdin.write(stdin_data)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out and print_output:
        print(out.encode("ascii", errors="replace").decode("ascii"))
    if err and print_output:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    if code:
        raise RuntimeError(f"remote command failed with code {code}: {command}")
    return out


def local_text(path):
    with open(os.path.join(ROOT, path), "r", encoding="utf-8") as handle:
        return handle.read()


def sudo_write(client, path, content):
    run(client, f"sudo -n tee {path} >/dev/null", stdin_data=content, timeout=120)


def write(client, path, content):
    run(client, f"tee {path} >/dev/null", stdin_data=content, timeout=120)


def configure_ru(client):
    print("=== RU private API and bot shutdown ===")
    caddyfile = f""":80 {{
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
}}

{RADIO_DOMAIN} {{
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
}}

http://10.77.0.2:18082 {{
    bind 10.77.0.2
    reverse_proxy 127.0.0.1:3000
}}
"""
    sudo_write(client, "/etc/caddy/Caddyfile", caddyfile)
    run(client, "\n".join([
        "set -euo pipefail",
        "sudo -n ufw allow in on wg0 to any port 18082 proto tcp || true",
        "sudo -n caddy validate --config /etc/caddy/Caddyfile",
        "sudo -n systemctl restart caddy",
        "sudo -n systemctl is-active caddy",
        "cd /opt/radio_ru",
        "sudo -n docker compose up -d --build ru",
        "for i in $(seq 1 40); do",
        "  status=$(sudo -n docker inspect -f '{{.State.Health.Status}}' radio-ru 2>/dev/null || true)",
        "  [ \"$status\" = healthy ] && break",
        "  sleep 2",
        "done",
        "curl -sS --max-time 10 -o /tmp/radio_state.json -w 'ru_private_api_http=%{http_code}\\n' http://10.77.0.2:18082/api/radio/state",
        "python3 - <<'PY'",
        "import json",
        "data=json.load(open('/tmp/radio_state.json', encoding='utf-8'))",
        "print('ru_private_api_mode=' + str(data.get('mode')))",
        "print('ru_private_api_track=' + str((data.get('track') or {}).get('title', ''))[:80])",
        "PY",
        "sudo -n docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
    ]), timeout=1800)


def read_ru_env(client):
    wanted = [
        "TELEGRAM_BOT_TOKEN",
        "LISTENER_API_TOKEN",
        "BOT_ALLOWED_TELEGRAM_IDS",
        "BOT_ALLOWED_USERNAMES",
        "BOT_ADMIN_TELEGRAM_IDS",
        "BOT_ADMIN_USERNAMES",
        "BOT_NOTIFY_CHAT_IDS",
    ]
    script = "\n".join([
        "set -euo pipefail",
        "python3 - <<'PY'",
        "import os",
        "wanted = " + repr(wanted),
        "values = {}",
        "for line in open('/opt/radio_ru/.env', encoding='utf-8-sig'):",
        "    line=line.strip()",
        "    if not line or line.startswith('#') or '=' not in line:",
        "        continue",
        "    key, value = line.split('=', 1)",
        "    if key in wanted:",
        "        values[key]=value",
        "for key in wanted:",
        "    print(f'{key}={values.get(key, \"\")}')",
        "PY",
    ])
    out = run(client, script, timeout=120, print_output=False)
    values = {}
    for line in out.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def configure_eu(client, values):
    print("=== EU bot ===")
    env_lines = [
        f"PUBLIC_RADIO_URL={PUBLIC_RADIO_URL}",
        "RADIO_INTERNAL_URL=http://10.77.0.2:18082",
        "TELEGRAM_API_BASE_URL=https://api.telegram.org",
    ]
    for key in [
        "TELEGRAM_BOT_TOKEN",
        "LISTENER_API_TOKEN",
        "BOT_ALLOWED_TELEGRAM_IDS",
        "BOT_ALLOWED_USERNAMES",
        "BOT_ADMIN_TELEGRAM_IDS",
        "BOT_ADMIN_USERNAMES",
        "BOT_NOTIFY_CHAT_IDS",
    ]:
        env_lines.append(f"{key}={values.get(key, '')}")
    env_text = "\n".join(env_lines) + "\n"

    write(client, "/opt/radio_europa/docker-compose.eu-bot.yml", local_text("docker-compose.eu-bot.yml"))
    write(client, "/opt/radio_europa/bot/bot.js", local_text("bot/bot.js"))
    run(client, "mkdir -p /opt/radio_europa/.eu-bot", timeout=120)
    run(client, "chmod 700 /opt/radio_europa/.eu-bot", timeout=120)
    write(client, "/opt/radio_europa/.env", env_text)
    run(client, "chmod 600 /opt/radio_europa/.env", timeout=120)

    run(client, "\n".join([
        "set -euo pipefail",
        "cd /opt/radio_europa",
        "curl -sS --max-time 10 -o /tmp/eu_radio_state.json -w 'eu_to_ru_radio_http=%{http_code}\\n' http://10.77.0.2:18082/api/radio/state",
        "python3 - <<'PY'",
        "import json",
        "data=json.load(open('/tmp/eu_radio_state.json', encoding='utf-8'))",
        "print('eu_to_ru_radio_mode=' + str(data.get('mode')))",
        "print('eu_to_ru_radio_track=' + str((data.get('track') or {}).get('title', ''))[:80])",
        "PY",
        "curl -sS --max-time 15 -o /tmp/telegram_getme_eu.json -w 'eu_telegram_getme_http=%{http_code}\\n' \"https://api.telegram.org/bot$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)/getMe\"",
        "python3 - <<'PY'",
        "import json",
        "data=json.load(open('/tmp/telegram_getme_eu.json', encoding='utf-8'))",
        "print('eu_telegram_getme_ok=' + str(data.get('ok')))",
        "print('eu_telegram_bot_username=' + str((data.get('result') or {}).get('username', '')))",
        "PY",
        "docker compose -f docker-compose.eu-bot.yml up -d --build --force-recreate",
        "docker exec radio-eu sh -lc 'rm -f /cache/config/bot-link.json' || true",
        "docker restart radio-eu >/dev/null",
    ]), timeout=1800)

    time.sleep(12)
    run(client, "\n".join([
        "set -euo pipefail",
        "cd /opt/radio_europa",
        "echo '--- containers'",
        "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
        "echo '--- bot link state'",
        "docker exec radio-eu sh -lc 'cat /cache/config/bot-link.json 2>/dev/null || true'",
        "echo '--- recent bot errors'",
        "docker logs --since 20s radio-eu 2>&1 | grep -Ei 'error|failed|timeout|conflict' || true",
    ]), timeout=240)


ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)
try:
    configure_ru(ru)
    env_values = read_ru_env(ru)
    configure_eu(eu, env_values)
finally:
    ru.close()
    eu.close()
