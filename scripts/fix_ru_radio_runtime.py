import os

import paramiko


RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
DOMAIN = os.environ.get("RADIO_DOMAIN", "radio.ryudzaki.website")


def load_key(path):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except paramiko.SSHException:
            continue
    raise RuntimeError("Could not read SSH key")


script = f"""
set -euo pipefail
cd /opt/radio_ru
docker compose up -d --build ru ru-postgres

cat > /etc/caddy/Caddyfile <<'EOF'
:80 {{
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
}}

{DOMAIN} {{
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
}}
EOF
ufw allow 80/tcp || true
ufw allow 443/tcp || true
systemctl enable caddy
systemctl restart caddy

echo "---RU STATUS---"
systemctl is-active wg-quick@wg0
systemctl is-active caddy
docker ps --format 'table {{{{.Names}}}}\\t{{{{.Status}}}}\\t{{{{.Ports}}}}'
curl -I --max-time 10 http://127.0.0.1/ || true
curl -I --max-time 20 http://10.77.0.1:18080/v1/voices || true
wg show
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(RU_HOST, username=RU_USER, pkey=load_key(RU_KEY), look_for_keys=False, allow_agent=False)
try:
    stdin, stdout, stderr = client.exec_command("sudo -n bash -s", timeout=1800)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    code = stdout.channel.recv_exit_status()
    if code:
        raise SystemExit(code)
finally:
    client.close()
