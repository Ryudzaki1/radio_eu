import os

import paramiko


RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
EU_HOST = os.environ["EU_HOST"]
EU_USER = os.environ.get("EU_USER", "root")
EU_PASS = os.environ["EU_PASS"]
DOMAIN = os.environ.get("RADIO_DOMAIN", "radio.ryudzaki.website")
WG_PORT = os.environ.get("WG_PORT", "51820")
WG_EU_IP = "10.77.0.1"
WG_RU_IP = "10.77.0.2"


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


def sudo_script(client, script, timeout=1200):
    stdin, stdout, stderr = client.exec_command("sudo -n bash -s", timeout=timeout)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    if code:
        raise RuntimeError(f"remote script failed with code {code}")
    return out


def get_pubkey(client, name):
    script = f"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null
apt-get install -y wireguard >/dev/null
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard
if [ ! -f /etc/wireguard/{name}_private.key ]; then
  umask 077
  wg genkey > /etc/wireguard/{name}_private.key
fi
cat /etc/wireguard/{name}_private.key | wg pubkey
"""
    out = sudo_script(client, script, timeout=900)
    return out.strip().splitlines()[-1]


def configure_eu(client, ru_pub):
    script = f"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y wireguard caddy ca-certificates curl

systemctl stop xray || true
systemctl disable xray || true
EU_PRIVATE="$(cat /etc/wireguard/eu_private.key)"
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = {WG_EU_IP}/24
ListenPort = {WG_PORT}
PrivateKey = $EU_PRIVATE

[Peer]
PublicKey = {ru_pub}
AllowedIPs = {WG_RU_IP}/32
EOF

ufw allow {WG_PORT}/udp || true
systemctl enable wg-quick@wg0
systemctl restart wg-quick@wg0

cat > /etc/caddy/Caddyfile <<'EOF'
http://{WG_EU_IP}:18080 {{
    bind {WG_EU_IP}
    reverse_proxy https://api.elevenlabs.io {{
        header_up Host api.elevenlabs.io
        header_up X-Forwarded-Host api.elevenlabs.io
    }}
}}
EOF
systemctl enable caddy
systemctl restart caddy

echo "---EU STATUS---"
systemctl is-active wg-quick@wg0
systemctl is-active caddy
wg show
ss -lntup | grep -E ':(18080|51820) ' || true
"""
    sudo_script(client, script)


def configure_ru(client, eu_pub):
    script = f"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg wireguard caddy

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${{VERSION_CODENAME}} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

RU_PRIVATE="$(cat /etc/wireguard/ru_private.key)"
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = {WG_RU_IP}/24
PrivateKey = $RU_PRIVATE

[Peer]
PublicKey = {eu_pub}
Endpoint = {EU_HOST}:{WG_PORT}
AllowedIPs = {WG_EU_IP}/32
PersistentKeepalive = 25
EOF

systemctl enable wg-quick@wg0
systemctl restart wg-quick@wg0

cd /opt/radio_ru
git pull --ff-only origin main
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
curl -I --max-time 20 http://{WG_EU_IP}:18080/v1/voices || true
wg show
"""
    sudo_script(client, script, timeout=1800)


ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)
try:
    print("=== KEYS ===")
    ru_pub = get_pubkey(ru, "ru")
    eu_pub = get_pubkey(eu, "eu")
    print(f"RU_PUB={ru_pub}")
    print(f"EU_PUB={eu_pub}")
    print("=== EU CONFIG ===")
    configure_eu(eu, ru_pub)
    print("=== RU CONFIG ===")
    configure_ru(ru, eu_pub)
finally:
    ru.close()
    eu.close()
